/**
 * 推送策略（modules.md §4.8b）：绑定即推送 —— 只按级别与镜像去重过滤，
 * 不揣测「人是不是正坐在终端前」（那套 D13 静音机制已按需求移除）。
 */
import type { NotifyLevel } from '../config.ts';
import type { AgentEventType, NormalizedEvent } from '../providers/types.ts';

const IMPORTANT_TYPES: readonly AgentEventType[] = [
  'waiting',
  'permission',
  'question',
  'failed',
  'completed',
];

/**
 * 开着 transcript 镜像时，这些事件说不出镜像没说过的东西。
 * agent 的回复原文已经推过来了，再补一条「✅ 完成 / 任务完成」只是噪声。
 * waiting / permission / failed / ended 不在内 —— 那些是要你动手的信号，镜像里没有。
 */
const COVERED_BY_MIRROR: readonly AgentEventType[] = ['completed', 'output', 'started'];

export function levelAllows(level: NotifyLevel, type: AgentEventType): boolean {
  if (level === 'off') return false;
  if (level === 'info') return true;
  return IMPORTANT_TYPES.includes(type);
}

export type NotifyContext = {
  event: NormalizedEvent;
  level: NotifyLevel;
  /** 这个绑定正在做 transcript 镜像（对话原文已经在推） */
  mirrored?: boolean;
};

export type NotifyDecision = { emit: boolean; reason: string; level: NotifyLevel };

export function shouldEmit(ctx: NotifyContext): NotifyDecision {
  const level = ctx.level;

  if (ctx.event.silent) return { emit: false, reason: 'silent-event', level };
  if (level === 'off') return { emit: false, reason: 'level-off', level };
  if (!levelAllows(level, ctx.event.type)) {
    return { emit: false, reason: `level-${level}-excludes-${ctx.event.type}`, level };
  }

  // 阻塞式决策永远要推：不推用户就没法解锁 agent
  if (ctx.event.blocking) return { emit: true, reason: 'blocking', level };

  // 对话原文已经在镜像里了，别再补一条空洞的「✅ 完成」
  if (ctx.mirrored && COVERED_BY_MIRROR.includes(ctx.event.type)) {
    return { emit: false, reason: 'covered-by-mirror', level };
  }

  return { emit: true, reason: 'ok', level };
}
