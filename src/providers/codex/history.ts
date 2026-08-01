/**
 * 读 Codex 原生 rollout（接手补历史，D12）。
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl
 *
 * 行类型：session_meta | event_msg | response_item | turn_context | …
 * 取 event_msg 里的 user_message / agent_message —— 比 response_item 干净：
 * 后者混着 developer 系统提示、reasoning 和 function_call。
 */
import { readdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HistoryItem, HistoryRef, HistoryResult } from '../types.ts';
import { readIncremental, readTailLines, type StreamCursor } from '../transcript-io.ts';

export function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), '.codex', 'sessions');
}

type RolloutFile = { path: string; mtime: number; sessionId: string };

/** 递归列出 rollout 文件（目录结构是 年/月/日）。 */
function listRollouts(root: string, maxFiles = 400): RolloutFile[] {
  const out: RolloutFile[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || out.length >= maxFiles) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 日期目录名可排序，倒序优先看最近的
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        walk(path, depth + 1);
      } else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        const m = /^rollout-.*?-([0-9a-fA-F-]{36})\.jsonl$/.exec(e.name);
        try {
          out.push({ path, mtime: statSync(path).mtimeMs, sessionId: m?.[1] ?? '' });
        } catch {
          /* 忽略 */
        }
      }
    }
  };

  walk(root, 0);
  return out;
}

/** rollout 头部的 session_meta 行，含 cwd 与 session_id。 */
async function metaOf(path: string): Promise<{ cwd?: string; sessionId?: string }> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead).toString('utf8');
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        if (rec.type === 'session_meta') {
          const p = rec.payload as Record<string, unknown> | undefined;
          return {
            cwd: typeof p?.cwd === 'string' ? p.cwd : undefined,
            sessionId: typeof p?.session_id === 'string' ? p.session_id : undefined,
          };
        }
      } catch {
        // 头部行可能被截断，继续
      }
    }
  } finally {
    await fh.close();
  }
  return {};
}

export async function resolveRollout(
  ref: HistoryRef,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const files = listRollouts(sessionsRoot(env));
  if (!files.length) return null;

  if (ref.sessionId) {
    const exact = files.find((f) => f.sessionId === ref.sessionId);
    if (exact) return exact.path;
  }

  if (ref.cwd) {
    // 同 cwd 可能有多个 session，取最近修改的那个（design.md 已标注这是启发式）
    const byRecent = [...files].sort((a, b) => b.mtime - a.mtime).slice(0, 40);
    for (const f of byRecent) {
      const meta = await metaOf(f.path);
      if (meta.cwd === ref.cwd) return f.path;
    }
  }

  return null;
}

export function parseCodexLines(lines: string[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type !== 'event_msg') continue;

    const payload = rec.payload as Record<string, unknown> | undefined;
    const kind = payload?.type;
    if (kind !== 'user_message' && kind !== 'agent_message') continue;

    const message = payload?.message;
    if (typeof message !== 'string' || !message.trim()) continue;

    items.push({
      role: kind === 'user_message' ? 'user' : 'assistant',
      text: message.trim(),
      ts: typeof rec.timestamp === 'string' ? rec.timestamp : undefined,
      kind: 'message',
    });
  }
  return items;
}

type CodexCursor = StreamCursor & {
  /** 连续多少轮没读到新内容 —— 攒够了就重扫，防止锁死在旧会话的文件上 */
  idle?: number;
};

/** 连续空转这么多轮后重扫 sessions 目录，看看是不是换了 rollout 文件 */
const IDLE_TICKS_BEFORE_RESCAN = 3;

/**
 * 增量镜像。codex 的 notify 只在一轮结束时响一次，中间的往来要看 rollout。
 * 解析 rollout 的代价比 Claude 高（噪声行多），所以缓存已解析出的文件路径。
 *
 * 但不能一锁到底：codex 里 /new 或重启都会换 rollout 文件，而 notify 事件里
 * 没有任何「换会话了」的信号 —— 一直盯旧文件就是永久失明。折中是连续几轮
 * 空转后重扫一次，发现更新的 rollout 就切过去（fresh 语义：从新文件末尾跟起）。
 */
export async function pollCodexTranscript(
  ref: HistoryRef,
  cursor: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ nextCursor: unknown; messages: HistoryItem[]; source?: string } | null> {
  const known = cursor as CodexCursor | undefined;
  const locked = known?.file;
  const file = locked ?? (await resolveRollout(ref, env));
  if (!file) return null;

  const read = await readIncremental(file, locked ? { file: locked, offset: known!.offset } : undefined);
  if (!read) return null;

  if (!read.fresh && read.lines.length) {
    return {
      nextCursor: { ...read.cursor, idle: 0 },
      messages: parseCodexLines(read.lines),
      source: file,
    };
  }

  const idle = (known?.idle ?? 0) + 1;
  if (locked && idle >= IDLE_TICKS_BEFORE_RESCAN) {
    const latest = await resolveRollout(ref, env);
    if (latest && latest !== locked) {
      const relocated = await readIncremental(latest, undefined);
      return {
        nextCursor: relocated
          ? { ...relocated.cursor, idle: 0 }
          : { file: latest, offset: 0, idle: 0 },
        messages: [],
        source: latest,
      };
    }
    return { nextCursor: { ...read.cursor, idle: 0 }, messages: [], source: file };
  }

  return { nextCursor: { ...read.cursor, idle }, messages: [], source: file };
}

export async function fetchCodexHistory(
  ref: HistoryRef,
  opts: { limit: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<HistoryResult> {
  const file = await resolveRollout(ref, env);
  if (!file) return { items: [] };

  // rollout 里 token_count 等噪声行很多，尾部要多读一些
  const lines = await readTailLines(file, Math.max(opts.limit * 30, 600));
  const items = parseCodexLines(lines);
  return { items: items.slice(-opts.limit), source: file };
}
