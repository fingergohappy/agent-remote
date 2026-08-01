/**
 * 用例层的依赖容器。
 *
 * app/ 不直接 import grammY：Topic 能力与出站发送都以接口注入，
 * 由 telegram/ 提供实现、main.ts 组装。
 */
import type { Config } from '../config.ts';
import type { AgentIndex } from '../core/agent-index.ts';
import type { BindStore } from '../core/bind-store.ts';
import type { DecisionBroker } from '../core/decision-broker.ts';
import type { EchoGuard } from '../core/echo-guard.ts';
import type { EgressQueue } from '../core/egress-queue.ts';

export type TopicEnsureResult = {
  threadId: number;
  created: boolean;
  degraded: boolean;
};

export type TopicManager = {
  /** providerId 只用来挑话题图标颜色，具体怎么挑是 telegram 层的事 */
  createTopic(chatId: string, title: string, providerId?: string): Promise<TopicEnsureResult>;
  renameTopic(chatId: string, threadId: number, title: string): Promise<void>;
  /** 关闭话题：保留历史，只是收工（D8）。返回 false 表示这个 chat 不支持关闭 */
  closeTopic(chatId: string, threadId: number): Promise<boolean>;
  /** 删除话题：连消息一起清掉，只在用户显式点按钮时用 */
  deleteTopic(chatId: string, threadId: number): Promise<boolean>;
  /**
   * 话题的可点链接。Bot 没有「把客户端跳进某个话题」的 API，
   * 能做的只有给一个 url 按钮，由用户点。拿不到链接返回 null。
   */
  linkTo(chatId: string, threadId: number): string | null;
  /**
   * 话题还在不在。**会在活话题里留一条「话题已修改」**，
   * 只在用户明确点击时调，不要进定时任务。
   */
  verifyTopic(chatId: string, threadId: number, title: string): Promise<boolean>;
};

/**
 * 镜像的窄接口，避免 app 依赖 watcher 的完整实现：
 * 忘游标 + 事件驱动踢一轮 + 「此刻真的在镜像吗」的事实信号。
 */
export type MirrorControl = {
  forget(paneId: string): void;
  kick(): void;
  isMirroring(paneId: string): boolean;
};

/** 「正在输入…」指示器的窄接口；agent 干活时转，停下来时停 */
export type TypingControl = {
  start(chatId: string, threadId?: number): void;
  stop(chatId: string, threadId?: number): void;
};

export type AppContext = {
  config: Config;
  store: BindStore;
  index: AgentIndex;
  /** 挡住「自己发出去的话被镜像推回来」 */
  echo: EchoGuard;
  broker: DecisionBroker;
  /** transcript 镜像；未启用时为 undefined */
  mirror?: MirrorControl;
  /** 「正在输入…」指示器；未启用时为 undefined */
  typing?: TypingControl;
  egress: EgressQueue;
  topics: TopicManager;
};

/** callback_data 上限 64 字节，一律用短前缀。 */
export const CB = {
  bind: (paneId: string): string => `b:${paneId}`,
  decision: (correlationId: string, decisionId: string): string =>
    `d:${correlationId}:${decisionId}`,
  history: (limit: number): string => `h:${limit}`,
  /** 历史分页：page 从 1 起；0 表示「尾页」（最新一页，随数据增长永远有效） */
  historyPage: (page: number, size: number): string => `hp:${page}:${size}`,
  /** 只断开绑定，话题原样留着 */
  unbind: (threadId: number): string => `u:${threadId}`,
  topicDelete: (threadId: number): string => `td:${threadId}`,
  notifyLevel: (level: string): string => `nl:${level}`,
  lang: (mode: string): string => `lg:${mode}`,
  refresh: (): string => 'ag:refresh',
} as const;

export type ParsedCallback =
  | { kind: 'bind'; paneId: string }
  | { kind: 'decision'; correlationId: string; decisionId: string }
  | { kind: 'history'; limit: number }
  | { kind: 'history-page'; page: number; size: number }
  | { kind: 'unbind'; threadId: number }
  | { kind: 'topic-delete'; threadId: number }
  | { kind: 'notify-level'; level: 'off' | 'important' | 'info' }
  | { kind: 'lang'; mode: 'auto' | 'zh' | 'en' }
  | { kind: 'refresh' }
  | null;

export function parseCallback(data: string): ParsedCallback {
  if (data === 'ag:refresh') return { kind: 'refresh' };
  if (data.startsWith('b:')) return { kind: 'bind', paneId: data.slice(2) };
  if (data.startsWith('lg:')) {
    const mode = data.slice(3);
    return mode === 'auto' || mode === 'zh' || mode === 'en' ? { kind: 'lang', mode } : null;
  }
  if (data.startsWith('nl:')) {
    // 旧消息按钮上可能还挂着更名前的 nl:verbose —— 认作 info
    const raw = data.slice(3);
    const level = raw === 'verbose' ? 'info' : raw;
    return level === 'off' || level === 'important' || level === 'info'
      ? { kind: 'notify-level', level }
      : null;
  }
  if (data.startsWith('td:')) {
    const threadId = Number(data.slice(3));
    return Number.isFinite(threadId) && threadId > 0 ? { kind: 'topic-delete', threadId } : null;
  }
  if (data.startsWith('u:')) {
    const threadId = Number(data.slice(2));
    return Number.isFinite(threadId) && threadId > 0 ? { kind: 'unbind', threadId } : null;
  }
  if (data.startsWith('hp:')) {
    const [pageS, sizeS] = data.slice(3).split(':');
    const page = Number(pageS);
    const size = Number(sizeS);
    return Number.isInteger(page) && page >= 0 && Number.isInteger(size) && size > 0
      ? { kind: 'history-page', page, size }
      : null;
  }
  if (data.startsWith('h:')) {
    const limit = Number(data.slice(2));
    return { kind: 'history', limit: Number.isFinite(limit) ? limit : 30 };
  }
  if (data.startsWith('d:')) {
    const rest = data.slice(2);
    const sep = rest.indexOf(':');
    if (sep <= 0) return null;
    return {
      kind: 'decision',
      correlationId: rest.slice(0, sep),
      decisionId: rest.slice(sep + 1),
    };
  }
  return null;
}
