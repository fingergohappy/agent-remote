/**
 * 工具调用/结果在屏幕上的样子。
 *
 * 各家 transcript 的字段名不同（Claude `input`、Pi `arguments`），但摘要规则是一样的：
 * 括号里放主参数、压掉换行、路径相对 cwd，长输出截到预算内并记下还剩多少行 ——
 * 也就是 CLI 上 `⏺ Bash(npm test)` / `⎿ … +23 lines` 那两行。
 */

/** 摘要行在手机上只有一行；CLI 也按终端宽度截 */
const ARG_MAX = 140;
/** 工具结果进可展开引用块，超出就截（Telegram 单条 4096，还要留给别的行） */
const RESULT_MAX = 2000;

/**
 * 工具行括号里那串：优先取 field 指定的主参数，没有就退到第一个非空字符串入参
 * —— 后者兜住没登记的工具（MCP 的 `mcp__x__y`、各家自定义工具）。
 */
export function pickToolArg(
  input: unknown,
  field: string | undefined,
  cwd?: string,
): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;

  let value = field && typeof rec[field] === 'string' ? (rec[field] as string) : undefined;
  if (value === undefined) {
    value = Object.values(rec).find((v): v is string => typeof v === 'string' && !!v.trim());
  }
  if (!value?.trim()) return undefined;

  let s = value.trim().replace(/\s+/g, ' ');
  if (cwd && s.startsWith(`${cwd}/`)) s = s.slice(cwd.length + 1); // CLI 显示相对路径
  return s.length > ARG_MAX ? `${s.slice(0, ARG_MAX - 1)}…` : s;
}

/** 工具结果的 content：可能是字符串，也可能是 text 块数组 */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (b.type === 'image') texts.push('[图片]');
  }
  return texts.join('\n').trim();
}

/** 长输出截到预算内，剩下多少行记在 moreLines 上（CLI 的 `+23 lines`） */
export function clipToolResult(text: string): { text: string; moreLines?: number } {
  if (text.length <= RESULT_MAX) return { text };
  const head = text.slice(0, RESULT_MAX);
  const moreLines = text.slice(head.length).split('\n').length;
  return { text: head.replace(/\s+$/, ''), moreLines };
}
