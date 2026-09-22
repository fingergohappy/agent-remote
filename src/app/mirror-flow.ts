/** transcript 镜像消息 → 对应话题。绑定即推送，无静音揣测。 */
import type { AppContext } from './context.ts';
import type { MirroredMessage } from '../core/transcript-watcher.ts';
import type { Binding } from '../core/bind-store.ts';
import { formatMirrored } from '../telegram/format.ts';

/** 单条 Telegram 消息 4096，合并时留余量给 HTML 标签 */
const CHUNK_MAX = 3800;

/**
 * 同一轮里落到同一个话题的行合成一条消息。
 *
 * 镜像照搬 CLI 的每一行（工具调用、输出、思考），一轮 poll 攒十几行是常事，
 * 逐条发就是十几个手机通知。合并后一轮一条，读起来也更接近屏幕上的一段。
 */
export async function handleMirrored(ctx: AppContext, messages: MirroredMessage[]): Promise<void> {
  let pending: { binding: Binding; text: string } | null = null;

  const flush = async (): Promise<void> => {
    if (!pending) return;
    const { binding, text } = pending;
    pending = null;
    await ctx.egress
      .enqueue({
        chatId: binding.chatId,
        threadId: binding.threadId || undefined,
        text,
        parseMode: 'HTML',
      })
      .catch(() => undefined); // 单条镜像失败不该影响后面的
  };

  for (const { binding, item } of messages) {
    // 你在 Telegram 里发的那句话，agent 记进 transcript 后会绕回来——挡掉
    if (item.role === 'user' && ctx.echo.consume(binding.paneId, item.text)) continue;

    const text = formatMirrored(item);
    if (!text) continue;

    const sameTopic =
      pending?.binding.chatId === binding.chatId && pending?.binding.threadId === binding.threadId;
    if (pending && sameTopic && pending.text.length + text.length + 1 <= CHUNK_MAX) {
      pending.text += `\n${text}`;
      continue;
    }
    await flush();
    pending = { binding, text };
  }

  await flush();
}
