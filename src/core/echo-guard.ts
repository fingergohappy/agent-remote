/**
 * 回声抑制。
 *
 * 从 Telegram 发出去的文本会被写进 pane，agent 又把它记进自己的 transcript，
 * 于是镜像会把你刚发的那句话原样推回来。这里记住「刚发过什么」，镜像时消掉。
 *
 * 只消一次：你要是真在终端里又敲了同一句，第二次会照常镜像出来。
 * 在终端敲的字仍然要镜像 —— 手机上得看得见桌面那头在干什么。
 */

const TTL_MS = 5 * 60_000;
const MAX_PER_PANE = 20;

type Entry = { text: string; at: number };

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export class EchoGuard {
  #recent = new Map<string, Entry[]>();

  /** 记下一条刚经 Telegram 发给 pane 的文本 */
  note(paneId: string, text: string, at = Date.now()): void {
    const key = normalize(text);
    if (!key) return;
    const list = this.#recent.get(paneId) ?? [];
    list.push({ text: key, at });
    if (list.length > MAX_PER_PANE) list.splice(0, list.length - MAX_PER_PANE);
    this.#recent.set(paneId, list);
  }

  /** 这条是不是我们自己发出去的回声？是则消费掉（只挡一次）。 */
  consume(paneId: string, text: string, now = Date.now()): boolean {
    const list = this.#recent.get(paneId);
    if (!list?.length) return false;

    const key = normalize(text);
    const idx = list.findIndex((e) => e.text === key && now - e.at < TTL_MS);
    if (idx < 0) return false;

    list.splice(idx, 1);
    if (!list.length) this.#recent.delete(paneId);
    return true;
  }

  forget(paneId: string): void {
    this.#recent.delete(paneId);
  }

  gc(now = Date.now()): void {
    for (const [paneId, list] of this.#recent) {
      const alive = list.filter((e) => now - e.at < TTL_MS);
      if (alive.length) this.#recent.set(paneId, alive);
      else this.#recent.delete(paneId);
    }
  }
}
