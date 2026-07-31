/**
 * 对话镜像：把 agent 原生 transcript 里新增的往来推到对应话题。
 *
 * 为什么必须有这一层：Claude 的 Stop hook 只带 session_id / transcript_path，
 * **没有回复正文**。只靠 hook 事件，手机上只能看到「✅ 完成」，看不到它说了什么。
 * Codex 的 notify 虽然带 last-assistant-message，但也只在一轮结束时响一次。
 *
 * 触发方式分三层，延迟递增、可靠性递增：
 *  1. kick()  —— hook 事件到达时由 notify-flow 踢一脚（防抖合并）；
 *  2. fs.watch —— 监听 provider 报上来的 transcript 文件（source），写入即踢；
 *  3. 兜底轮询 —— 低频定时 tick，防 hook 丢失 / inotify 在某些文件系统上失灵。
 *
 * 重启后从文件当前末尾开始跟，不回放历史 —— 要看之前的用 /history。
 */
import { watch, type FSWatcher } from 'node:fs';
import type { BindStore, Binding } from './bind-store.ts';
import { logger } from '../infra/logger.ts';
import { getProvider } from '../providers/registry.ts';
import type { HistoryItem } from '../providers/types.ts';

const log = logger('transcript');

export type MirroredMessage = {
  binding: Binding;
  item: HistoryItem;
};

export type WatcherDeps = {
  store: BindStore;
  onMessages(messages: MirroredMessage[]): Promise<void>;
  /** 单个绑定单轮最多吐多少条，防止一次 compact 之类把话题刷爆 */
  maxPerTick?: number;
  /** kick 的防抖窗口：hook 风暴 / 连续写盘时合并成一轮 */
  kickDebounceMs?: number;
};

const DEFAULT_INTERVAL_MS = 20_000;
const DEFAULT_MAX_PER_TICK = 15;
const DEFAULT_KICK_DEBOUNCE_MS = 250;

export class TranscriptWatcher {
  #deps: WatcherDeps;
  #cursors = new Map<string, unknown>(); // paneId → provider 私有游标
  #fileWatches = new Map<string, { path: string; watcher: FSWatcher }>(); // paneId → fs.watch
  #timer?: NodeJS.Timeout;
  #kickTimer?: NodeJS.Timeout;
  #running = false;
  #pendingKick = false; // tick 进行中又被踢 → 结束后补跑，不丢触发
  #stopped = false;

  constructor(deps: WatcherDeps) {
    this.#deps = deps;
  }

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.#timer) return;
    this.#stopped = false;
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#kickTimer) clearTimeout(this.#kickTimer);
    this.#kickTimer = undefined;
    for (const paneId of [...this.#fileWatches.keys()]) this.#closeWatch(paneId);
  }

  forget(paneId: string): void {
    this.#cursors.delete(paneId);
    this.#closeWatch(paneId);
  }

  /** 事件驱动入口：hook 到达 / transcript 文件有写入时调，防抖后跑一轮 tick。 */
  kick(): void {
    if (this.#stopped || this.#kickTimer) return;
    this.#kickTimer = setTimeout(() => {
      this.#kickTimer = undefined;
      void this.tick();
    }, this.#deps.kickDebounceMs ?? DEFAULT_KICK_DEBOUNCE_MS);
    this.#kickTimer.unref?.();
  }

  /** 暴露给测试与启动时的手动触发 */
  async tick(): Promise<void> {
    if (this.#running) {
      // 上一轮还没跑完（慢盘/大文件）：记下来，结束后补一轮
      this.#pendingKick = true;
      return;
    }
    this.#running = true;
    try {
      const collected: MirroredMessage[] = [];
      const activePanes = new Set<string>();

      for (const binding of this.#deps.store.list()) {
        if (binding.notifyLevel !== 'verbose') continue; // 只有全量模式才镜像

        const provider = getProvider(binding.providerId);
        if (!provider?.capabilities.nativeTranscript || !provider.pollNativeEnhancements) continue;

        activePanes.add(binding.paneId);
        try {
          const result = await provider.pollNativeEnhancements(
            {
              paneId: binding.paneId,
              sessionId: binding.sessionId,
              transcriptPath: binding.transcriptPath,
              cwd: binding.cwd,
            },
            this.#cursors.get(binding.paneId),
          );
          if (!result) continue;

          this.#cursors.set(binding.paneId, result.nextCursor);
          if (result.source) this.#watchFile(binding.paneId, result.source);

          const max = this.#deps.maxPerTick ?? DEFAULT_MAX_PER_TICK;
          const items = result.messages.slice(-max);
          if (result.messages.length > items.length) {
            log.debug('镜像截断', {
              paneId: binding.paneId,
              dropped: result.messages.length - items.length,
            });
          }
          for (const item of items) collected.push({ binding, item });
        } catch (err) {
          log.warn('拉取 transcript 失败', { paneId: binding.paneId, err: String(err) });
        }
      }

      // 解绑/降级后不再镜像的 pane，把挂着的 watch 收掉
      for (const paneId of [...this.#fileWatches.keys()]) {
        if (!activePanes.has(paneId)) this.#closeWatch(paneId);
      }

      if (collected.length) await this.#deps.onMessages(collected);
    } finally {
      this.#running = false;
      if (this.#pendingKick) {
        this.#pendingKick = false;
        this.kick();
      }
    }
  }

  /** 跟住 provider 报上来的 transcript 文件；换会话（路径变了）就换监听对象。 */
  #watchFile(paneId: string, path: string): void {
    const existing = this.#fileWatches.get(paneId);
    if (existing?.path === path) return;
    if (existing) this.#closeWatch(paneId);
    if (this.#stopped) return;

    try {
      const watcher = watch(path, () => this.kick());
      // 文件被删/移走时 FSWatcher 会 emit error，不接住会打崩进程；
      // 关掉即可，下一轮 poll 会重新解析路径并重建监听
      watcher.on('error', () => this.#closeWatch(paneId));
      this.#fileWatches.set(paneId, { path, watcher });
    } catch {
      // watch 失败（文件还不存在等）不致命，靠兜底轮询
    }
  }

  #closeWatch(paneId: string): void {
    const entry = this.#fileWatches.get(paneId);
    if (!entry) return;
    this.#fileWatches.delete(paneId);
    try {
      entry.watcher.close();
    } catch {
      /* 已经关了 */
    }
  }
}
