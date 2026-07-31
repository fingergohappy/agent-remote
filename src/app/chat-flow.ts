/** Topic 里的纯文本 → 对应 pane（modules.md §4.10 chat-flow）。不经任何 LLM。 */
import type { AppContext } from './context.ts';
import { forgetBinding } from './bind-flow.ts';
import { sendToBinding } from '../core/send.ts';
import { logger } from '../infra/logger.ts';

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
      message: '没绑定，/agents 挑一个。',
    };
  }

  const result = await sendToBinding(ctx.store, binding, args.text, {
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
        message: `❌ ${result.error}\n已自动解绑。`,
      };
    }
    return { ok: false, reason: 'send_failed', message: `❌ 发送失败：${result.error}` };
  }

  // agent 会把这句话记进自己的 transcript，别让镜像再推回来
  ctx.echo.note(result.paneId, args.text);

  return { ok: true, paneId: result.paneId, acked: ctx.config.ackOnSend };
}
