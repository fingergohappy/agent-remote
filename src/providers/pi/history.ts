/**
 * 读 Pi 原生 session jsonl（接手补历史，D12）。
 *   ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<sessionId>.jsonl
 *
 * cwd 编码：去掉前导 /，把 / \ : 换成 -，再前后加 `--`
 * （见 pi session-manager getDefaultSessionDirPath）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HistoryItem, HistoryRef, HistoryResult } from '../types.ts';
import { readIncremental, readTailLines, type StreamCursor } from '../transcript-io.ts';
import { clipToolResult, pickToolArg, toolResultText } from '../tool-summary.ts';

export function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), '.pi', 'agent', 'sessions');
}

/** `/home/u/proj` → `--home-u-proj--` */
export function encodeCwd(cwd: string): string {
  const trimmed = cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  return `--${trimmed}--`;
}

function newestJsonl(dir: string): string | null {
  let best: { path: string; mtime: number } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    try {
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    } catch {
      /* 忽略读不到的文件 */
    }
  }
  return best?.path ?? null;
}

function fileBySessionId(dir: string, sessionId: string): string | null {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  const suffix = `_${sessionId}.jsonl`;
  const hit = files.find((name) => name.endsWith(suffix));
  return hit ? join(dir, hit) : null;
}

/** 文件名是 `<ts>_<sessionId>.jsonl`；跨 project 目录扫一遍作兜底。 */
function findBySessionId(root: string, sessionId: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const hit = fileBySessionId(join(root, dir), sessionId);
    if (hit) return hit;
  }
  return null;
}

export function resolveTranscript(
  ref: HistoryRef,
  env: NodeJS.ProcessEnv = process.env,
  opts: { strict?: boolean } = {},
): string | null {
  if (ref.transcriptPath && existsSync(ref.transcriptPath)) return ref.transcriptPath;

  const root = sessionsRoot(env);
  if (ref.cwd) {
    const dir = join(root, encodeCwd(ref.cwd));
    if (ref.sessionId) {
      const exact = fileBySessionId(dir, ref.sessionId);
      if (exact) return exact;
    }
    if (!opts.strict) {
      const newest = newestJsonl(dir);
      if (newest) return newest;
    }
  }
  if (ref.sessionId) return findBySessionId(root, ref.sessionId);
  return null;
}

/** `⏺ bash(npm test)` 括号里取哪个入参。pi 的工具名是小写的 */
const TOOL_ARG_FIELD: Record<string, string> = {
  bash: 'command',
  read: 'path',
  write: 'path',
  edit: 'path',
  ls: 'path',
  ffgrep: 'pattern',
  grep: 'pattern',
  glob: 'pattern',
  webfetch: 'url',
  websearch: 'query',
  task: 'description',
};

/**
 * 一条 pi 记录 → 屏幕上的若干行（和 Claude 侧同构）。
 * pi 的 thinking 是明文落盘的，能原样投影；工具结果是另一条 role=toolResult 的记录。
 */
function itemsFromContent(
  content: unknown,
  role: 'user' | 'assistant',
  cwd?: string,
): HistoryItem[] {
  if (typeof content === 'string') {
    const t = content.trim();
    return t ? [{ role, text: t, kind: 'message' }] : [];
  }
  if (!Array.isArray(content)) return [];

  const items: HistoryItem[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;

    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      const last = items[items.length - 1];
      if (last?.kind === 'message') last.text += `\n${b.text.trim()}`;
      else items.push({ role, text: b.text.trim(), kind: 'message' });
    } else if (b.type === 'thinking') {
      const t = typeof b.thinking === 'string' ? b.thinking.trim() : '';
      items.push({ role: 'assistant', text: t, kind: 'reasoning' });
    } else if (b.type === 'toolCall' && typeof b.name === 'string') {
      items.push({
        role: 'assistant',
        text: b.name,
        kind: 'tool',
        tool: { name: b.name, arg: pickToolArg(b.arguments, TOOL_ARG_FIELD[b.name], cwd) },
      });
    }
    // image：没法投影到 Topic
  }
  return items; // 顺序照 content 数组 —— 那就是 pi 屏幕上的先后
}

/** role=toolResult 的记录 → 折叠的输出行 */
function toolResultItem(message: Record<string, unknown>): HistoryItem | null {
  const clipped = clipToolResult(toolResultText(message.content));
  const isError = message.isError === true;
  if (!clipped.text && !isError) return null;
  return {
    role: 'tool',
    text: clipped.text || '(无输出)',
    kind: 'tool-result',
    isError: isError || undefined,
    moreLines: clipped.moreLines,
  };
}

/** `<ts>_<sessionId>.jsonl` → sessionId */
export function sessionIdFromPath(path: string): string | undefined {
  const m = /_([0-9a-fA-F-]{8,}).jsonl$/.exec(path.split(/[/\\]/).pop() ?? '');
  return m?.[1];
}

export function parsePiLines(lines: string[], cwd?: string): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type !== 'message') continue;

    const message = rec.message as Record<string, unknown> | undefined;
    if (!message) continue;

    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
    const role = message.role;

    if (role === 'toolResult') {
      const item = toolResultItem(message);
      if (item) items.push(ts ? { ...item, ts } : item);
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;

    const produced = itemsFromContent(message.content, role, cwd);
    if (!produced.length) continue;

    // terminal 只标在这条记录的最后一行上 —— sessionLooksIdle 从后往前找的就是它
    const stop = message.stopReason;
    const terminal = role === 'assistant' && stop !== 'toolUse' && stop !== 'pending';
    produced.forEach((item, i) => {
      const last = i === produced.length - 1;
      items.push({
        ...item,
        ...(ts ? { ts } : {}),
        ...(last && terminal ? { terminal: true } : {}),
      });
    });
  }
  return items;
}

/** 从后往前看最后一轮：assistant 已收尾 → 空闲；最后是 user → 还在跑。 */
export function sessionLooksIdle(items: HistoryItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.role === 'assistant') return !!it.terminal;
    if (it.role === 'user') return false;
  }
  return true;
}

export async function resolvePiSession(
  ref: HistoryRef,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ sessionId?: string; transcriptPath?: string } | null> {
  const file = resolveTranscript(ref, env, { strict: false });
  if (!file) return null;
  return { transcriptPath: file, sessionId: sessionIdFromPath(file) ?? ref.sessionId };
}

export async function pollPiTranscript(
  ref: HistoryRef,
  cursor: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ nextCursor: unknown; messages: HistoryItem[]; source?: string; idle?: boolean } | null> {
  if (!ref.sessionId && !ref.transcriptPath) return null;

  const file = resolveTranscript(ref, env, { strict: true });
  if (!file) return null;

  const read = await readIncremental(file, cursor as StreamCursor | undefined);
  if (!read) return null;

  const peekLines = await readTailLines(file, read.fresh && ref.since ? 200 : 40);
  const peek = parsePiLines(peekLines, ref.cwd);
  const idle = sessionLooksIdle(peek);

  if (read.fresh) {
    const since = ref.since;
    const messages = since
      ? peek.filter((i) => i.ts && i.ts >= since && (i.kind === 'message' || !i.kind))
      : [];
    return { nextCursor: read.cursor, messages, source: file, idle };
  }
  if (!read.lines.length) {
    return { nextCursor: read.cursor, messages: [], source: file, idle };
  }

  return { nextCursor: read.cursor, messages: parsePiLines(read.lines, ref.cwd), source: file, idle };
}

export async function fetchPiHistory(
  ref: HistoryRef,
  opts: { limit: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<HistoryResult> {
  const file = resolveTranscript(ref, env);
  if (!file) return { items: [] };

  const lines = await readTailLines(file, Math.max(opts.limit * 8, 200));
  // 补历史只留对话（实时镜像才照搬每一行）：limit 是「条」，工具行会把配额吃光
  const items = parsePiLines(lines, ref.cwd).filter((i) => i.kind === 'message' || !i.kind);
  return { items: items.slice(-opts.limit), source: file };
}
