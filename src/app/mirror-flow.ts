/** transcript 镜像消息 → 对应话题。 */
import type { AppContext } from './context.ts';
import type { MirroredMessage } from '../core/transcript-watcher.ts';
import { formatMirrored } from '../telegram/format.ts';

export async function handleMirrored(ctx: AppContext, messages: MirroredMessage[]): Promise<void> {
  for (const { binding, item } of messages) {
    // 你在 Telegram 里发的那句话，agent 记进 transcript 后会绕回来——挡掉
    if (item.role === 'user' && ctx.echo.consume(binding.paneId, item.text)) continue;

    const text = formatMirrored(item);
    if (!text) continue;

    await ctx.egress
      .enqueue({
        chatId: binding.chatId,
        threadId: binding.threadId || undefined,
        text,
        parseMode: 'HTML',
      })
      .catch(() => undefined); // 单条镜像失败不该影响后面的
  }
}
