/** Codex provider。 */
import type { AgentProvider, HistoryRef, HistoryResult, NormalizedEvent } from '../types.ts';
import { detectCodex } from './detect.ts';
import { normalizeCodex } from './normalize.ts';
import { fetchCodexHistory, pollCodexTranscript } from './history.ts';

export const codexProvider: AgentProvider = {
  id: 'codex',
  displayName: 'Codex',

  capabilities: {
    // codex 的 notify 通路是单向的，没有权限/提问回调 —— 不显示假按钮（design.md §6.7）
    semanticPermission: false,
    structuredQuestion: false,
    // ~/.codex/sessions/**/rollout-*.jsonl
    nativeTranscript: true,
    resumeSession: false,
    spawnFromBot: false,
    // 没有等价于 UserPromptSubmit 的实时活跃信号
  },

  detect: detectCodex,

  normalizeIngress(raw: unknown): NormalizedEvent | null {
    return normalizeCodex(raw);
  },

  fetchHistory(ref: HistoryRef, opts: { limit: number }): Promise<HistoryResult> {
    return fetchCodexHistory(ref, opts);
  },

  pollNativeEnhancements(ref: HistoryRef, cursor: unknown) {
    return pollCodexTranscript(ref, cursor);
  },
};
