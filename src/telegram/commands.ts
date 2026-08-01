/** 命令与消息路由 → app/*。这里只做参数解析和回话，不含业务逻辑。 */
import type { Bot, Context } from 'grammy';
import type { Message, ReplyKeyboardMarkup } from 'grammy/types';
import type { AppContext } from '../app/context.ts';
import { CB, parseCallback } from '../app/context.ts';
import {
  bindPane,
  forgetBinding,
  pruneStaleBindings,
  sendAgentList,
  unbind,
} from '../app/bind-flow.ts';
import { handleUserText } from '../app/chat-flow.ts';
import { resolveDecision } from '../app/decision-flow.ts';
import { buildHistoryPage, HISTORY_PAGE_SIZE, syncHistory } from '../app/history-flow.ts';
import type { NotifyLevel } from '../config.ts';
import type { InlineButton } from '../core/egress-queue.ts';
import { displayOf, paneAlive } from '../infra/tmux.ts';
import { logger } from '../infra/logger.ts';
import { formatBindingStatus } from './format.ts';

const log = logger('commands');

/**
 * 工位键：话题消息取 message_thread_id，其余一律 0。
 *
 * 不要按 chat.type 或 getChat 的 is_forum 去判断「这个 chat 有没有话题」——
 * BotFather 里给 Bot 开了 threads 的私聊照样有话题，但那两个字段都不体现。
 * is_topic_message 才是可靠信号。
 *
 * threadId === 0 表示命令台（All / General），或没有话题能力时的单工位降级。
 */
export function threadIdOf(msg: Message | undefined): number {
  if (!msg) return 0;
  return msg.is_topic_message ? (msg.message_thread_id ?? 0) : 0;
}

function chatIdOf(ctx: Context): string | null {
  const id = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  return id === undefined ? null : String(id);
}

/** 引用别太长：agent 要的是上下文定位，不是整段重放 */
const QUOTE_MAX = 600;

/**
 * 用户 reply 某条消息时，把被引用的内容取出来（`> ` 前缀的引用块）。
 *
 * 两个坑：
 * - 话题里**每条**消息技术上都是对话题根消息的 reply（forum 的实现机制），
 *   reply_to 的 message_id 等于 threadId 时不是用户的引用，必须忽略；
 * - 用户可以「部分引用」（选中一段再回复），那时优先带他选的那段（msg.quote）。
 */
export function quotedReply(msg: Message, threadId: number): string | null {
  const re = msg.reply_to_message;
  if (!re || re.message_id === threadId) return null;

  const raw = (msg.quote?.text ?? re.text ?? re.caption ?? '').trim();
  if (!raw) return null;

  const clipped = raw.length > QUOTE_MAX ? raw.slice(0, QUOTE_MAX - 1) + '…' : raw;
  return clipped
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

async function reply(ctx: Context, text: string, parseMode: 'HTML' | undefined = 'HTML'): Promise<void> {
  const threadId = threadIdOf(ctx.message ?? ctx.callbackQuery?.message);
  await ctx.reply(text, {
    ...(threadId ? { message_thread_id: threadId } : {}),
    ...(parseMode ? { parse_mode: parseMode } : {}),
    link_preview_options: { is_disabled: true },
  });
}

const START_TEXT = [
  '<b>agent-remote</b> · tmux 里的 agent 遥控器',
  '',
  '/agents 选择并绑定，之后在其话题内直接输入。',
  '默认全量转播，可用 /notify 调整。',
  '绑定前的记录可用 /history 同步。',
].join('\n');

/**
 * 输入框下面那排常驻按钮。
 *
 * **chat 级，不是 thread 级** —— 实测给某个话题单独设一套，话题里显示的仍是
 * 最后一次设置的那套。所以只能有一套，放两个到哪儿都用得上的命令，
 * 别占太多打字空间。
 *
 * 按钮点下去是把**文字当消息发出去**，所以内容必须以 `/` 开头：
 * `message:text` 那条 `if (text.startsWith('/')) return` 才会放行给命令处理器，
 * 否则会被当成给 agent 的话直接写进 pane。中文标签在这里是不能用的。
 */
const COMMAND_KEYBOARD: ReplyKeyboardMarkup = {
  keyboard: [[{ text: '/agents' }, { text: '/notify' }]],
  resize_keyboard: true, // 压到最矮，别占半屏
  is_persistent: true, // 一直显示，不是发一次就收
  input_field_placeholder: '输入即发送给绑定的 agent',
};

const NOTIFY_LABEL: Record<NotifyLevel, string> = {
  info: '📢 全量转播',
  important: '🔔 只推完成 / 等待 / 授权 / 失败',
  off: '🔇 静音',
};

const NOTIFY_HELP = [
  '📢 <b>info</b> 全量，含 agent 每条回复',
  '🔔 <b>important</b> 只推完成 / 等待 / 授权 / 失败',
  '🔇 <b>off</b> 不推',
].join('\n');

function notifyLevelButtons(current: NotifyLevel): InlineButton[] {
  const mark = (l: NotifyLevel, text: string): string => (l === current ? `✅ ${text}` : text);
  return [
    { text: mark('info', '📢 全量'), callbackData: CB.notifyLevel('info') },
    { text: mark('important', '🔔 只推要事'), callbackData: CB.notifyLevel('important') },
    { text: mark('off', '🔇 静音'), callbackData: CB.notifyLevel('off') },
  ];
}

/**
 * 就地刷新 /agents 列表。
 *
 * 凡是改变了绑定状态的回调都得调它 —— 尤其是失败/复用这些提前 return 的分支，
 * 那些恰恰是「列表正在说谎」的时刻（点了 ➕ 才发现已绑、pane 其实已经没了）。
 * 刷不动就算了（消息被删、内容没变），绝不能让它把主流程拖垮。
 */
async function refreshList(
  app: AppContext,
  ctx: Context,
  chatId: string,
  threadId: number,
): Promise<void> {
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (!messageId) return;
  await sendAgentList(app, {
    chatId,
    threadId: threadId || undefined,
    editMessageId: messageId,
  }).catch(() => undefined);
}

export function registerHandlers(bot: Bot, app: AppContext): void {
  // /start 顺带把底部键盘装上。设一次就常驻，不用每条消息都重发 ——
  // 重发会把用户收起来的键盘又弹开。
  bot.command('start', async (ctx) => {
    const threadId = threadIdOf(ctx.message);
    await ctx.reply(START_TEXT, {
      ...(threadId ? { message_thread_id: threadId } : {}),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: COMMAND_KEYBOARD,
    });
  });

  bot.command('agents', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId) return;
    const threadId = threadIdOf(ctx.message);
    await sendAgentList(app, { chatId, threadId: threadId || undefined });
  });

  bot.command('unbind', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId) return;
    const threadId = threadIdOf(ctx.message);
    const outcome = await unbind(app, { chatId, threadId });
    if (!outcome) {
      await reply(ctx, '此话题未绑定。');
      return;
    }

    const head = `🔓 已解绑 <code>${outcome.removed.paneId}</code>`;

    if (outcome.topicClosed || !threadId) {
      await reply(ctx, head);
      return;
    }
    // 私聊话题不支持「关闭」，只能删。删会连消息一起清掉，所以交给用户点。
    await app.egress.enqueue({
      chatId,
      threadId,
      text: `${head}\n/rebind 可恢复。`,
      parseMode: 'HTML',
      buttons: [[{ text: '🗑 删除话题', callbackData: CB.topicDelete(threadId) }]],
    });
  });

  /**
   * 把这个话题绑回它上次那个 pane。
   *
   * 解绑之后话题还在，但 Bot 已经忘了它属于谁 —— 这个命令读的就是解绑时
   * 留下的那条 released 记录，省得你去 /agents 里重新认一遍。
   *
   * pane 已经没了的话，这个话题就是个死胡同：它的 agent 不存在了，也没法恢复。
   * 那种情况下直接连话题一起删掉（**记录会一起没**，这是你指定的行为）。
   */
  bot.command('rebind', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId) return;
    const threadId = threadIdOf(ctx.message);

    if (!threadId) {
      await reply(ctx, '/rebind 需在工位话题内使用。');
      return;
    }

    const current = app.store.getByThread(chatId, threadId);
    if (current) {
      await reply(ctx, `已绑定 <code>${current.paneId}</code>。`);
      return;
    }

    const last = app.store.getReleased(chatId, threadId);
    if (!last) {
      await reply(ctx, '无可恢复的记录，请用 /agents 选择。');
      return;
    }

    const outcome = await bindPane(app, { chatId, currentThreadId: threadId, paneId: last.paneId });

    if (outcome.ok) {
      app.store.clearReleased(chatId, threadId);
      log.info('rebind 成功', { paneId: last.paneId, threadId });
      await reply(
        ctx,
        `✅ 绑回 <code>${outcome.binding.paneId}</code> · ${outcome.binding.providerId} · ` +
          `<code>${outcome.binding.display}</code>`,
      );
      return;
    }

    // pane 没了 —— 这个话题的 agent 已经不存在，留着也没用了
    log.info('rebind 失败，pane 已消失，删除话题', { paneId: last.paneId, threadId });
    app.store.clearReleased(chatId, threadId);

    // 先往主聊天流留一条再删：删话题会清掉里面所有消息，
    // 要是把整个会话删空了，客户端会把对话从列表里移除，得重新搜出来。
    await app.egress
      .enqueue({
        chatId,
        text: `🗑 <code>${last.paneId}</code> 已不存在，话题「${last.title}」一并删除。`,
        parseMode: 'HTML',
      })
      .catch(() => undefined);

    const ok = await app.topics.deleteTopic(chatId, threadId);
    if (!ok) {
      await reply(ctx, `<code>${last.paneId}</code> 已不存在。话题删除失败，请手动长按删除。`);
    }
  });

  // 主动探一遍所有绑定的话题还在不在。会在活着的话题里留一条「话题已修改」——
  // 那是唯一能探出删除的手段，所以做成手动命令而不是定时任务。
  bot.command('cleanup', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId) return;

    const total = app.store.list(chatId).length;
    if (!total) {
      await reply(ctx, '无绑定。');
      return;
    }

    await reply(ctx, `核对 ${total} 条…（存活话题会多出一条「话题已修改」，忽略即可）`);
    const { checked, removed } = await pruneStaleBindings(app, chatId);

    if (!removed.length) {
      await reply(ctx, `✅ ${checked} 个话题均存在。`);
      return;
    }

    const lines = [
      `🧹 已清理 ${removed.length} 条（核对 ${checked} 个）：话题已删除`,
      ...removed.map((b) => `· <code>${b.paneId}</code> ${b.providerId}`),
    ];
    await reply(ctx, lines.join('\n'));
  });

  bot.command('status', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId) return;
    const binding = app.store.getByThread(chatId, threadIdOf(ctx.message));
    if (!binding) {
      await reply(ctx, '未绑定，请用 /agents 选择。');
      return;
    }
    const [alive, display] = await Promise.all([
      paneAlive(binding.paneId),
      displayOf(binding.paneId),
    ]);
    if (display && display !== binding.display) {
      app.store.patch(binding.chatId, binding.threadId, { display });
    }
    await reply(ctx, formatBindingStatus(binding, alive, display));
  });

  // 分页浏览：/history [每页条数]，从尾页（最新）进入，按钮翻页
  bot.command('history', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId) return;
    const threadId = threadIdOf(ctx.message);
    const binding = app.store.getByThread(chatId, threadId);
    if (!binding) {
      await reply(ctx, '请先绑定：/agents');
      return;
    }
    const arg = Number((ctx.match as string | undefined)?.trim());
    const size = Number.isFinite(arg) && arg > 0 ? Math.min(arg, 50) : HISTORY_PAGE_SIZE;

    const view = await buildHistoryPage(binding, 0, size);
    if (!view.ok) {
      await reply(ctx, view.message);
      return;
    }
    await app.egress.enqueue({
      chatId,
      threadId: threadId || undefined,
      text: view.text,
      parseMode: 'HTML',
      buttons: view.buttons,
    });
  });

  // 推送级别是唯一的开关 —— 只出菜单点选，不吃参数（带了参数也一律忽略）
  bot.command('notify', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId) return;
    const threadId = threadIdOf(ctx.message);
    const binding = app.store.getByThread(chatId, threadId);
    if (!binding) {
      await reply(ctx, '未绑定。');
      return;
    }

    await app.egress.enqueue({
      chatId,
      threadId: threadId || undefined,
      text: `当前 <b>${NOTIFY_LABEL[binding.notifyLevel]}</b>\n\n${NOTIFY_HELP}`,
      parseMode: 'HTML',
      buttons: [notifyLevelButtons(binding.notifyLevel)],
    });
  });

  // 未绑定话题里的普通文本 → 提示；已绑定 → 直接注入 pane
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // 未知命令不当消息发给 agent

    const chatId = chatIdOf(ctx);
    if (!chatId) return;

    const threadId = threadIdOf(ctx.message);
    // reply 的引用不在 text 里 —— 不带上的话 agent 只见回话不见上下文
    const quoted = quotedReply(ctx.message, threadId);
    const result = await handleUserText(app, {
      chatId,
      threadId,
      text: quoted ? `${quoted}\n${text}` : text,
    });

    if (!result.ok) {
      // 命令台（All / General）里没有绑定是正常的 —— 那里只该发命令。
      // 降级模式下 threadId 0 是真工位，会走到上面的成功分支，不会到这儿。
      if (result.reason === 'no_binding' && threadId === 0) {
        await reply(ctx, '命令台仅接受命令，请在话题内与 agent 对话。');
        return;
      }
      // 这个话题以前绑过 → 直接告诉他一条命令就能回来，别让他去 /agents 里重认
      const last = result.reason === 'no_binding' ? app.store.getReleased(chatId, threadId) : null;
      await reply(
        ctx,
        last
          ? `未绑定。上次为 <code>${last.paneId}</code>，/rebind 恢复，或 /agents 更换。`
          : result.message,
      );
      return;
    }
    if (result.acked) {
      await ctx.react('👌').catch(() => undefined);
    }
  });

  // 关掉 Topic = 收工。接管来的 pane 只解绑，绝不 kill（design.md §4.2 / ownership）
  bot.on('message:forum_topic_closed', async (ctx) => {
    const chatId = chatIdOf(ctx);
    const threadId = ctx.message.message_thread_id ?? 0;
    if (!chatId || !threadId) return;

    const removed = app.store.getByThread(chatId, threadId);
    if (!removed) return;
    // pane 还活着，只是收工；留在索引里，重开话题还能绑回来
    forgetBinding(app, removed, { keepIndex: true, remember: true });
    log.info('Topic 已关闭，解绑', { paneId: removed.paneId, threadId });
  });

  // 重开 Topic 不自动恢复绑定：pane 可能早就不是原来那个了
  bot.on('message:forum_topic_reopened', async (ctx) => {
    const chatId = chatIdOf(ctx);
    const threadId = ctx.message.message_thread_id ?? 0;
    if (!chatId || !threadId) return;
    if (app.store.getByThread(chatId, threadId)) return;

    await app.egress
      .enqueue({
        chatId,
        threadId,
        text: '已解绑。/rebind 可恢复。',
      })
      .catch(() => undefined);
  });

  // 用户改了 Topic 名 → 同步缓存，/status 显示才不会对不上
  bot.on('message:forum_topic_edited', async (ctx) => {
    const chatId = chatIdOf(ctx);
    const threadId = ctx.message.message_thread_id ?? 0;
    const name = ctx.message.forum_topic_edited.name;
    if (!chatId || !threadId || !name) return;
    app.store.patch(chatId, threadId, { title: name });
  });

  bot.on('callback_query:data', async (ctx) => {
    const chatId = chatIdOf(ctx);
    const data = ctx.callbackQuery.data;
    const parsed = parseCallback(data);
    if (!chatId || !parsed) {
      await ctx.answerCallbackQuery({ text: '无法识别的操作' }).catch(() => undefined);
      return;
    }

    const threadId = threadIdOf(ctx.callbackQuery.message);

    try {
      switch (parsed.kind) {
        case 'refresh': {
          await ctx.answerCallbackQuery({ text: '刷新中…' });
          await refreshList(app, ctx, chatId, threadId);
          return;
        }

        case 'bind': {
          const outcome = await bindPane(app, {
            chatId,
            currentThreadId: threadId,
            paneId: parsed.paneId,
          });

          // 一律用顶部 toast（不带 show_alert）：自己飘一下就没，不打断动作。
          // show_alert 是个要点「确定」的模态框 —— 绑定这种顺手操作不配拦一次点击。
          if (outcome.ok && outcome.reused) {
            await ctx.answerCallbackQuery({ text: `已绑定至 ${outcome.binding.title}` });
            // 能走到这儿说明列表把已绑的显示成了 ➕，正是该刷新的时候
            await refreshList(app, ctx, chatId, threadId);
            return;
          }

          await ctx.answerCallbackQuery({
            text: outcome.ok ? `✅ ${outcome.binding.title}` : '绑定失败',
          });

          if (!outcome.ok) {
            await app.egress.enqueue({
              chatId,
              threadId: threadId || undefined,
              text: `❌ ${outcome.error}`,
              parseMode: 'HTML',
            });
            // 多半是 pane 已经退出了 —— 刷新把它从列表里去掉
            await refreshList(app, ctx, chatId, threadId);
            return;
          }

          const b = outcome.binding;

          // 列表就地刷新成新状态（那一行变 🔗/🔓），别把列表换成一条回执 ——
          // 换掉的话想再绑第二个还得重发 /agents。
          await refreshList(app, ctx, chatId, threadId);

          const lines = [
            `✅ 已绑定 <code>${b.paneId}</code> · ${b.providerId} · <code>${b.display}</code>`,
          ];
          if (outcome.degraded) {
            lines.push('', '⚠️ 此会话不支持 Topics，消息均在主聊天流。');
          }
          if (outcome.replaced) {
            lines.push('', 'ℹ️ 已从其他话题迁移。');
          }

          await app.egress.enqueue({
            chatId,
            threadId: b.threadId || undefined,
            text: lines.join('\n'),
            parseMode: 'HTML',
            buttons: [
              [
                {
                  // h:（入口）会新发一条分页视图；hp:（导航）才原地编辑，
                  // 绝不能让这颗按钮把绑定回执本身改写掉
                  text: '📜 浏览历史',
                  callbackData: CB.history(HISTORY_PAGE_SIZE),
                },
              ],
            ],
          });

          if (app.config.syncHistoryOnBind) {
            const r = await syncHistory(app, b, app.config.historyDefaultLimit);
            if (!r.ok) {
              await app.egress.enqueue({
                chatId,
                threadId: b.threadId || undefined,
                text: r.message,
              });
            }
          }
          return;
        }

        case 'history': {
          // 旧消息上遗留的一次性投影按钮：兼容为打开分页视图（尾页）
          await ctx.answerCallbackQuery({ text: '读取中…' });
          const binding = app.store.getByThread(chatId, threadId);
          if (!binding) {
            await app.egress.enqueue({
              chatId,
              threadId: threadId || undefined,
              text: '未绑定。',
            });
            return;
          }
          const size = Math.min(Math.max(parsed.limit, 1), 50);
          const view = await buildHistoryPage(binding, 0, size);
          await app.egress.enqueue({
            chatId,
            threadId: threadId || undefined,
            text: view.ok ? view.text : view.message,
            parseMode: view.ok ? 'HTML' : undefined,
            buttons: view.ok ? view.buttons : undefined,
          });
          return;
        }

        case 'history-page': {
          const binding = app.store.getByThread(chatId, threadId);
          if (!binding) {
            await ctx.answerCallbackQuery({ text: '未绑定' });
            return;
          }
          const view = await buildHistoryPage(binding, parsed.page, parsed.size);
          if (!view.ok) {
            await ctx.answerCallbackQuery({ text: view.message.slice(0, 190) });
            return;
          }
          const messageId = ctx.callbackQuery.message?.message_id;
          await app.egress.enqueue({
            chatId,
            threadId: threadId || undefined,
            text: view.text,
            parseMode: 'HTML',
            buttons: view.buttons,
            // 点的是消息上的按钮就原地编辑；拿不到消息 id（理论不该发生）才新发
            editMessageId: messageId,
          });
          await ctx.answerCallbackQuery();
          return;
        }

        case 'notify-level': {
          const binding = app.store.getByThread(chatId, threadId);
          if (!binding) {
            await ctx.answerCallbackQuery({ text: '未绑定' });
            return;
          }
          app.store.patch(chatId, threadId, { notifyLevel: parsed.level });
          await ctx.answerCallbackQuery({ text: NOTIFY_LABEL[parsed.level] });
          // 选完即焚：级别面板是一次性交互，结果已在 toast 里，
          // 留着只会占屏、日后被误点。删除失败（超 48h 等）就随它去。
          const panel = ctx.callbackQuery.message;
          if (panel) {
            await ctx.api.deleteMessage(panel.chat.id, panel.message_id).catch(() => undefined);
          }
          return;
        }

        // 列表里点已绑定的行：只断开，话题原样留着（历史都在里面）
        case 'unbind': {
          const target = app.store.getByThread(chatId, parsed.threadId);
          if (!target) {
            // 多半是连点了两下，第一下已经解完了 —— 刷新列表把真实状态给他看
            await ctx.answerCallbackQuery({ text: '已解绑' });
          } else {
            // remember：话题还在，发 /rebind 就能绑回来
            forgetBinding(app, target, { keepIndex: true, remember: true });
            log.info('列表里解绑', { paneId: target.paneId, threadId: parsed.threadId });
            await ctx.answerCallbackQuery({ text: `🔓 ${target.paneId}` });
          }
          await refreshList(app, ctx, chatId, threadId);
          return;
        }

        case 'topic-delete': {
          const target = app.store.getByThread(chatId, parsed.threadId);
          await ctx.answerCallbackQuery({
            text: target ? `解绑 ${target.paneId} 并删除话题…` : '删除中…',
          });
          // 还绑着就先解绑，别留下悬空绑定。
          // 注意不走 unbind()：那里会按 closeTopicOnUnbind 先试着「关闭」话题，
          // 而我们下一步就是删它 —— 白调一次 API，私聊里还必然报
          // 「not a supergroup forum」刷一行错误日志。
          if (target) forgetBinding(app, target, { keepIndex: true });

          // 关键顺序：先往主聊天流留一条，再删。
          // 删话题会连带清掉里面的消息；要是这一删让整个对话空了，
          // Telegram 客户端会把这个会话当空对话从列表里移除，得重新搜出来。
          await app.egress
            .enqueue({
              chatId,
              text: '🗑 话题已删除。',
            })
            .catch(() => undefined);

          const ok = await app.topics.deleteTopic(chatId, parsed.threadId);
          if (!ok) {
            await app.egress
              .enqueue({ chatId, text: '话题删除失败，请手动长按删除。' })
              .catch(() => undefined);
          }

          // 就地刷新列表。前提是这条列表消息本身不在刚删掉的话题里 ——
          // 在的话它已经跟着消息一起没了，编辑必然失败。
          if (threadId !== parsed.threadId) {
            await refreshList(app, ctx, chatId, threadId);
          }
          return;
        }

        case 'decision': {
          const r = await resolveDecision(app, {
            correlationId: parsed.correlationId,
            decisionId: parsed.decisionId,
          });
          await ctx.answerCallbackQuery({ text: r.ok ? r.note : r.message });
          return;
        }
      }
    } catch (err) {
      log.error('callback 处理失败', err);
      await ctx.answerCallbackQuery({ text: '处理失败，详见日志' }).catch(() => undefined);
    }
  });

  bot.catch((err) => {
    log.error('bot 未捕获异常', err.error);
  });
}
