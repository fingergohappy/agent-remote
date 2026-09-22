/**
 * Pi 扩展 payload → NormalizedEvent。
 *
 * 字段是我们自己的扩展约定（pi 没有 Claude 那种 stdin hook），
 * 本文件是唯一允许认识这些字段名的地方。
 */
import type { NormalizedEvent } from '../types.ts';
import { firstLine, summarizeToolInput } from '../hook-summary.ts';
import { t } from '../../i18n.ts';

export type PiHookRaw = {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  reason?: string;
  tool_name?: string;
  tool_input?: unknown;
  /** 由 agent-remote 的 pi 扩展补充 */
  paneId?: string;
  correlationId?: string;
};

export function normalizePi(raw: unknown): NormalizedEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as PiHookRaw;
  const hook = r.hook_event_name;
  if (!hook) return null;

  const base = {
    providerId: 'pi',
    paneId: r.paneId,
    sessionId: r.session_id,
    cwd: r.cwd,
    transcriptPath: typeof r.transcript_path === 'string' ? r.transcript_path : undefined,
    ts: new Date().toISOString(),
    payload: raw,
  } satisfies Partial<NormalizedEvent> as Omit<NormalizedEvent, 'type'>;

  switch (hook) {
    case 'session_start':
      return { ...base, type: 'started', summary: t('sum-session-start') };

    case 'user_prompt':
      // 不产生消息，只用于会话索引更新与镜像 kick。
      return { ...base, type: 'output', silent: true, summary: t('sum-user-typed') };

    case 'tool_call': {
      const correlationId = r.correlationId;
      return {
        ...base,
        type: 'permission',
        blocking: Boolean(correlationId),
        correlationId,
        summary: summarizeToolInput(r.tool_name, r.tool_input),
      };
    }

    case 'session_compact':
      return { ...base, type: 'output', summary: t('sum-compact') };

    case 'agent_settled':
      return { ...base, type: 'completed', summary: t('sum-task-done') };

    case 'session_shutdown':
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
