/**
 * 「正在输入…」指示器。
 *
 * Telegram 的 sendChatAction 只显示约 5 秒，要持续显示必须循环续期。
 * 语义：从「用户把活交给 agent」（TG 发消息 / 点允许）起转，
 * 到 agent 停下来（完成/失败/等待输入/要授权）止；中间镜像发出的消息
 * 会临时顶掉 typing 显示，续期后又出现 —— 正好符合「还在干活」的观感。
 *
 * core 不认识 grammY —— 真正的 sendChatAction 由 telegram/ 注入。
 */
import { logger } from '../infra/logger.ts';

const log = logger('typing');

export type TypingSender = (chatId: string, threadId?: number) => Promise<void>;

/** chat action 显示约 5 秒，快到点就续 */
const REFRESH_MS = 4500;
/** 兜底：停止事件丢了也不能永远转下去 */
const MAX_MS = 5 * 60_000;

type Entry = { timer: NodeJS.Timeout; deadline: number };

export class TypingIndicator {
  #send: TypingSender;
  #refreshMs: number;
  #maxMs: number;
  #entries = new Map<string, Entry>();

  constructor(send: TypingSender, opts: { refreshMs?: number; maxMs?: number } = {}) {
    this.#send = send;
    this.#refreshMs = opts.refreshMs ?? REFRESH_MS;
    this.#maxMs = opts.maxMs ?? MAX_MS;
  }

  #key(chatId: string, threadId?: number): string {
    return `${chatId}:${threadId ?? 0}`;
  }

  /** 开始转。重复 start 只重置 TTL，不叠加定时器。 */
  start(chatId: string, threadId?: number): void {
    const key = this.#key(chatId, threadId);
    const existing = this.#entries.get(key);
    if (existing) {
      existing.deadline = Date.now() + this.#maxMs;
      return;
    }

    const fire = (): void => {
      const entry = this.#entries.get(key);
      if (!entry) return;
      if (Date.now() >= entry.deadline) {
        this.stop(chatId, threadId);
        log.debug('typing 达到时长上限，自动停止', { key });
        return;
      }
      // 发失败不重试也不停：话题没了自有 egress 那边收拾，这里安静点
      void this.#send(chatId, threadId).catch(() => undefined);
      entry.timer = setTimeout(fire, this.#refreshMs);
      entry.timer.unref?.();
    };

    const entry: Entry = {
      timer: setTimeout(fire, 0),
      deadline: Date.now() + this.#maxMs,
    };
    entry.timer.unref?.();
    this.#entries.set(key, entry);
  }

  stop(chatId: string, threadId?: number): void {
    const key = this.#key(chatId, threadId);
    const entry = this.#entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#entries.delete(key);
  }

  stopAll(): void {
    for (const entry of this.#entries.values()) clearTimeout(entry.timer);
    this.#entries.clear();
  }
}
