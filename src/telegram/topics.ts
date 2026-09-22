/**
 * Forum Topic 生命周期（modules.md §4.9）。
 * 非 forum 的 chat（私聊/普通群）降级为 threadId=0 的单工位模式。
 */
import type { Api } from 'grammy';
import { isThreadGone } from '../core/egress-queue.ts';
import { logger } from '../infra/logger.ts';

const log = logger('topics');

export type EnsureResult = {
  threadId: number;
  created: boolean;
  /** chat 不支持 Topics，退化到主聊天流 */
  degraded: boolean;
};

/**
 * 建一个新 Topic。
 *
 * 不要用 getChat 的 `is_forum` 做前置判断 —— 实测它对「BotFather 里开了 threads 的
 * 私聊」报 false，但 createForumTopic 在那里是能成功的。能力只有试了才知道，
 * 所以直接调用，失败再退化到主聊天流。
 */
export async function createTopic(
  api: Api,
  chatId: string,
  title: string,
  providerId?: string,
): Promise<EnsureResult> {
  const iconColor = providerId ? providerTopicColor(providerId) : undefined;
  try {
    const topic = await api.createForumTopic(chatId, title.slice(0, 128), {
      ...(iconColor === undefined ? {} : { icon_color: iconColor }),
    });
    return { threadId: topic.message_thread_id, created: true, degraded: false };
  } catch (err) {
    log.warn('createForumTopic 失败，退化到主聊天流', err);
    return { threadId: 0, created: false, degraded: true };
  }
}

export async function renameTopic(
  api: Api,
  chatId: string,
  threadId: number,
  title: string,
): Promise<void> {
  if (!threadId) return;
  try {
    await api.editForumTopic(chatId, threadId, { name: title.slice(0, 128) });
  } catch (err) {
    log.debug('editForumTopic 失败（忽略）', err);
  }
}

/**
 * 话题还在不在？
 *
 * 这是唯一能探出「话题已被删除」的非发送手段：带 `name` 的 editForumTopic
 * 对死话题报 `TOPIC_ID_INVALID`。代价是活话题里会留一条「话题已修改」——
 * 实测改成**同名**也照样发 service message，躲不掉（D17 的表）。
 * 所以只在用户明确点击时调，绝不进定时对账。
 *
 * 顺带把名字刷成当前标题：pane 的 cwd / display 可能已经变了，这次改名是应该的。
 *
 * 只有确证「没了」才返回 false。网络抖动之类的错误一律当作还在 ——
 * 误判成没了会把好好的绑定清掉，比留个僵尸更糟。
 */
export async function verifyTopic(
  api: Api,
  chatId: string,
  threadId: number,
  title: string,
): Promise<boolean> {
  if (!threadId) return true; // 主聊天流不会消失
  try {
    await api.editForumTopic(chatId, threadId, { name: title.slice(0, 128) });
    return true;
  } catch (err) {
    if (isThreadGone(err)) {
      log.info('话题已不存在', { chatId, threadId });
      return false;
    }
    log.debug('话题探测遇到其它错误，当作还在', String(err));
    return true;
  }
}

/**
 * 关闭话题（不是删除）：消息都还在，只是不能再发言。
 *
 * 注意：只有真正的超级群 forum 支持。BotFather 给 Bot 开 threads 的私聊里，
 * createForumTopic / deleteForumTopic 能用，但 closeForumTopic 会报
 * 「the chat is not a supergroup forum」—— 所以要把成败告诉调用方，
 * 由它决定要不要提供「删除」这个替代动作。
 */
export async function closeTopic(api: Api, chatId: string, threadId: number): Promise<boolean> {
  if (!threadId) return false; // 主聊天流没有话题可关
  try {
    await api.closeForumTopic(chatId, threadId);
    return true;
  } catch (err) {
    log.info('closeForumTopic 不可用（多半是私聊话题）', String(err));
    return false;
  }
}

/** 删除话题：连同里面的消息一起没了，只能由用户显式触发。 */
export async function deleteTopic(api: Api, chatId: string, threadId: number): Promise<boolean> {
  if (!threadId) return false;
  try {
    await api.deleteForumTopic(chatId, threadId);
    return true;
  } catch (err) {
    log.warn('deleteForumTopic 失败', err);
    return false;
  }
}

/**
 * 话题图标颜色。Telegram 只认这六个值，别的会被拒。
 * 给每个 provider 固定一个色，话题列表里一眼能分出谁是谁。
 */
const TOPIC_COLORS = {
  blue: 0x6fb9f0,
  yellow: 0xffd67e,
  purple: 0xcb86db,
  green: 0x8eee98,
  pink: 0xff93b2,
  orange: 0xfb6f5f,
} as const;

/** Telegram 只认这几个具体取值，所以类型要保留字面量，不能退化成 number */
export type TopicColor = (typeof TOPIC_COLORS)[keyof typeof TOPIC_COLORS];

export function providerTopicColor(providerId: string): TopicColor | undefined {
  if (providerId === 'claude') return TOPIC_COLORS.orange;
  if (providerId === 'codex') return TOPIC_COLORS.green;
  if (providerId === 'pi') return TOPIC_COLORS.blue;
  return undefined; // 不认识的 provider 交给 Telegram 随机配色
}

/**
 * 话题的深链。Bot 没法把客户端「跳」进某个话题（没有这种 API），能做的只有
 * 给一个 url 按钮由用户点 —— 前提是这个话题**有**可寻址的链接。
 *
 * 超级群 forum 有：`t.me/c/<去掉-100的内部id>/<thread>`。
 *
 * 私聊话题**没有**。实测过五种候选，Bot API 全部接受（说明只是没做语义校验），
 * 客户端一个都进不去：
 *   t.me/c/0/<thread>                             ← 最早的猜测
 *   t.me/c/<userId>/<thread>                      ← c/ 里填完整 user id
 *   t.me/<botUsername>/<thread>                   ← 照搬公开群话题链接
 *   tg://privatepost?channel=<userId>&post=<t>
 *   tg://openmessage?user_id=<userId>&message_id=<t>
 *   tg://resolve?domain=<botUsername>&thread=<t>
 * 私聊的 peer 不是 channel，`t.me/c/` 这套寻址从根上就不适用。
 *
 * 所以这里对私聊直接返回 null：**宁可不给按钮，也不给一个点了没反应的按钮**。
 */
export function topicLink(chatId: string, threadId: number): string | null {
  if (!threadId) return null;
  if (!chatId.startsWith('-100')) return null; // 私聊话题无深链
  return `https://t.me/c/${chatId.slice(4)}/${threadId}`;
}
