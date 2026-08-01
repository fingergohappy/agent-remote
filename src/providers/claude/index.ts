/** Claude Code provider。 */
import type {
  AgentProvider,
  DecisionUiSpec,
  HistoryRef,
  HistoryResult,
  NormalizedEvent,
} from '../types.ts';
import { detectClaude } from './detect.ts';
import { normalizeClaude } from './normalize.ts';
import { fetchClaudeHistory, pollClaudeTranscript } from './history.ts';
import { t } from '../../i18n.ts';

function permissionResponse(decision: 'allow' | 'deny', reason: string): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

export const claudeProvider: AgentProvider = {
  id: 'claude',
  displayName: 'Claude Code',

  capabilities: {
    // PreToolUse hook 能结构化返回 allow/deny，不用模拟 TUI 按键
    semanticPermission: true,
    // AskUserQuestion 的 updatedInput 回填未实现 —— 不假装（design.md §6.7）
    structuredQuestion: false,
    nativeTranscript: true,
    resumeSession: false,
    spawnFromBot: false,
  },

  detect: detectClaude,

  normalizeIngress(raw: unknown): NormalizedEvent | null {
    return normalizeClaude(raw);
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

  async resolveDecision(_event: NormalizedEvent, decisionId: string) {
    if (decisionId === 'allow') {
      return {
        ok: true,
        hookResponse: permissionResponse('allow', t('approved-via-tg')),
        note: t('allowed'),
      };
    }
    if (decisionId === 'deny') {
      return {
        ok: true,
        hookResponse: permissionResponse('deny', t('denied-via-tg')),
        note: t('denied'),
      };
    }
    return { ok: false, note: t('unknown-decision', { id: decisionId }) };
  },

  /**
   * 超时不替用户拍板：返回空响应，Claude 退回本机 TUI 自己的权限框。
   * （fail-open 到本地，而不是静默 allow 或 deny。）
   */
  decisionTimeoutResponse(): unknown {
    return {};
  },

  fetchHistory(ref: HistoryRef, opts: { limit: number }): Promise<HistoryResult> {
    return fetchClaudeHistory(ref, opts);
  },

  pollNativeEnhancements(ref: HistoryRef, cursor: unknown) {
    return pollClaudeTranscript(ref, cursor);
  },
};
