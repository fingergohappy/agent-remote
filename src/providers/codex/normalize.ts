/**
 * Codex notify payload → NormalizedEvent。
 *
 * Codex 的通知机制是 config.toml 里的 `notify = [...]`：codex 以单个 JSON 字符串
 * 作为最后一个参数调用该程序。实测 0.146.0 只发一种事件：
 *   { "type": "agent-turn-complete", "turn-id": …, "input-messages": [...], "last-assistant-message": … }
 * 因此 Codex 侧目前只有「完成」语义，没有权限/提问回调 —— capability 如实声明为 false。
 */
import type { NormalizedEvent } from '../types.ts';
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

function clip(s: string, max = 600): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function normalizeCodex(raw: unknown): NormalizedEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as CodexNotifyRaw;
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
