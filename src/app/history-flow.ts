/**
 * 接手补历史（D12 / modules.md §4.10 history-flow）。
 * 把 provider 原生 transcript **一次性投影**到当前 Topic —— 不是另开历史数据库。
 */
import type { AppContext } from './context.ts';
import { CB } from './context.ts';
import type { Binding } from '../core/bind-store.ts';
import type { InlineButton } from '../core/egress-queue.ts';
import { logger } from '../infra/logger.ts';
import { getProvider } from '../providers/registry.ts';
import type { AgentProvider, HistoryResult } from '../providers/types.ts';
import { escapeHtml, formatHistory, historyHeader, layoutHistoryPages } from '../telegram/format.ts';
import { t } from '../i18n.ts';

const log = logger('history-flow');

/** 分页浏览的默认每页条数 */
export const HISTORY_PAGE_SIZE = 10;
/** 分页最多往回翻这么多条 —— 再早的历史读文件代价与展示价值都不划算 */
const HISTORY_WINDOW = 400;

function mirrorCapable(binding: Binding): AgentProvider | { message: string } {
  const provider = getProvider(binding.providerId);
  if (!provider) return { message: `未知 provider: ${binding.providerId}` };
  if (!provider.capabilities.nativeTranscript || !provider.fetchHistory) {
    return { message: `${provider.displayName} 不支持读取会话记录。` };
  }
  return provider;
}

async function fetchFor(
  provider: AgentProvider,
  binding: Binding,
  limit: number,
): Promise<HistoryResult | { message: string }> {
  try {
    return await provider.fetchHistory!(
      {
        paneId: binding.paneId,
        sessionId: binding.sessionId,
        transcriptPath: binding.transcriptPath,
        cwd: binding.cwd,
      },
      { limit },
    );
  } catch (err) {
    log.warn('fetchHistory 失败', err);
    return { message: `读取历史失败：${err instanceof Error ? err.message : err}` };
  }
}

export type HistoryOutcome =
  | { ok: true; count: number }
  | { ok: false; message: string };

export async function syncHistory(
  ctx: AppContext,
  binding: Binding,
  limit: number,
): Promise<HistoryOutcome> {
  const provider = mirrorCapable(binding);
  if ('message' in provider) return { ok: false, message: provider.message };

  const result = await fetchFor(provider, binding, limit);
  if ('message' in result) return { ok: false, message: result.message };

  if (!result.items.length) {
    return {
      ok: false,
      message: t('history-none'),
    };
  }

  const threadId = binding.threadId || undefined;

  await ctx.egress.enqueue({
    chatId: binding.chatId,
    threadId,
    text: historyHeader(result.items.length, result.source),
    parseMode: 'HTML',
  });

  for (const chunk of formatHistory(result.items)) {
    await ctx.egress.enqueue({
      chatId: binding.chatId,
      threadId,
      text: chunk,
      parseMode: 'HTML',
    });
  }

  await ctx.egress.enqueue({
    chatId: binding.chatId,
    threadId,
    text: t('history-divider'),
  });

  return { ok: true, count: result.items.length };
}

export type HistoryPageView =
  | {
      ok: true;
      text: string;
      buttons: InlineButton[][];
      page: number;
      pages: number;
      /** 这次读到的总条数 */
      total: number;
      /** 比 seen 多出来的条数（没给 seen 就是 0） */
      fresh: number;
    }
  | { ok: false; message: string };

/**
 * 分页浏览历史（无状态）：每次翻页都重读 transcript 再切片，
 * 按钮里只带「页码 + 每页条数」—— 服务重启后旧消息上的按钮照样能用。
 *
 * @param pageReq 1 起算的页码；0 表示尾页（最新一页）。越界自动收敛。
 * @param seen 刷新键按下时带回来的「上次看到多少条」，用来算这次多出几条。
 */
export async function buildHistoryPage(
  binding: Binding,
  pageReq: number,
  size: number,
  seen?: number,
): Promise<HistoryPageView> {
  const provider = mirrorCapable(binding);
  if ('message' in provider) return { ok: false, message: provider.message };

  const result = await fetchFor(provider, binding, HISTORY_WINDOW);
  if ('message' in result) return { ok: false, message: result.message };

  // 补历史只留对话：工具调用/输出/思考是实时镜像的活儿，翻页视图放它们会把页数撑爆
  const items = result.items.filter((i) => i.kind === 'message' || !i.kind);
  const layout = layoutHistoryPages(items, { size });
  if (!layout.length) return { ok: false, message: t('history-none') };

  const pages = layout.length;
  const page = pageReq <= 0 ? pages : Math.min(Math.max(pageReq, 1), pages);
  const cur = layout[page - 1]!;

  const total = items.length;
  const atWindowCap = total >= HISTORY_WINDOW;
  const header = t('history-page-header', {
    page,
    pages,
    label: cur.label,
    total: `${total}${atWindowCap ? '+' : ''}`,
  });
  const source = result.source ? `\n<i>${escapeHtml(result.source)}</i>` : '';

  // 翻页按钮不做禁用态（Telegram 没有）：边界上点⏮/◀ 会编辑出相同内容，
  // egress 对 not modified 静默成功，体感就是「没动」
  //
  // 中间那键是刷新：本来就每次重读 transcript，只是从前看着像个页码指示器。
  // 带上 total 当基线，下次按下就能报「多了几条」；停在尾页时翻成 0，
  // 这样新记录把页数顶上去了也还跟着最新一页。只有它带第四段 —— 翻页键不需要报数。
  const atLatest = page === pages;
  const nav: InlineButton[] = [
    { text: '⏮', callbackData: CB.historyPage(1, size) },
    { text: '◀', callbackData: CB.historyPage(Math.max(1, page - 1), size) },
    {
      text: `🔄 ${page}/${pages}`,
      callbackData: CB.historyPage(atLatest ? 0 : page, size, total),
    },
    { text: '▶', callbackData: CB.historyPage(Math.min(pages, page + 1), size) },
    { text: '⏭', callbackData: CB.historyPage(0, size) },
  ];

  return {
    ok: true,
    text: `${header}${source}\n\n${cur.body}`,
    buttons: [nav],
    page,
    pages,
    total,
    fresh: seen === undefined ? 0 : Math.max(0, total - seen),
  };
}
