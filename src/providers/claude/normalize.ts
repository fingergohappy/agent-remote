/**
 * Claude Code hook payload → NormalizedEvent。
 *
 * hook 公共字段：session_id / transcript_path / cwd / hook_event_name。
 * 本文件是唯一允许认识这些字段名的地方（design.md §6.7 反模式）。
 */
import type { NormalizedEvent } from '../types.ts';
import { firstLine, summarizeToolInput } from '../hook-summary.ts';
import { t } from '../../i18n.ts';

export type ClaudeHookRaw = {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  message?: string;
  reason?: string;
  tool_name?: string;
  tool_input?: unknown;
  stop_hook_active?: boolean;
  /** 由 agent-remote 的 hook 脚本补充 */
  paneId?: string;
  correlationId?: string;
};

const PERMISSION_HINT = /permission|approve|allow|授权|权限/i;
const IDLE_HINT = /waiting for your input|idle|等待/i;

export function normalizeClaude(raw: unknown): NormalizedEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as ClaudeHookRaw;
  const hook = r.hook_event_name;
  if (!hook) return null;

  const base = {
    providerId: 'claude',
    paneId: r.paneId,
    sessionId: r.session_id,
    cwd: r.cwd,
    transcriptPath: r.transcript_path,
    ts: new Date().toISOString(),
    payload: raw,
  } satisfies Partial<NormalizedEvent> as Omit<NormalizedEvent, 'type'>;

  switch (hook) {
    case 'SessionStart':
      return { ...base, type: 'started', summary: t('sum-session-start') };

    case 'UserPromptSubmit':
      // 不产生消息，只用于会话索引更新与镜像 kick。
      return { ...base, type: 'output', silent: true, summary: t('sum-user-typed') };

    case 'Notification': {
      const msg = r.message ? firstLine(r.message) : '';
      if (msg && PERMISSION_HINT.test(msg)) {
        return { ...base, type: 'permission', summary: msg || t('sum-need-permission') };
      }
      if (!msg || IDLE_HINT.test(msg)) {
        return { ...base, type: 'waiting', summary: msg || t('sum-waiting') };
      }
      return { ...base, type: 'waiting', summary: msg };
    }

    case 'PreToolUse': {
      // 我们的 hook 只在需要阻塞授权时才把 PreToolUse 送进来（见 hooks/agent-remote-hook.sh）。
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
