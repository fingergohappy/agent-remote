/**
 * 「人是不是正坐在终端前」的活跃度打点（D13，学 CCGram 的 isUserActiveAtTerminal）。
 *
 * 信号来源：provider 的活跃类事件（Claude 的 UserPromptSubmit）。
 * provider 不声明 activitySuppress 时永远视为不活跃 —— 宁可多推，也不静默吞事件。
 */

export class ActivityTracker {
  #lastLocalInput = new Map<string, number>(); // paneId → ts
  #windowMs: number;

  constructor(windowMs: number) {
    this.#windowMs = windowMs;
  }

  /** 用户在终端里给 agent 敲了字 */
  noteLocalInput(paneId: string, at = Date.now()): void {
    this.#lastLocalInput.set(paneId, at);
  }

  isTerminalActive(paneId: string, now = Date.now()): boolean {
    const last = this.#lastLocalInput.get(paneId);
    return last !== undefined && now - last < this.#windowMs;
  }

  lastLocalInputAt(paneId: string): number | undefined {
    return this.#lastLocalInput.get(paneId);
  }

  forget(paneId: string): void {
    this.#lastLocalInput.delete(paneId);
  }
}
