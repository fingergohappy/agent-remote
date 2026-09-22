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
    } else if (b.type === 'toolCall' && typeof b.name === 'string') {
      tools.push(b.name);
    }
    // thinking / image：不投影到 Topic
  }
  if (texts.length) return { text: texts.join('\n'), kind: 'message' };
  if (tools.length) return { text: `[工具] ${tools.join(', ')}`, kind: 'tool' };
  return null;
}

/** `<ts>_<sessionId>.jsonl` → sessionId */
export function sessionIdFromPath(path: string): string | undefined {
  const m = /_([0-9a-fA-F-]{8,}).jsonl$/.exec(path.split(/[/\\]/).pop() ?? '');
  return m?.[1];
}

export function parsePiLines(lines: string[]): HistoryItem[] {
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

    const role = message.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const parsed = textFromContent(message.content);
    if (!parsed) continue;

    const stop = message.stopReason;
    items.push({
      role,
      text: parsed.text,
      ts: typeof rec.timestamp === 'string' ? rec.timestamp : undefined,
      kind: parsed.kind,
      terminal:
        role === 'assistant' && stop !== 'toolUse' && stop !== 'pending' ? true : undefined,
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
  const peek = parsePiLines(peekLines);
  const idle = sessionLooksIdle(peek);

  if (read.fresh) {
    const since = ref.since;
    const messages = since
      ? peek.filter((i) => i.ts && i.ts >= since && i.kind !== 'tool')
      : [];
    return { nextCursor: read.cursor, messages, source: file, idle };
  }
  if (!read.lines.length) {
    return { nextCursor: read.cursor, messages: [], source: file, idle };
  }

  return { nextCursor: read.cursor, messages: parsePiLines(read.lines), source: file, idle };
}

export async function fetchPiHistory(
  ref: HistoryRef,
  opts: { limit: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<HistoryResult> {
  const file = resolveTranscript(ref, env);
  if (!file) return { items: [] };

  const lines = await readTailLines(file, Math.max(opts.limit * 8, 200));
  const items = parsePiLines(lines).filter((i) => i.kind !== 'tool');
  return { items: items.slice(-opts.limit), source: file };
}
