/**
 * hook payload 的摘要工具，claude / codex 共用 —— 两家的 tool_name / tool_input
 * 字段同形（codex 的 hooks 引擎有意对齐了 Claude Code 的 payload 结构）。
 */

export function firstLine(s: string, max = 300): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

export function summarizeToolInput(toolName: string | undefined, input: unknown): string {
  const name = toolName || 'tool';
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'description']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) return `${name}: ${firstLine(v, 200)}`;
    }
  }
  return name;
}
