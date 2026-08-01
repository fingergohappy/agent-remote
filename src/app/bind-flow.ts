/** /agents → 选 pane → ensure Topic → 写 bind（modules.md §4.10）。 */
import type { AppContext } from './context.ts';
import { CB } from './context.ts';
import type { Binding } from '../core/bind-store.ts';
import { computeFingerprint } from '../core/bind-store.ts';
import {
  discover,
  instanceTitle,
  projectLabel,
  sortForDisplay,
  verifyPresence,
  type AgentInstance,
} from '../core/discover.ts';
import type { InlineButton } from '../core/egress-queue.ts';
import { listPanes } from '../infra/tmux.ts';
import { snapshotProcesses } from '../infra/process-tree.ts';
import { formatAgentList } from '../telegram/format.ts';
import { logger } from '../infra/logger.ts';
import { t } from '../i18n.ts';

const log = logger('bind-flow');

/**
 * 清掉一条绑定，连同它散落在各处的 per-pane 状态。
 *
 * 这五处缓存在不同对象里，漏掉任何一个都不报错，只会在很久之后表现成
 * 「pane 换人了还在投」或「镜像从早就换掉的 offset 接着读」。曾经漏过 mirror，
 * 所以收敛成一个函数，别再让四个调用点各抄一遍。
 *
 * `keepIndex`：pane 本身还活着（比如只是解绑），就别把它从 discover 索引里删掉，
 * 否则 /agents 列表会短暂看不到它。
 *
 * `remember`：用户**主动**解绑时开，记下「这个话题上次绑的是谁」，供 /rebind 还原。
 * pane 死掉那种不开 —— 那个 pane 已经不存在，记了也恢复不了。
 */
export function forgetBinding(
  ctx: AppContext,
  binding: Binding,
  opts: { keepIndex?: boolean; remember?: boolean } = {},
): void {
  if (opts.remember) ctx.store.noteReleased(binding);
  ctx.store.remove(binding.chatId, binding.threadId);
  ctx.mirror?.forget(binding.paneId);
  ctx.echo.forget(binding.paneId);
  if (!opts.keepIndex) ctx.index.forget(binding.paneId);
}

export async function listAgents(ctx: AppContext): Promise<AgentInstance[]> {
  const instances = await discover({ sessionAllowlist: ctx.config.sessionAllowlist });
  ctx.index.upsertFromDiscover(instances);
  return instances;
}

/**
 * 列表按钮。
 *
 * 已经有话题的 agent 直接给 url 按钮 —— 这是唯一能一下点进话题的做法：
 * callback 按钮没法让客户端跳转（Bot API 没有这种能力），url 按钮可以。
 * 还没绑的只能是 callback，因为话题得先建出来才有链接可给。
 *
 * @param bound paneId → threadId（0 表示降级模式，没有话题可跳）
 */
export function agentButtons(
  instances: AgentInstance[],
  bound: ReadonlyMap<string, number>,
  opts: { disposableThreadId?: number; linkFor?: (threadId: number) => string | null } = {},
): InlineButton[][] {
  const rows: InlineButton[][] = instances.map((inst) => {
    const threadId = bound.get(inst.paneId);
    // 按钮位置金贵，只留「哪个 pane + 哪个项目」—— provider、完整路径、
    // 坐标都在上面的文字列表里，这里再重复一遍只会把按钮挤到换行
    const label = `${inst.paneId} · ${projectLabel(inst)}`;

    // 还没绑 → 点了建话题并绑上
    if (threadId === undefined) {
      return [{ text: `➕ ${label}`, callbackData: CB.bind(inst.paneId) }];
    }

    // 降级模式（整个会话一个工位）：没有话题可开也可删，维持幂等的绑定按钮
    if (!threadId) {
      return [{ text: `🔗 ${label}`, callbackData: CB.bind(inst.paneId) }];
    }

    // 已绑定：点它只断开绑定，**话题原样留着**（历史都在里面，D8）。
    // 要连话题一起清掉是另一个动作，得你在话题里 /unbind 后显式点删除。
    const link = opts.linkFor?.(threadId) ?? null;
    const release: InlineButton = {
      text: link ? '🔓' : `🔓 ${label}`,
      callbackData: CB.unbind(threadId),
    };
    return link ? [{ text: `🔗 ${label}`, url: link }, release] : [release];
  });

  const tail: InlineButton[] = [{ text: t('refresh'), callbackData: CB.refresh() }];
  // 在 All 里发消息时 Telegram 会自己开一个话题（客户端行为，Bot 拦不住）。
  // 这个话题还没绑 agent，给个一键清掉的出口，免得攒一堆空壳。
  if (opts.disposableThreadId) {
    tail.push({
      text: t('delete-empty-topic'),
      callbackData: CB.topicDelete(opts.disposableThreadId),
    });
  }
  rows.push(tail);
  return rows;
}

export async function sendAgentList(
  ctx: AppContext,
  target: { chatId: string; threadId?: number; editMessageId?: number },
): Promise<void> {
  // 排好序再往下传，文字列表和按钮共用同一个顺序，不会错位
  const instances = sortForDisplay(await listAgents(ctx));
  const bound = new Map(ctx.store.list(target.chatId).map((b) => [b.paneId, b.threadId]));

  // 当前所在话题还没绑 agent → 它多半是 Telegram 替这条命令临时开的
  const disposableThreadId =
    target.threadId && !ctx.store.getByThread(target.chatId, target.threadId)
      ? target.threadId
      : undefined;

  await ctx.egress.enqueue({
    chatId: target.chatId,
    threadId: target.threadId,
    editMessageId: target.editMessageId,
    text: formatAgentList(instances, bound, { disposableThread: Boolean(disposableThreadId) }),
    parseMode: 'HTML',
    buttons: instances.length
      ? agentButtons(instances, bound, {
          disposableThreadId,
          linkFor: (threadId) => ctx.topics.linkTo(target.chatId, threadId),
        })
      : disposableThreadId
        ? [[{ text: t('delete-empty-topic'), callbackData: CB.topicDelete(disposableThreadId) }]]
        : undefined,
  });
}

export type BindOutcome =
  | {
      ok: true;
      binding: Binding;
      created: boolean;
      degraded: boolean;
      replaced: Binding | null;
      /** 它本来就绑在这个话题上，这次什么都没变 */
      reused: boolean;
    }
  | { ok: false; error: string };

/**
 * 绑定一个 pane。
 * 当前已在某个未绑定的 Topic 里操作 → 绑到该 Topic；否则新建 Topic。
 */
export async function bindPane(
  ctx: AppContext,
  args: { chatId: string; currentThreadId?: number; paneId: string },
): Promise<BindOutcome> {
  const instances = await listAgents(ctx);
  const inst = instances.find((i) => i.paneId === args.paneId);
  if (!inst) {
    return { ok: false, error: `pane ${args.paneId} 不在可遥控列表中（可能已退出）` };
  }

  const title = instanceTitle(inst);

  let threadId = 0;
  let created = false;
  let degraded = false;

  const currentThread = args.currentThreadId ?? 0;

  // 在命令台点一个已经有工位的 agent → 它已经有家了，别再开一个。
  // 不挡住的话，每点一次就多一个话题、绑定迁过去，旧话题变孤儿。
  if (!currentThread) {
    const existing = ctx.store.list(args.chatId).find((b) => b.paneId === args.paneId);
    if (existing?.threadId) {
      // 但「记录里有」不等于「话题还在」——绑定是持久化的，话题可能早被删了，
      // 而删除没有事件（D17）。不探一下就复用，用户会被卡死：
      // 点它只弹提示不重绑，想 /unbind 又得在那个已经不存在的话题里发。
      const alive = await ctx.topics.verifyTopic(args.chatId, existing.threadId, existing.title);
      if (alive) {
        return {
          ok: true,
          binding: existing,
          created: false,
          degraded: false,
          replaced: null,
          reused: true,
        };
      }
      // 话题没了 → 清掉僵尸记录，往下走正常的新建流程
      log.info('复用前发现话题已删除，清理僵尸绑定', {
        paneId: existing.paneId,
        threadId: existing.threadId,
      });
      forgetBinding(ctx, existing);
    }
  }

  if (currentThread) {
    // 已经在某个话题里点的绑定 → 就地绑（相当于把这个工位换成另一个 agent），不再另开
    threadId = currentThread;
    await ctx.topics.renameTopic(args.chatId, threadId, title);
  } else {
    // 在命令台（All / General）点的绑定 → 一个 agent 一个话题
    const ensured = await ctx.topics.createTopic(args.chatId, title, inst.providerId);
    threadId = ensured.threadId;
    created = ensured.created;
    degraded = ensured.degraded;

    // 只有话题真的建不出来时，才退化成「整个会话一个工位」
    if (degraded) {
      const occupant = ctx.store.getByThread(args.chatId, 0);
      if (occupant && occupant.paneId !== args.paneId) {
        return {
          ok: false,
          error: `无法创建话题，仅支持绑定一个（当前 <code>${occupant.paneId}</code>）。请先 /unbind。`,
        };
      }
    }
  }

  const now = new Date().toISOString();
  const existing = ctx.store.getByThread(args.chatId, threadId);

  // 会话事实（sessionId / transcriptPath）跟着 **pane** 走，不跟话题走：
  // 绑定在话题间迁移时要继承，否则镜像与 /history 要退回 cwd 启发式直到下个 hook。
  // 但 provider 变了（pane 里换跑了别的 agent）就不能带 —— 那是旧 agent 的会话。
  const prior = ctx.store.getByPane(inst.paneId);
  const inherit = prior?.providerId === inst.providerId ? prior : null;

  const binding: Binding = {
    chatId: args.chatId,
    threadId,
    paneId: inst.paneId,
    fingerprint: computeFingerprint(inst.paneId, inst.pid, inst.providerId),
    providerId: inst.providerId,
    display: inst.display,
    title,
    ownedByUs: false, // 接管已有 pane，关 Topic 不 kill（D3 / prior-art 建议 9）
    cwd: inst.cwd,
    sessionId: inherit?.sessionId,
    transcriptPath: inherit?.transcriptPath,
    notifyLevel: existing?.notifyLevel ?? ctx.config.defaultNotifyLevel,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const { replaced } = ctx.store.upsert(binding);
  log.info('已绑定', { paneId: binding.paneId, threadId, chatId: args.chatId });

  return { ok: true, binding, created, degraded, replaced, reused: false };
}

export type UnbindOutcome = {
  removed: Binding;
  /** 话题是否被关掉；私聊话题不支持关闭，这里会是 false */
  topicClosed: boolean;
};

/**
 * 解绑。pane 本身不动（接管来的不归我们，D3 / prior-art 建议 9）。
 * 话题尽量关掉 —— 收工的意思，历史都还在，不是删除。
 */
export async function unbind(
  ctx: AppContext,
  args: { chatId: string; threadId: number },
): Promise<UnbindOutcome | null> {
  const removed = ctx.store.getByThread(args.chatId, args.threadId);
  if (!removed) return null;

  // pane 还活着，留在 discover 索引里，/agents 立刻还能看到它；
  // 同时记一笔，话题里发 /rebind 能一键绑回来
  forgetBinding(ctx, removed, { keepIndex: true, remember: true });
  log.info('已解绑', { paneId: removed.paneId, threadId: args.threadId });

  let topicClosed = false;
  if (ctx.config.closeTopicOnUnbind && args.threadId) {
    topicClosed = await ctx.topics.closeTopic(args.chatId, args.threadId).catch(() => false);
  }
  return { removed, topicClosed };
}

export type PruneResult = {
  checked: number;
  removed: Binding[];
};

/**
 * 手动清理失效绑定。
 *
 * 为什么必须是手动的：探活只有一个办法（带 name 的 editForumTopic），它会在
 * **活着**的话题里留一条「话题已修改」。放进 60s 对账就是每分钟刷一条屏。
 * 所以做成显式命令 —— 你要准确性，就付这一次痕迹，这个交换由你来做。
 *
 * pane 那一侧不用探：tmux 随便查，`reconcileBindings` 已经在定期做了。
 * 这里只解决话题那一侧 —— 那是唯一查不到的部分。
 */
export async function pruneStaleBindings(
  ctx: AppContext,
  chatId: string,
): Promise<PruneResult> {
  const removed: Binding[] = [];
  let checked = 0;

  for (const binding of ctx.store.list(chatId)) {
    if (!binding.threadId) continue; // 主聊天流不会消失，没什么可探的
    checked++;
    const alive = await ctx.topics.verifyTopic(chatId, binding.threadId, binding.title);
    if (alive) continue;

    forgetBinding(ctx, binding, { keepIndex: true }); // pane 还活着，留在列表里
    removed.push(binding);
    log.info('清理：话题已被删除', { paneId: binding.paneId, threadId: binding.threadId });
  }

  return { checked, removed };
}

/** 定期对账：pane 死了就解绑并通知（modules.md §8 步骤 6）。 */
export async function reconcileBindings(ctx: AppContext): Promise<void> {
  const bindings = ctx.store.list();
  if (!bindings.length) return;

  // 一轮 tmux + 一轮 ps，所有绑定共用快照
  const panes = await listPanes();
  const snap = await snapshotProcesses();

  for (const binding of bindings) {
    const state = await verifyPresence(binding, { panes, snap });
    if (state === 'ok') continue;
    // agent 退了但 pane 还在：可能马上会重启（Ctrl-C 后续跑），
    // 不拆绑定 —— send 路径已经挡住误发，这里拆了只会逼人反复重绑
    if (state === 'agent_gone') continue;

    forgetBinding(ctx, binding);

    const reason = state === 'pane_dead' ? 'pane 已消失' : 'pane 已被复用（指纹不符）';
    log.info('绑定失效，已清理', { paneId: binding.paneId, reason });

    await ctx.egress
      .enqueue({
        chatId: binding.chatId,
        threadId: binding.threadId || undefined,
        text: `⚠️ ${reason}，已解绑 <code>${binding.paneId}</code>。`,
        parseMode: 'HTML',
      })
      .catch(() => undefined);

    if (ctx.config.closeTopicOnUnbind && binding.threadId) {
      await ctx.topics.closeTopic(binding.chatId, binding.threadId).catch(() => undefined);
    }
  }
}

/**
 * 用户手动删掉了话题。
 *
 * Bot API 不推这个事件（删除会把话题里的消息一起清掉，通知本身也没了），
 * 所以只能等下次往它发消息时撞到 400 才知道。撞到了就把绑定清掉，
 * 免得后面每条消息都白试一遍。
 */
export async function handleThreadGone(
  ctx: AppContext,
  args: { chatId: string; threadId: number },
): Promise<void> {
  const removed = ctx.store.getByThread(args.chatId, args.threadId);
  if (!removed) return;

  // pane 没死，只是话题没了 —— 留在索引里，/agents 还能重新绑它
  forgetBinding(ctx, removed, { keepIndex: true });
  log.info('话题已被删除，自动解绑', { paneId: removed.paneId, threadId: args.threadId });

  // 话题没了，回执只能发到主聊天流
  await ctx.egress
    .enqueue({
      chatId: args.chatId,
      text: `🗑 话题已删，自动解绑 <code>${removed.paneId}</code>。`,
      parseMode: 'HTML',
    })
    .catch(() => undefined);
}

/**
 * 发送时撞上「话题已关闭」（TOPIC_CLOSED）。
 *
 * 白名单成员关话题会走 forum_topic_closed 事件正常解绑；但**非白名单成员**关的
 * 话题收不到事件（auth 中间件拦掉了 service message），只能在发送失败时补救。
 * 语义与 forum_topic_closed 对齐：解绑 + 记 released，pane 留在索引里。
 */
export async function handleTopicClosedOnSend(
  ctx: AppContext,
  args: { chatId: string; threadId: number },
): Promise<void> {
  const removed = ctx.store.getByThread(args.chatId, args.threadId);
  if (!removed) return;

  forgetBinding(ctx, removed, { keepIndex: true, remember: true });
  log.info('话题已关闭（发送失败发现），自动解绑', {
    paneId: removed.paneId,
    threadId: args.threadId,
  });

  await ctx.egress
    .enqueue({
      chatId: args.chatId,
      text: `🔒 话题已关闭，自动解绑 <code>${removed.paneId}</code>。/rebind 可恢复。`,
      parseMode: 'HTML',
    })
    .catch(() => undefined);
}
