/** Topic 里的纯文本 → 对应 pane（modules.md §4.10 chat-flow）。不经任何 LLM。 */
import type { AppContext } from './context.ts';
import { forgetBinding } from './bind-flow.ts';
import { sendToBinding } from '../core/send.ts';
import { logger } from '../infra/logger.ts';
import { t } from '../i18n.ts';

const log = logger('chat-flow');

export type ChatOutcome =
  | { ok: true; paneId: string; acked: boolean }
  | { ok: false; reason: 'no_binding' | 'send_failed'; message: string };

export async function handleUserText(
  ctx: AppContext,
  args: { chatId: string; threadId: number; text: string },
): Promise<ChatOutcome> {
  const binding = ctx.store.getByThread(args.chatId, args.threadId);
  if (!binding) {
    return {
      ok: false,
      reason: 'no_binding',
      message: t('not-bound-pick'),
    };
  }

  const result = await sendToBinding(binding, args.text, {
    enterDelayMs: ctx.config.sendEnterDelayMs,
    bracketedPaste: ctx.config.sendBracketedPaste,
  });

  if (!result.ok) {
    // pane 没了就顺手清掉绑定，避免后续继续误投
    if (result.code === 'pane_dead' || result.code === 'fingerprint_mismatch') {
      forgetBinding(ctx, binding);
      log.info('发送时发现绑定失效，已清理', { paneId: binding.paneId, code: result.code });
      return {
        ok: false,
        reason: 'send_failed',
        message: t('auto-unbound', { err: result.error }),
      };
    }
    // agent 退了但 pane 还在：不解绑（多半是 Ctrl-C 后马上会重启），
    // 但消息绝不能发 —— 现在前台是 shell，发过去就是让 shell 执行它
    if (result.code === 'agent_gone') {
      log.info('前台已不是 agent，拒发', { paneId: binding.paneId });
      return {
        ok: false,
        reason: 'send_failed',
        message: `⚠️ ${result.error}\n消息未发送，agent 回来后再发即可（或 /unbind）。`,
      };
    }
    return { ok: false, reason: 'send_failed', message: `❌ 发送失败：${result.error}` };
  }

  // agent 会把这句话记进自己的 transcript，别让镜像再推回来
  ctx.echo.note(result.paneId, args.text);

  // 活交出去了，agent 开始跑 —— 话题里转「正在输入…」直到它停下来
  ctx.typing?.start(args.chatId, args.threadId || undefined);

  return { ok: true, paneId: result.paneId, acked: ctx.config.ackOnSend };
}
