/** Bot 创建、鉴权 middleware、以及给 core 用的 Transport / TopicManager 适配。 */
import { Bot, type Api, type Context } from 'grammy';
import type { Config } from '../config.ts';
import type { TopicManager } from '../app/context.ts';
import type { InlineButton, Transport } from '../core/egress-queue.ts';
import type { TypingSender } from '../core/typing.ts';
import { noteLanguageCode, tIn, type Lang } from '../i18n.ts';
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

/** 「正在输入…」的底层调用；话题里要带 message_thread_id，否则只在主流显示 */
export function createTypingSender(api: Api): TypingSender {
  return async (chatId, threadId) => {
    await api.sendChatAction(
      chatId,
      'typing',
      threadId ? { message_thread_id: threadId } : undefined,
    );
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
    // 过了鉴权的每条 update 都带客户端语言 —— auto 模式据此切界面语言
    noteLanguageCode(ctx.from?.language_code);
    await next();
  });
}

export async function setCommandMenu(bot: Bot): Promise<void> {
  try {
    const menu = (lang: Lang): { command: string; description: string }[] => [
      { command: 'agents', description: tIn(lang, 'menu-agents') },
      { command: 'status', description: tIn(lang, 'menu-status') },
      { command: 'history', description: tIn(lang, 'menu-history') },
      { command: 'notify', description: tIn(lang, 'menu-notify') },
      { command: 'unbind', description: tIn(lang, 'menu-unbind') },
      { command: 'rebind', description: tIn(lang, 'menu-rebind') },
      { command: 'cleanup', description: tIn(lang, 'menu-cleanup') },
      { command: 'lang', description: tIn(lang, 'menu-lang') },
      { command: 'start', description: tIn(lang, 'menu-start') },
    ];
    // 命令菜单由 Telegram 按客户端语言选：默认英文，中文客户端拿 zh 一套
    await bot.api.setMyCommands(menu('en'));
    await bot.api.setMyCommands(menu('zh'), { language_code: 'zh' });
  } catch (err) {
    log.warn('setMyCommands 失败', err);
  }
}
