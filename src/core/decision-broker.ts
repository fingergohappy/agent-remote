/**
 * 「等人点按钮」的短生命周期状态（modules.md §4.6）。
 *
 * 纯内存：阻塞的 hook 请求被 ingress hold 住，用户点按钮后由这里唤醒。
 * 不落盘 —— 服务重启会断掉被 hold 的连接，hook 静默退 0，agent 退回本机
 * TUI 的权限框，行为已经是安全的；持久化一个没人会再来读的决策没有意义。
 */
import { randomBytes } from 'node:crypto';
import type { NormalizedEvent } from '../providers/types.ts';

export type PendingDecision = {
  correlationId: string;
  event: NormalizedEvent;
  createdAt: number;
  expiresAt: number;
  /** 决策消息的 TG message id，供决策后编辑 */
  messageId?: number;
  chatId?: string;
  threadId?: number;
  resolvedWith?: { decisionId: string; response: unknown; note?: string };
};

type Waiter = (value: { resolved: boolean; response: unknown }) => void;

export function newCorrelationId(): string {
  return randomBytes(4).toString('hex');
}

export class DecisionBroker {
  #pending = new Map<string, PendingDecision>();
  #waiters = new Map<string, Waiter[]>();
  #timeoutMs: number;
  #gcTimer?: NodeJS.Timeout;

  constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
  }

  startGc(intervalMs = 30_000): void {
    if (this.#gcTimer) return;
    this.#gcTimer = setInterval(() => this.gcExpired(), intervalMs);
    this.#gcTimer.unref?.();
  }

  stopGc(): void {
    if (this.#gcTimer) clearInterval(this.#gcTimer);
    this.#gcTimer = undefined;
  }

  create(event: NormalizedEvent & { correlationId: string }): PendingDecision {
    const now = Date.now();
    const pending: PendingDecision = {
      correlationId: event.correlationId,
      event,
      createdAt: now,
      expiresAt: now + this.#timeoutMs,
    };
    this.#pending.set(event.correlationId, pending);
    return pending;
  }

  get(correlationId: string): PendingDecision | undefined {
    return this.#pending.get(correlationId);
  }

  attachMessage(
    correlationId: string,
    ref: { chatId: string; threadId?: number; messageId: number },
  ): void {
    const p = this.#pending.get(correlationId);
    if (!p) return;
    p.chatId = ref.chatId;
    p.threadId = ref.threadId;
    p.messageId = ref.messageId;
  }

  /** hook 侧长轮询：等到有决策或超时。 */
  wait(correlationId: string, maxWaitMs: number): Promise<{ resolved: boolean; response: unknown }> {
    const p = this.#pending.get(correlationId);
    if (p?.resolvedWith) {
      return Promise.resolve({ resolved: true, response: p.resolvedWith.response });
    }

    return new Promise((resolve) => {
      const list = this.#waiters.get(correlationId) ?? [];
      let settled = false;

      const done = (value: { resolved: boolean; response: unknown }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const arr = this.#waiters.get(correlationId);
        if (arr) {
          const i = arr.indexOf(done);
          if (i >= 0) arr.splice(i, 1);
        }
        resolve(value);
      };

      const timer = setTimeout(() => done({ resolved: false, response: undefined }), maxWaitMs);
      timer.unref?.();

      list.push(done);
      this.#waiters.set(correlationId, list);
    });
  }

  /** 记录决策结果并唤醒 hook。 */
  settle(correlationId: string, decisionId: string, response: unknown, note?: string): boolean {
    const p = this.#pending.get(correlationId);
    if (!p) return false;
    if (p.resolvedWith) return false;

    p.resolvedWith = { decisionId, response, note };

    for (const waiter of this.#waiters.get(correlationId) ?? []) {
      waiter({ resolved: true, response });
    }
    this.#waiters.delete(correlationId);
    return true;
  }

  /** 超时：provider 声明的兜底响应（如 Claude 退回本机 TUI 权限框）。 */
  expire(correlationId: string, response: unknown): void {
    const p = this.#pending.get(correlationId);
    if (!p || p.resolvedWith) return;
    p.resolvedWith = { decisionId: '__timeout__', response };
    for (const waiter of this.#waiters.get(correlationId) ?? []) {
      waiter({ resolved: true, response });
    }
    this.#waiters.delete(correlationId);
  }

  gcExpired(now = Date.now()): PendingDecision[] {
    const dropped: PendingDecision[] = [];
    for (const [id, p] of this.#pending) {
      // 已决策的多留一会儿，避免用户在按钮上连点时读不到「已处理」状态
      const keepUntil = p.resolvedWith ? p.expiresAt + 60_000 : p.expiresAt;
      if (now > keepUntil) {
        this.#pending.delete(id);
        this.#waiters.delete(id);
        if (!p.resolvedWith) dropped.push(p);
      }
    }
    return dropped;
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }
}
