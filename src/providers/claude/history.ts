/**
 * 读 Claude Code 原生 transcript（接手补历史，D12）。
 *   ~/.claude/projects/<cwd编码>/<sessionId>.jsonl
 * 定位顺序：hook 给的 transcript_path → cwd+sessionId → cwd 目录最新文件 → 全局搜 sessionId。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HistoryItem, HistoryRef, HistoryResult } from '../types.ts';
import { readIncremental, readTailLines, type StreamCursor } from '../transcript-io.ts';

export function projectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), '.claude', 'projects');
}

/** Claude 把 cwd 里所有非字母数字字符替换成 `-` 作为目录名。 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
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

/** 会话文件按 <sessionId>.jsonl 命名，跨 project 目录扫一遍作兜底。 */
function findBySessionId(root: string, sessionId: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveTranscript(
  ref: HistoryRef,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (ref.transcriptPath && existsSync(ref.transcriptPath)) return ref.transcriptPath;

  const root = projectsRoot(env);
  if (ref.cwd) {
    const dir = join(root, encodeCwd(ref.cwd));
    if (ref.sessionId) {
      const exact = join(dir, `${ref.sessionId}.jsonl`);
      if (existsSync(exact)) return exact;
    }
    const newest = newestJsonl(dir);
    if (newest) return newest;
  }
  if (ref.sessionId) return findBySessionId(root, ref.sessionId);
  return null;
}

function textFromContent(content: unknown): { text: string; kind: HistoryItem['kind'] } | null {
  if (typeof content === 'string') {
    const t = content.trim();
    return t ? { text: t, kind: 'message' } : null;
  }
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  const tools: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      texts.push(b.text.trim());
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      tools.push(b.name);
    }
    // thinking / tool_result / image：不投影到 Topic
  }
  if (texts.length) return { text: texts.join('\n'), kind: 'message' };
  if (tools.length) return { text: `[工具] ${tools.join(', ')}`, kind: 'tool' };
  return null;
}

export function parseClaudeLines(lines: string[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = rec.type;
    if (type !== 'user' && type !== 'assistant') continue;

    const message = rec.message as Record<string, unknown> | undefined;
    if (!message) continue;

    const parsed = textFromContent(message.content);
    if (!parsed) continue;

    items.push({
      role: type === 'user' ? 'user' : 'assistant',
      text: parsed.text,
      ts: typeof rec.timestamp === 'string' ? rec.timestamp : undefined,
      kind: parsed.kind,
    });
  }
  return items;
}

/**
 * 增量镜像：把 transcript 新写入的对话行喂给 core。
 *
 * Claude 的 Stop hook 只给 session_id / transcript_path，**不含回复正文** ——
 * 想在手机上看到 agent 说了什么，只能读它自己的 jsonl。
 */
export async function pollClaudeTranscript(
  ref: HistoryRef,
  cursor: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ nextCursor: unknown; messages: HistoryItem[]; source?: string } | null> {
  const file = resolveTranscript(ref, env);
  if (!file) return null;

  const read = await readIncremental(file, cursor as StreamCursor | undefined);
  if (!read) return null;
  // fresh：刚接上这个文件，只记位置不回放
  if (read.fresh || !read.lines.length) {
    return { nextCursor: read.cursor, messages: [], source: file };
  }

  return { nextCursor: read.cursor, messages: parseClaudeLines(read.lines), source: file };
}

export async function fetchClaudeHistory(
  ref: HistoryRef,
  opts: { limit: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<HistoryResult> {
  const file = resolveTranscript(ref, env);
  if (!file) return { items: [] };

  // 一条消息一行，取尾部若干行足够覆盖 limit 条可见消息（tool/thinking 会被滤掉）。
  const lines = await readTailLines(file, Math.max(opts.limit * 8, 200));
  // 工具调用不投影到 Topic（design.md §4.3「tool 可折叠/省略」）：
  // 否则 30 条配额会被 [工具] Bash 这类行吃掉大半，用户翻不到自己问了什么。
  const items = parseClaudeLines(lines).filter((i) => i.kind !== 'tool');
  return { items: items.slice(-opts.limit), source: file };
}
