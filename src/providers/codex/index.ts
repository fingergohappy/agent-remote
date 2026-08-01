/** Codex provider。 */
import type {
  AgentProvider,
  DecisionUiSpec,
  HistoryRef,
  HistoryResult,
  NormalizedEvent,
} from '../types.ts';
import { detectCodex } from './detect.ts';
import { normalizeCodex } from './normalize.ts';
import { fetchCodexHistory, pollCodexTranscript } from './history.ts';
import { t } from '../../i18n.ts';

/**
 * 阻塞 hook 的响应体。codex 的 hooks 引擎对 PermissionRequest 和 PreToolUse
 * 期望不同的形状（PermissionRequest 是 decision.behavior，PreToolUse 是
 * permissionDecision）—— 按事件名分别构造。
 */
function permissionResponse(
  event: NormalizedEvent,
  decision: 'allow' | 'deny',
  reason: string,
): unknown {
  const hook = (event.payload as { hook_event_name?: string } | undefined)?.hook_event_name;
  if (hook === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision:
          decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: reason },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  displayName: 'Codex',

  capabilities: {
    // hooks 引擎（v0.124+）的 PermissionRequest/PreToolUse 可结构化回 allow/deny。
    // 只装了遗留 notify 的实例不会送来 permission 事件，按钮自然不出现。
    semanticPermission: true,
    structuredQuestion: false,
    // ~/.codex/sessions/**/rollout-*.jsonl
    nativeTranscript: true,
    resumeSession: false,
    spawnFromBot: false,
  },

  detect: detectCodex,

  normalizeIngress(raw: unknown): NormalizedEvent | null {
    return normalizeCodex(raw);
  },

  buildDecisionUi(event: NormalizedEvent): DecisionUiSpec | null {
    if (event.type !== 'permission' || !event.blocking) return null;
    return {
      prompt: event.summary ? t('perm-prompt', { summary: event.summary }) : t('perm-prompt-bare'),
      buttons: [
        { id: 'allow', label: t('allow') },
        { id: 'deny', label: t('deny') },
      ],
    };
  },

  async resolveDecision(event: NormalizedEvent, decisionId: string) {
    if (decisionId === 'allow') {
      return {
        ok: true,
        hookResponse: permissionResponse(event, 'allow', t('approved-via-tg')),
        note: t('allowed'),
      };
    }
    if (decisionId === 'deny') {
      return {
        ok: true,
        hookResponse: permissionResponse(event, 'deny', t('denied-via-tg')),
        note: t('denied'),
      };
    }
    return { ok: false, note: t('unknown-decision', { id: decisionId }) };
  },

  /**
   * 超时不替用户拍板：返回空响应，hook 什么都不输出，
   * codex 退回本机 TUI 自己的权限框（与 Claude 同策略）。
   */
  decisionTimeoutResponse(): unknown {
    return {};
  },

  fetchHistory(ref: HistoryRef, opts: { limit: number }): Promise<HistoryResult> {
    return fetchCodexHistory(ref, opts);
  },

  pollNativeEnhancements(ref: HistoryRef, cursor: unknown) {
    return pollCodexTranscript(ref, cursor);
  },
};
