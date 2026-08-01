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
import { escapeHtml, formatEvent } from '../telegram/format.ts';
import { t } from '../i18n.ts';

const log = logger('notify-flow');

/** 这些事件意味着 agent 停下来了：完成/失败/会话结束/等输入/等授权/提问 */
const STOP_TYPING_EVENTS = new Set<NormalizedEvent['type']>([
  'completed',
  'failed',
  'ended',
  'waiting',
  'permission',
  'question',
]);

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

/** 建 pending 并推按钮；返回是否真的建立了待决策（ingress 据此才 hold hook）。 */
async function emitDecision(
  ctx: AppContext,
  bound: Binding,
  event: NormalizedEvent & { correlationId: string },
): Promise<boolean> {
  const provider = getProvider(event.providerId);
  const ui = provider?.buildDecisionUi?.(event);
  if (!ui) return false;

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
    text: t('perm-title', { prompt: escapeHtml(ui.prompt) }),
    parseMode: 'HTML',
    buttons,
  });

  ctx.broker.attachMessage(event.correlationId, {
    chatId: bound.chatId,
    threadId: bound.threadId || undefined,
    messageId,
  });
  return true;
}

/**
 * 返回值给 ingress 用：
 * `bound: false` = 事件没有对应绑定；
 * `held: true`  = 已建 pending 并推了按钮，这次 hook 请求应该被 hold 住等决策。
 * 两者必须分开 —— 「绑定了」不代表「建了待决策」，按 bound hold 会让 hook 白等 90s。
 */
export async function handleEvent(
  ctx: AppContext,
  event: NormalizedEvent,
): Promise<{ bound: boolean; held: boolean }> {
  const paneId = await resolvePaneId(ctx, event);
  const resolved: NormalizedEvent = paneId ? { ...event, paneId } : event;

  ctx.index.noteEvent({
    paneId: resolved.paneId,
    providerId: resolved.providerId,
    sessionId: resolved.sessionId,
    cwd: resolved.cwd,
  });

  // 没绑定就什么都不做 —— 不推送、不打扰。这个 agent 你没托管给 Bot，
  // 它在终端上自己跑自己的（阻塞式 hook 也不 hold，见 handleEvent 的返回值）。
  const binding = findBinding(ctx, resolved);
  if (!binding) {
    log.debug('事件无对应绑定，忽略', { type: resolved.type, paneId: resolved.paneId });
    return { bound: false, held: false };
  }

  const bound = refreshBindingFacts(ctx, binding, resolved);

  // 事件驱动镜像：hook 一响就去追 transcript 增量，不等兜底轮询。
  // 放在 refreshBindingFacts 之后 —— 让这轮镜像用上刚更新的 transcriptPath。
  ctx.mirror?.kick();

  // agent 停下来了（干完/出错/等人）→「正在输入…」熄灭。
  // 放在策略过滤之前：事件即使被压制不推送，typing 也必须停。
  if (STOP_TYPING_EVENTS.has(resolved.type)) {
    ctx.typing?.stop(bound.chatId, bound.threadId || undefined);
  }

  // 阻塞式授权：先建 pending，再推按钮；策略层不参与（永远要推）
  if (resolved.blocking && resolved.correlationId) {
    const provider = getProvider(resolved.providerId);
    if (provider?.capabilities.semanticPermission && provider.buildDecisionUi) {
      const held = await emitDecision(
        ctx,
        bound,
        resolved as NormalizedEvent & { correlationId: string },
      );
      return { bound: true, held };
    }
    log.warn('provider 不支持结构化授权，按普通事件处理', { providerId: resolved.providerId });
  }

  // 镜像**真的在工作**时，completed / output 这类事件的内容是重复的。
  // 必须问 watcher 的事实信号而不是 provider 的 capability ——
  // 镜像失明（文件定位失败）时按能力判断会连唯一的通知也吞掉，用户什么都收不到。
  const mirrored =
    bound.notifyLevel === 'info' && (ctx.mirror?.isMirroring(bound.paneId) ?? false);

  const decision = shouldEmit({
    event: resolved,
    mirrored,
    level: bound.notifyLevel,
  });

  if (!decision.emit) {
    log.debug('事件被策略丢弃', { type: resolved.type, reason: decision.reason });
    return { bound: true, held: false };
  }

  await ctx.egress.enqueue({
    chatId: bound.chatId,
    threadId: bound.threadId || undefined,
    text: formatEvent(resolved, bound.threadId ? {} : { withTarget: bound.display }),
    parseMode: 'HTML',
  });

  return { bound: true, held: false };
}
