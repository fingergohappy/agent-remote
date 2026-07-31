/**
 * 内存热缓存（modules.md §4.4）：paneId ↔ sessionId ↔ 最近一次 discover 结果。
 * 用于 ingress 事件只带 sessionId/cwd 而没有 paneId 时的反查。
 */
import type { AgentInstance } from './discover.ts';

export type IndexEntry = {
  paneId: string;
  providerId: string;
  sessionId?: string;
  cwd?: string;
  display?: string;
  lastSeen: number;
};

export class AgentIndex {
  #byPane = new Map<string, IndexEntry>();

  upsertFromDiscover(instances: AgentInstance[]): void {
    const now = Date.now();
    for (const inst of instances) {
      const prev = this.#byPane.get(inst.paneId);
      this.#byPane.set(inst.paneId, {
        paneId: inst.paneId,
        providerId: inst.providerId,
        sessionId: prev?.providerId === inst.providerId ? prev.sessionId : undefined,
        cwd: inst.cwd,
        display: inst.display,
        lastSeen: now,
      });
    }
  }

  noteEvent(e: { paneId?: string; providerId: string; sessionId?: string; cwd?: string }): void {
    if (!e.paneId) return;
    const prev = this.#byPane.get(e.paneId);
    this.#byPane.set(e.paneId, {
      paneId: e.paneId,
      providerId: e.providerId,
      sessionId: e.sessionId ?? prev?.sessionId,
      cwd: e.cwd ?? prev?.cwd,
      display: prev?.display,
      lastSeen: Date.now(),
    });
  }

  get(paneId: string): IndexEntry | undefined {
    return this.#byPane.get(paneId);
  }

  paneBySession(sessionId: string): string | null {
    for (const e of this.#byPane.values()) {
      if (e.sessionId === sessionId) return e.paneId;
    }
    return null;
  }

  /** cwd + providerId 反查；多个候选时取最近见到的，模糊结果由调用方决定是否使用。 */
  paneByCwd(cwd: string, providerId?: string): string | null {
    let best: IndexEntry | null = null;
    for (const e of this.#byPane.values()) {
      if (e.cwd !== cwd) continue;
      if (providerId && e.providerId !== providerId) continue;
      if (!best || e.lastSeen > best.lastSeen) best = e;
    }
    return best?.paneId ?? null;
  }

  forget(paneId: string): void {
    this.#byPane.delete(paneId);
  }

  all(): IndexEntry[] {
    return [...this.#byPane.values()];
  }
}
