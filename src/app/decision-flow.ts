/** 按钮 callback → provider.resolveDecision → 唤醒阻塞的 hook（modules.md §4.10）。 */
import type { AppContext } from './context.ts';
import { logger } from '../infra/logger.ts';
import { getProvider } from '../providers/registry.ts';
import { t } from '../i18n.ts';
import { escapeHtml } from '../telegram/format.ts';

const log = logger('decision-flow');

export type DecisionOutcome =
  | { ok: true; note: string }
  | { ok: false; message: string };

export async function resolveDecision(
  ctx: AppContext,
  args: { correlationId: string; decisionId: string },
): Promise<DecisionOutcome> {
  const pending = ctx.broker.get(args.correlationId);
  if (!pending) {
    return { ok: false, message: t('decision-expired') };
  }
  if (pending.resolvedWith) {
    return { ok: false, message: t('decision-done') };
  }

  const provider = getProvider(pending.event.providerId);
  if (!provider?.resolveDecision) {
    return { ok: false, message: t('no-structured-decision', { provider: pending.event.providerId }) };
  }

  const result = await provider.resolveDecision(pending.event, args.decisionId);
  if (!result.ok) {
    return { ok: false, message: result.note ?? t('decision-failed') };
  }

  const settled = ctx.broker.settle(
    args.correlationId,
    args.decisionId,
    result.hookResponse ?? {},
    result.note,
  );
  if (!settled) {
    return { ok: false, message: t('decision-invalid') };
  }

  log.info('决策已下发', { correlationId: args.correlationId, decisionId: args.decisionId });

  // hook 被唤醒，agent 接着跑（deny 也一样 —— 它会换个做法或收尾）
  if (pending.chatId) ctx.typing?.start(pending.chatId, pending.threadId);

  // 编辑原消息，把按钮换成结果，避免重复点击
  if (pending.chatId && pending.messageId) {
    await ctx.egress
      .enqueue({
        chatId: pending.chatId,
        threadId: pending.threadId,
        editMessageId: pending.messageId,
        text: `🔐 <b>${result.note ?? t('decision-handled')}</b>\n<s>${escapeHtml(pending.event.summary ?? '')}</s>`,
        parseMode: 'HTML',
      })
      .catch((err) => log.warn('编辑决策消息失败', err));
  }

  return { ok: true, note: result.note ?? t('decision-handled') };
}
