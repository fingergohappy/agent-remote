/**
 * Codex payload → NormalizedEvent。两条通路并存：
 *
 * 1) hooks 引擎（codex v0.124+ 稳定）：payload 与 Claude hook 同形 ——
 *    hook_event_name / session_id / cwd / tool_name / tool_input，从 stdin 进。
 *    PermissionRequest / PreToolUse 可阻塞并结构化回 allow/deny（见 index.ts）。
 *
 * 2) 遗留 notify = [...]：codex 以单个 JSON 字符串作为最后一个参数调用该程序，
 *    只有 agent-turn-complete 一种事件（实测 0.146.0）。留着不删 —— 老配置
 *    不迁移也能继续收「完成」通知。
 */
import type { NormalizedEvent } from '../types.ts';
import { firstLine, summarizeToolInput } from '../hook-summary.ts';
import { t } from '../../i18n.ts';

export type CodexNotifyRaw = {
  type?: string;
  'turn-id'?: string;
  'input-messages'?: unknown;
  'last-assistant-message'?: unknown;
  /** 由 agent-remote 的 hook 脚本补充 */
  paneId?: string;
  cwd?: string;
  sessionId?: string;
};

export type CodexHookRaw = {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  reason?: string;
  tool_name?: string;
  tool_input?: unknown;
  /** 由 agent-remote 的 hook 脚本补充 */
  paneId?: string;
  correlationId?: string;
};

function clip(s: string, max = 600): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function normalizeCodexHook(r: CodexHookRaw, raw: unknown): NormalizedEvent | null {
  const hook = r.hook_event_name;
  if (!hook) return null;

  const base = {
    providerId: 'codex',
    paneId: r.paneId,
    sessionId: r.session_id,
    cwd: r.cwd,
    transcriptPath: typeof r.transcript_path === 'string' ? r.transcript_path : undefined,
    ts: new Date().toISOString(),
    payload: raw,
  } satisfies Partial<NormalizedEvent> as Omit<NormalizedEvent, 'type'>;

  switch (hook) {
    case 'SessionStart':
      return { ...base, type: 'started', summary: t('sum-session-start') };

    case 'UserPromptSubmit':
      // 不产生消息，只用于会话索引更新与镜像 kick（与 Claude 同约定）。
      return { ...base, type: 'output', silent: true, summary: t('sum-user-typed') };

    case 'PermissionRequest':
    case 'PreToolUse': {
      // 我们的 hook 只在需要阻塞授权时才带 correlationId（--blocking）。
      const correlationId = r.correlationId;
      return {
        ...base,
        type: 'permission',
        blocking: Boolean(correlationId),
        correlationId,
        summary: summarizeToolInput(r.tool_name, r.tool_input),
      };
    }

    case 'PostToolUse':
      return {
        ...base,
        type: 'output',
        summary: summarizeToolInput(r.tool_name, r.tool_input),
      };

    case 'Stop':
      return { ...base, type: 'completed', summary: t('sum-task-done') };

    case 'SubagentStop':
      return { ...base, type: 'output', summary: t('sum-subtask-done') };

    case 'PreCompact':
      return { ...base, type: 'output', summary: t('sum-compact') };

    case 'SessionEnd':
      return {
        ...base,
        type: 'ended',
        summary: r.reason
          ? t('sum-session-end-reason', { reason: firstLine(r.reason, 80) })
          : t('sum-session-end'),
      };

    default:
      return null;
  }
}

function normalizeCodexNotify(r: CodexNotifyRaw, raw: unknown): NormalizedEvent | null {
  const type = typeof r.type === 'string' ? r.type : '';
  if (!type) return null;

  const last = typeof r['last-assistant-message'] === 'string' ? r['last-assistant-message'] : '';

  const base = {
    providerId: 'codex',
    paneId: r.paneId,
    sessionId: r.sessionId,
    cwd: r.cwd,
    ts: new Date().toISOString(),
    payload: raw,
  } satisfies Partial<NormalizedEvent> as Omit<NormalizedEvent, 'type'>;

  switch (type) {
    case 'agent-turn-complete':
      return {
        ...base,
        type: 'completed',
        correlationId: r['turn-id'],
        summary: last ? clip(last) : t('sum-task-done'),
      };

    // 前向兼容：codex 若新增事件类型，先按语义粗分，不认识就不产事件。
    case 'agent-turn-failed':
    case 'turn-failed':
      return { ...base, type: 'failed', summary: last ? clip(last) : t('sum-task-failed') };

    case 'agent-turn-aborted':
    case 'turn-aborted':
      return { ...base, type: 'ended', summary: t('sum-task-aborted') };

    default:
      return null;
  }
}

export function normalizeCodex(raw: unknown): NormalizedEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as CodexHookRaw & CodexNotifyRaw;
  if (r.hook_event_name) return normalizeCodexHook(r, raw);
  return normalizeCodexNotify(r, raw);
}
