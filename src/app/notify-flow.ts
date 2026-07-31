/**
 * NormalizedEvent → 找 Binding → 策略过滤 → egress（modules.md §4.10 notify-flow）。
 * 这里是 core 与 provider 的汇合点，但仍然不解析 provider 私有字段。
 */
import type { AppContext } from './context.ts';
import { CB } from './context.ts';
import type { Binding } from '../core/bind-store.ts';
import type { InlineButton } from '../core/egress-queue.ts';
import { shouldEmit } from '../core/notify-policy.ts';
import { paneIdOfPid } from '../infra/tmux.ts';
import { logger } from '../infra/logger.ts';
import { getProvider } from '../providers/registry.ts';
import type { NormalizedEvent } from '../providers/types.ts';
import { formatEvent } from '../telegram/format.ts';

const log = logger('notify-flow');

async function resolvePaneId(ctx: AppContext, event: NormalizedEvent): Promise<string | undefined> {
  if (event.paneId) return event.paneId;

  if (event.sessionId) {
    const byBind = ctx.store.getBySessionId(event.sessionId);
    if (byBind) return byBind.paneId;
    const byIndex = ctx.index.paneBySession(event.sessionId);
    if (byIndex) return byIndex;
  }

  const pid = (event.payload as { pid?: number } | undefined)?.pid;
  if (typeof pid === 'number') {
    const byPid = await paneIdOfPid(pid);
    if (byPid) return byPid;
  }

  if (event.cwd) {
    const byCwd = ctx.index.paneByCwd(event.cwd, event.providerId);
    if (byCwd) return byCwd;
  }

  return undefined;
}

function findBinding(ctx: AppContext, event: NormalizedEvent): Binding | null {
  if (event.paneId) {
    const byPane = ctx.store.getByPane(event.paneId);
    if (byPane) return byPane;
  }
  if (event.sessionId) return ctx.store.getBySessionId(event.sessionId);
  return null;
}

/** hook 带来的会话信息回写到 binding，供 /history 精确定位。 */
function refreshBindingFacts(ctx: AppContext, binding: Binding, event: NormalizedEvent): Binding {
  const patch: Partial<Binding> = {};
  if (event.sessionId && event.sessionId !== binding.sessionId) patch.sessionId = event.sessionId;
  if (event.transcriptPath && event.transcriptPath !== binding.transcriptPath) {
    patch.transcriptPath = event.transcriptPath;
  }
  if (event.cwd && event.cwd !== binding.cwd) patch.cwd = event.cwd;
  if (!Object.keys(patch).length) return binding;
  return ctx.store.patch(binding.chatId, binding.threadId, patch) ?? binding;
}

function isFromTelegram(ctx: AppContext, binding: Binding): boolean {
  if (!binding.lastTelegramSendAt) return false;
  const at = Date.parse(binding.lastTelegramSendAt);
  return Number.isFinite(at) && Date.now() - at < ctx.config.telegramOriginWindowMs;
}

async function emitDecision(
  ctx: AppContext,
  bound: Binding,
  event: NormalizedEvent & { correlationId: string },
): Promise<void> {
  const provider = getProvider(event.providerId);
  const ui = provider?.buildDecisionUi?.(event);
  if (!ui) return;

  ctx.broker.create(event);

  const buttons: InlineButton[][] = [
    ui.buttons.map((b) => ({
      text: b.label,
      callbackData: CB.decision(event.correlationId, b.id),
    })),
  ];

  const { messageId } = await ctx.egress.enqueue({
    chatId: bound.chatId,
    threadId: bound.threadId || undefined,
    text: `🔐 <b>授权</b> ${escapeSummary(ui.prompt)}`,
    parseMode: 'HTML',
    buttons,
  });

  ctx.broker.attachMessage(event.correlationId, {
    chatId: bound.chatId,
    threadId: bound.threadId || undefined,
    messageId,
  });
}

function escapeSummary(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 返回 `bound: false` 表示这个事件没有对应绑定 —— 调用方据此不要 hold 阻塞式 hook。 */
export async function handleEvent(
  ctx: AppContext,
  event: NormalizedEvent,
): Promise<{ bound: boolean }> {
  const paneId = await resolvePaneId(ctx, event);
  const resolved: NormalizedEvent = paneId ? { ...event, paneId } : event;

  ctx.index.noteEvent({
    paneId: resolved.paneId,
    providerId: resolved.providerId,
    sessionId: resolved.sessionId,
    cwd: resolved.cwd,
  });

  // 「人在终端前」打点（D13）：silent 事件的唯一用途
  if (resolved.silent && resolved.paneId) {
    ctx.activity.noteLocalInput(resolved.paneId);
  }

  // 没绑定就什么都不做 —— 不推送、不打扰。这个 agent 你没托管给 Bot，
  // 它在终端上自己跑自己的（阻塞式 hook 也不 hold，见 handleEvent 的返回值）。
  const binding = findBinding(ctx, resolved);
  if (!binding) {
    log.debug('事件无对应绑定，忽略', { type: resolved.type, paneId: resolved.paneId });
    return { bound: false };
  }

  const bound = refreshBindingFacts(ctx, binding, resolved);

  // 事件驱动镜像：hook 一响就去追 transcript 增量，不等兜底轮询。
  // 放在 refreshBindingFacts 之后 —— 让这轮镜像用上刚更新的 transcriptPath。
  ctx.mirror?.kick();

  // 阻塞式授权：先建 pending，再推按钮；策略层不参与（永远要推）
  if (resolved.blocking && resolved.correlationId) {
    const provider = getProvider(resolved.providerId);
    if (provider?.capabilities.semanticPermission && provider.buildDecisionUi) {
      await emitDecision(ctx, bound, resolved as NormalizedEvent & { correlationId: string });
      return { bound: true };
    }
    log.warn('provider 不支持结构化授权，按普通事件处理', { providerId: resolved.providerId });
  }

  // 镜像开着时，completed / output 这类事件的内容是重复的
  const provider = getProvider(resolved.providerId);
  const mirrored =
    bound.notifyLevel === 'verbose' &&
    Boolean(provider?.capabilities.nativeTranscript && provider.pollNativeEnhancements);

  const decision = shouldEmit({
    event: resolved,
    mirrored,
    level: bound.notifyLevel,
    terminalActive: resolved.paneId ? ctx.activity.isTerminalActive(resolved.paneId) : false,
    fromTelegram: isFromTelegram(ctx, bound),
    quietWhenTerminalActive: ctx.config.quietWhenTerminalActive,
  });

  if (!decision.emit) {
    log.debug('事件被策略丢弃', { type: resolved.type, reason: decision.reason });
    return { bound: true };
  }

  await ctx.egress.enqueue({
    chatId: bound.chatId,
    threadId: bound.threadId || undefined,
    text: formatEvent(resolved, bound.threadId ? {} : { withTarget: bound.display }),
    parseMode: 'HTML',
  });

  return { bound: true };
}
