/**
 * 出站队列（modules.md §4.8）：同 thread FIFO、全局限流、长文切分、429 退避、
 * parse 失败降级纯文本。
 *
 * core 不认识 grammY —— 真正的网络调用由 telegram/ 注入 Transport。
 * 这里也**不**写对话审计文件（D8：历史只在 Telegram）。
 */
import { logger } from '../infra/logger.ts';

const log = logger('egress');

/** 二选一：callbackData 回调按钮，或 url 跳转按钮 */
export type InlineButton = { text: string; callbackData?: string; url?: string };

export type EgressJob = {
  chatId: string;
  threadId?: number;
  text: string;
  parseMode?: 'HTML';
  buttons?: InlineButton[][];
  /** 提供则编辑既有消息而非新发 */
  editMessageId?: number;
};

export type SendOutcome = { messageId: number };

export type Transport = {
  sendMessage(job: {
    chatId: string;
    threadId?: number;
    text: string;
    parseMode?: 'HTML';
    buttons?: InlineButton[][];
  }): Promise<SendOutcome>;
  editMessage(job: {
    chatId: string;
    messageId: number;
    text: string;
    parseMode?: 'HTML';
    buttons?: InlineButton[][];
  }): Promise<SendOutcome>;
};

/** Telegram 单条消息上限 4096 字符，留出余量给分段标记。 */
const MAX_LEN = 3800;
/** 全局最小发送间隔，避免撞 Bot API 全局限流 */
const MIN_INTERVAL_MS = 40;
/**
 * 一次发送最多试几轮。这些重试是异质的，最坏情况要叠加：
 * HTML 降级 1 次 + thread 抖动重试 1 次 + 去掉 thread 重发 1 次 + 真正发出去 1 次。
 */
const MAX_RETRIES = 5;

export function splitText(text: string, maxLen = MAX_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    // 优先在换行处断，其次空格，最后硬切
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = rest.lastIndexOf(' ', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

function retryAfterOf(err: unknown): number | null {
  const e = err as { parameters?: { retry_after?: number }; retry_after?: number } | undefined;
  const sec = e?.parameters?.retry_after ?? e?.retry_after;
  return typeof sec === 'number' && sec >= 0 ? sec : null;
}

function isParseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /can't parse entities|unsupported start tag|unclosed/i.test(msg);
}

/** 编辑成了和原来一模一样的内容。刷新时列表没变就会这样，不是错误。 */
function isNotModified(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /message is not modified/i.test(msg);
}

/**
 * 话题已经不存在了 —— 用户手动删掉了它。
 *
 * Bot API 没有 forum_topic_deleted 事件（删除会把话题里的消息连同 service message
 * 一起清掉），sendChatAction 对死话题也照样返回 ok。发送失败是唯一可靠的信号。
 */
export function isThreadGone(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /message thread not found|TOPIC_ID_INVALID|topic.*deleted/i.test(msg);
}

/**
 * 话题被**关闭**了（不是删除）。白名单成员关话题会走 forum_topic_closed 事件；
 * 但非白名单成员关的，auth 中间件把 service message 拦掉了，
 * 只能在发送撞 400 时发现。和 gone 分开处理：closed 的历史都还在，可 reopen。
 */
export function isTopicClosed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /TOPIC_CLOSED/i.test(msg);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type EgressOptions = {
  /** 话题已被用户删除时回调，让上层解绑 */
  onThreadGone?(chatId: string, threadId: number): void | Promise<void>;
  /** 话题已被关闭（TOPIC_CLOSED）时回调，让上层解绑（与 forum_topic_closed 语义对齐） */
  onTopicClosed?(chatId: string, threadId: number): void | Promise<void>;
};

export class EgressQueue {
  #transport: Transport;
  #onThreadGone: EgressOptions['onThreadGone'];
  #onTopicClosed: EgressOptions['onTopicClosed'];
  /** 每个 thread 一条串行链，保证 Topic 内消息不乱序 */
  #chains = new Map<string, Promise<unknown>>();
  #lastSentAt = 0;

  constructor(transport: Transport, opts: EgressOptions = {}) {
    this.#transport = transport;
    this.#onThreadGone = opts.onThreadGone;
    this.#onTopicClosed = opts.onTopicClosed;
  }

  /** 等已入队的消息发完（或超时），仅用于优雅退出。 */
  async drain(timeoutMs = 3000): Promise<void> {
    const all = Promise.all([...this.#chains.values()]);
    await Promise.race([all, sleep(timeoutMs)]);
  }

  #key(chatId: string, threadId?: number): string {
    return `${chatId}:${threadId ?? 0}`;
  }

  /** 入队；返回最后一条消息的 id。 */
  enqueue(job: EgressJob): Promise<SendOutcome> {
    const key = this.#key(job.chatId, job.threadId);
    const prev = this.#chains.get(key) ?? Promise.resolve();
    const next = prev.then(
      () => this.#run(job),
      () => this.#run(job),
    );
    this.#chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  async #throttle(): Promise<void> {
    const wait = this.#lastSentAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.#lastSentAt = Date.now();
  }

  async #run(job: EgressJob): Promise<SendOutcome> {
    if (job.editMessageId !== undefined) {
      // 编辑只能落在单条消息上：超长时保留首个切片（在换行处切），
      // 静默截断胜过必然的 MESSAGE_TOO_LONG —— 后者会让「🔄 刷新」看起来点了没反应
      const [head, ...overflow] = splitText(job.text);
      const clipped = overflow.length ? { ...job, text: `${head}\n…` } : job;
      return this.#withRetry(clipped, (payload) =>
        this.#transport.editMessage({
          chatId: job.chatId,
          messageId: job.editMessageId!,
          text: payload.text,
          parseMode: payload.parseMode,
          buttons: payload.buttons,
        }),
      );
    }

    const chunks = splitText(job.text);
    let last: SendOutcome = { messageId: 0 };
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      last = await this.#withRetry(
        {
          ...job,
          text: chunks[i]!,
          // 按钮只挂在最后一段
          buttons: isLast ? job.buttons : undefined,
        },
        // 注意用 payload.threadId 而不是 job.threadId：
        // 话题没了会把它降级成 undefined 再重发，那样内容还能落到主聊天流
        (payload) =>
          this.#transport.sendMessage({
            chatId: job.chatId,
            threadId: payload.threadId,
            text: payload.text,
            parseMode: payload.parseMode,
            buttons: payload.buttons,
          }),
      );
    }
    return last;
  }

  async #withRetry(
    job: EgressJob,
    call: (payload: EgressJob) => Promise<SendOutcome>,
  ): Promise<SendOutcome> {
    let payload = job;
    let lastErr: unknown;
    /** 已经用同一个 thread 重试过一次（防瞬时抖动误判） */
    let threadRetried = false;
    /** 已经降级成不带 thread 重发 */
    let threadDropped = false;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this.#throttle();
      try {
        return await call(payload);
      } catch (err) {
        lastErr = err;

        const retryAfter = retryAfterOf(err);
        if (retryAfter !== null) {
          log.warn(`429，退避 ${retryAfter}s`);
          await sleep(retryAfter * 1000 + 250);
          continue;
        }

        if (payload.parseMode && isParseError(err)) {
          log.warn('HTML 解析失败，降级为纯文本');
          payload = { ...payload, parseMode: undefined, text: stripHtml(payload.text) };
          continue;
        }

        // 内容没变，Telegram 拒绝编辑 —— 目标状态已经达到了
        if (isNotModified(err)) {
          return { messageId: job.editMessageId ?? 0 };
        }

        // 话题被关闭（TOPIC_CLOSED 是明确状态，不是抖动，不用重试确认）：
        // 解绑交给上层，这条内容降级到主聊天流，别让人什么都收不到
        if (isTopicClosed(err) && payload.threadId && !threadDropped) {
          log.info('话题已关闭，改投主聊天流并解绑', {
            chatId: job.chatId,
            threadId: payload.threadId,
          });
          await this.#onTopicClosed?.(job.chatId, payload.threadId);
          threadDropped = true;
          payload = { ...payload, threadId: undefined };
          continue;
        }

        // 话题可能被删了。但「thread not found」也可能是瞬时抖动 ——
        // 学 hermes（#31501）：同一个 thread 先原样重试一次，第二次还失败才认定它没了。
        if (isThreadGone(err) && payload.threadId && !threadDropped) {
          if (!threadRetried) {
            threadRetried = true;
            log.debug('thread not found，同 thread 再试一次', { threadId: payload.threadId });
            continue;
          }
          log.info('话题确已不存在，改投主聊天流并解绑', {
            chatId: job.chatId,
            threadId: payload.threadId,
          });
          await this.#onThreadGone?.(job.chatId, payload.threadId);
          // 去掉 message_thread_id 重发：话题没了不等于这条内容就该丢，
          // 让它落到主聊天流，总比人什么都收不到强
          threadDropped = true;
          payload = { ...payload, threadId: undefined };
          continue;
        }

        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

/** parse 失败降级用：去掉标签，还原实体。 */
export function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
