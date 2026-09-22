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
import { clipToolResult, pickToolArg, toolResultText } from '../tool-summary.ts';

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
  opts: { strict?: boolean } = {},
): string | null {
  if (ref.transcriptPath && existsSync(ref.transcriptPath)) return ref.transcriptPath;

  const root = projectsRoot(env);
  if (ref.cwd) {
    const dir = join(root, encodeCwd(ref.cwd));
    if (ref.sessionId) {
      const exact = join(dir, `${ref.sessionId}.jsonl`);
      if (existsSync(exact)) return exact;
    }
    // strict（镜像用）不猜「目录里最新的」—— 同 cwd 多实例会拿到别人的会话
    if (!opts.strict) {
      const newest = newestJsonl(dir);
      if (newest) return newest;
    }
  }
  if (ref.sessionId) return findBySessionId(root, ref.sessionId);
  return null;
}

/**
 * `⏺ Bash(npm run check)` 括号里显示哪个入参 —— 照 Claude Code 屏幕上的选择抄。
 * 没登记的工具（含 MCP 的 `mcp__x__y`）退到「第一个非空字符串入参」。
 */
const TOOL_ARG_FIELD: Record<string, string> = {
  Bash: 'command',
  BashOutput: 'bash_id',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
  Glob: 'pattern',
  Grep: 'pattern',
  Task: 'description',
  Agent: 'description',
  WebFetch: 'url',
  WebSearch: 'query',
  Skill: 'skill',
  SlashCommand: 'command',
  KillShell: 'shell_id',
};

/** 工具行括号里那串，照 Claude Code 屏幕上的选择取字段 */
export function toolArg(name: string, input: unknown, cwd?: string): string | undefined {
  return pickToolArg(input, TOOL_ARG_FIELD[name], cwd);
}

/**
 * 一条 transcript 记录 → 屏幕上的若干行。
 * CLI 把 thinking / tool_use / tool_result 各占一行地摊开，这里同样一块一个 item，
 * 渲染层再决定怎么折叠。thinking 落盘时正文常被剥成空字符串（只剩 signature），
 * 那就只留一个「思考过了」的占位，跟 CLI 折叠态对齐。
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
  let sawThinking = false;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;

    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      // 连着的 text 块是同一段话被切开，合成一条
      const last = items[items.length - 1];
      if (last?.kind === 'message') last.text += `\n${b.text.trim()}`;
      else items.push({ role, text: b.text.trim(), kind: 'message' });
    } else if (b.type === 'thinking') {
      // 同一条记录里的多个 thinking 块合并成一行，别刷屏
      const t = typeof b.thinking === 'string' ? b.thinking.trim() : '';
      if (t) items.push({ role: 'assistant', text: t, kind: 'reasoning' });
      else if (!sawThinking) items.push({ role: 'assistant', text: '', kind: 'reasoning' });
      sawThinking = true;
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      items.push({
        role: 'assistant',
        text: b.name,
        kind: 'tool',
        tool: { name: b.name, arg: toolArg(b.name, b.input, cwd) },
      });
    } else if (b.type === 'tool_result') {
      const clipped = clipToolResult(toolResultText(b.content));
      const isError = b.is_error === true;
      if (clipped.text || isError) {
        items.push({
          role: 'tool',
          text: clipped.text || '(无输出)',
          kind: 'tool-result',
          isError: isError || undefined,
          moreLines: clipped.moreLines,
        });
      }
    }
    // image：没法投影到 Topic
  }

  return items; // 顺序照 content 数组 —— 那就是 CLI 屏幕上的先后
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

    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
    const cwd = typeof rec.cwd === 'string' ? rec.cwd : undefined;
    for (const item of itemsFromContent(message.content, type, cwd)) {
      items.push(ts ? { ...item, ts } : item);
    }
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
  // 镜像只信 hook 送来的事实（sessionId / transcriptPath）。只剩 cwd 时
  // 「目录里最新的 jsonl」可能属于同 cwd 的另一个实例 —— /history 可以容忍
  // （用户主动拉、带 source 标注），持续镜像不行：串线会把别人的对话灌进这个话题。
  // 绑定后第一个 hook 事件（SessionStart / UserPromptSubmit / Stop 任一）就会补上事实。
  if (!ref.sessionId && !ref.transcriptPath) return null;

  const file = resolveTranscript(ref, env, { strict: true });
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

  // 一条消息一行，取尾部若干行足够覆盖 limit 条可见消息（工具/思考会被滤掉）。
  const lines = await readTailLines(file, Math.max(opts.limit * 8, 200));
  // 补历史只留对话（design.md §4.3「tool 可折叠/省略」）：实时镜像照搬 CLI 的每一行，
  // 但 /history 的 limit 是「条」，工具行会把 30 条配额吃光，用户翻不到自己问了什么。
  const items = parseClaudeLines(lines).filter((i) => i.kind === 'message' || !i.kind);
  return { items: items.slice(-opts.limit), source: file };
}
