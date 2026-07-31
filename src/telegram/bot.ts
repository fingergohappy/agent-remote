/** Bot 创建、鉴权 middleware、以及给 core 用的 Transport / TopicManager 适配。 */
import { Bot, type Api, type Context } from 'grammy';
import type { Config } from '../config.ts';
import type { TopicManager } from '../app/context.ts';
import type { InlineButton, Transport } from '../core/egress-queue.ts';
import { logger } from '../infra/logger.ts';
import {
  closeTopic,
  createTopic,
  deleteTopic,
  renameTopic,
  topicLink,
  verifyTopic,
} from './topics.ts';

const log = logger('bot');

export function createBot(config: Config): Bot {
  return new Bot(config.botToken);
}

function toInlineKeyboard(buttons: InlineButton[][] | undefined):
  | { inline_keyboard: ({ text: string; callback_data: string } | { text: string; url: string })[][] }
  | undefined {
  if (!buttons?.length) return undefined;
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((b) =>
        b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.callbackData ?? '' },
      ),
    ),
  };
}

export function createTransport(api: Api): Transport {
  return {
    async sendMessage(job) {
      const msg = await api.sendMessage(job.chatId, job.text, {
        ...(job.threadId ? { message_thread_id: job.threadId } : {}),
        ...(job.parseMode ? { parse_mode: job.parseMode } : {}),
        reply_markup: toInlineKeyboard(job.buttons),
        link_preview_options: { is_disabled: true },
      });
      return { messageId: msg.message_id };
    },

    async editMessage(job) {
      const msg = await api.editMessageText(job.chatId, job.messageId, job.text, {
        ...(job.parseMode ? { parse_mode: job.parseMode } : {}),
        reply_markup: toInlineKeyboard(job.buttons),
        link_preview_options: { is_disabled: true },
      });
      return { messageId: typeof msg === 'object' ? msg.message_id : job.messageId };
    },
  };
}

export function createTopicManager(api: Api): TopicManager {
  return {
    createTopic: (chatId, title, providerId) => createTopic(api, chatId, title, providerId),
    renameTopic: (chatId, threadId, title) => renameTopic(api, chatId, threadId, title),
    closeTopic: (chatId, threadId) => closeTopic(api, chatId, threadId),
    deleteTopic: (chatId, threadId) => deleteTopic(api, chatId, threadId),
    linkTo: (chatId, threadId) => topicLink(chatId, threadId),
    verifyTopic: (chatId, threadId, title) => verifyTopic(api, chatId, threadId, title),
  };
}

/** allowlist：userId 必须在 ALLOWED_USERS；ALLOWED_CHATS 非空时 chat 也要在列表里。 */
export function installAuth(bot: Bot, config: Config): void {
  const users = new Set(config.allowedUsers);
  const chats = new Set(config.allowedChats);

  bot.use(async (ctx: Context, next) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;

    // Bot 自己发的消息会以 service message 等形式回流（建 Topic 时尤其明显）。
    // 静默丢弃，别当成越权访问报警。
    if (userId !== undefined && userId === ctx.me.id) return;

    if (userId === undefined || !users.has(userId)) {
      log.warn('拒绝未授权用户', { userId, chatId });
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '未授权' }).catch(() => {});
      return;
    }
    if (chats.size && chatId !== undefined && !chats.has(chatId)) {
      log.warn('拒绝未授权 chat', { userId, chatId });
      return;
    }
    await next();
  });
}

export async function setCommandMenu(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: 'agents', description: '列出并绑定 agent' },
      { command: 'status', description: '当前绑定状态' },
      { command: 'history', description: '同步绑定前的历史' },
      { command: 'notify', description: '推送级别：全量 / 只推要事 / 静音' },
      { command: 'unbind', description: '解绑当前话题' },
      { command: 'rebind', description: '绑回上次那个 agent' },
      { command: 'cleanup', description: '清掉失效绑定' },
      { command: 'start', description: '使用说明' },
    ]);
  } catch (err) {
    log.warn('setMyCommands 失败', err);
  }
}
