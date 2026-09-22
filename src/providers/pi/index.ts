/** Pi provider。 */
import type {
  AgentProvider,
  DecisionUiSpec,
  HistoryRef,
  HistoryResult,
  NormalizedEvent,
} from '../types.ts';
import { detectPi } from './detect.ts';
import { normalizePi } from './normalize.ts';
import { fetchPiHistory, pollPiTranscript, resolvePiSession } from './history.ts';
import { t } from '../../i18n.ts';

/**
 * 阻塞式 tool_call 的响应体。扩展读 hookResponse.block 决定是否拦下这次调用。
 * 空对象 = 不拦（超时或没拍板时退回本机继续跑）。
 */
function permissionResponse(decision: 'allow' | 'deny', reason: string): unknown {
  return decision === 'deny' ? { block: true, reason } : { block: false };
}

export const piProvider: AgentProvider = {
  id: 'pi',
  displayName: 'Pi',

  capabilities: {
    // 扩展的 tool_call 可结构化回 block / 放行。没开 PI_APPROVAL 时
    // 扩展根本不送 permission 事件，按钮自然不出现。
    semanticPermission: true,
    structuredQuestion: false,
    // ~/.pi/agent/sessions/--<cwd>--/*.jsonl
    nativeTranscript: true,
    resumeSession: false,
    spawnFromBot: false,
  },

  detect: detectPi,

  normalizeIngress(raw: unknown): NormalizedEvent | null {
    return normalizePi(raw);
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
   * 超时不替用户拍板：返回空响应，扩展不拦 tool_call，
   * pi 接着跑（本机没有第二道权限框）。
   */
  decisionTimeoutResponse(): unknown {
    return {};
  },

  fetchHistory(ref: HistoryRef, opts: { limit: number }): Promise<HistoryResult> {
    return fetchPiHistory(ref, opts);
  },

  pollNativeEnhancements(ref: HistoryRef, cursor: unknown) {
    return pollPiTranscript(ref, cursor);
  },

  resolveNativeSession(ref: HistoryRef) {
    return resolvePiSession(ref);
  },
};
