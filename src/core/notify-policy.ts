/**
 * 推送策略（D13 / modules.md §4.8b）：默认克制，不做全文镜像。
 * 只回答一个问题：这条 NormalizedEvent 要不要进 egress。
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

/** 终端活跃时可以压制的类型；permission/waiting 不在内 —— 桌面上可能没看见权限框。 */
const SUPPRESSIBLE_WHEN_ACTIVE: readonly AgentEventType[] = ['output', 'completed'];

/**
 * 开着 transcript 镜像时，这些事件说不出镜像没说过的东西。
 * agent 的回复原文已经推过来了，再补一条「✅ 完成 / 任务完成」只是噪声。
 * waiting / permission / failed / ended 不在内 —— 那些是要你动手的信号，镜像里没有。
 */
const COVERED_BY_MIRROR: readonly AgentEventType[] = ['completed', 'output', 'started'];

export function levelAllows(level: NotifyLevel, type: AgentEventType): boolean {
  if (level === 'off') return false;
  if (level === 'verbose') return true;
  return IMPORTANT_TYPES.includes(type);
}

export type NotifyContext = {
  event: NormalizedEvent;
  level: NotifyLevel;
  terminalActive: boolean;
  fromTelegram: boolean;
  quietWhenTerminalActive: boolean;
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

  if (ctx.quietWhenTerminalActive && ctx.terminalActive && !ctx.fromTelegram) {
    if (SUPPRESSIBLE_WHEN_ACTIVE.includes(ctx.event.type)) {
      return { emit: false, reason: 'terminal-active', level };
    }
  }

  return { emit: true, reason: 'ok', level };
}
