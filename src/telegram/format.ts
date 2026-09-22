/**
 * NormalizedEvent / discover 结果 → 用户可见文案。
 * 只用公共字段；不碰 event.payload（provider 私有）。
 */
import { homedir } from 'node:os';
import type { AgentInstance } from '../core/discover.ts';
import type { Binding } from '../core/bind-store.ts';
import type { AgentEventType, HistoryItem, NormalizedEvent } from '../providers/types.ts';
import { t, type MsgKey } from '../i18n.ts';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 转义并按**转义后**长度截断。
 * 「先 clip 原文再 escape」会让预算失真：`<` 变 `&lt;`（4 倍）、`&` 变 `&amp;`（5 倍），
 * 贴代码的消息轻松膨胀过 Telegram 的 4096 上限，被 splitText 从实体中间切断
 * → parse error → 整段降级纯文本还带乱码。预算必须量在转义后的字符串上。
 */
export function escapeClipped(raw: string, maxEscaped: number): string {
  let esc = escapeHtml(raw);
  if (esc.length <= maxEscaped) return esc;

  // 按膨胀比例收紧原文；一个原字符至少占一个转义字符，第二步砍掉超出量必达标
  let keep = Math.floor((raw.length * (maxEscaped - 1)) / esc.length);
  esc = escapeHtml(raw.slice(0, keep));
  if (esc.length > maxEscaped - 1) {
    keep -= esc.length - (maxEscaped - 1);
    esc = escapeHtml(raw.slice(0, Math.max(0, keep)));
  }
  return esc + '…';
}

/** 切已转义文本时避开 `&…;` 实体中间（实体最长 6 字符），超长则截断加省略号 */
function clipEntitySafe(esc: string, max: number): string {
  if (esc.length <= max) return esc;
  let cut = max - 1;
  const amp = esc.lastIndexOf('&', cut - 1);
  if (amp > cut - 7 && amp >= 0 && esc.indexOf(';', amp) >= cut) cut = amp;
  return esc.slice(0, cut) + '…';
}

/** 行内 markdown：先摘出 code span 护住内容，转义其余，再套 b/i/s/a */
function inlineMd(raw: string): string {
  const spans: string[] = [];
  // 剥掉正文自带的 NUL —— 它是下面 code span 的占位符，Telegram 也不接受 NUL
  let s = raw.replace(/\u0000/g, '').replace(/`([^`\n]+)`/g, (_m, code: string) => {
    spans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
  );
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  // 前后紧贴字母数字的不当强调（snake_case、a*b）不动
  s = s.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '<i>$1</i>');
  s = s.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '<i>$1</i>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)]!);
}

/**
 * agent 回复的 markdown → Telegram HTML 子集（b/i/s/code/pre/a）。
 * Telegram 不认标题/列表/表格：标题降级为粗体、无序列表换 •，其余原样转义。
 * 输出保证 ≤ maxLen 且标签闭合，截断只发生在行边界或 pre 内的实体边界；
 * 连第一行都塞不下时放弃渲染，回落为纯转义截断（escapeClipped）保住内容。
 * 真到 Telegram 那边 parse 失败还有 egress-queue 的 stripHtml 降级兜底。
 */
export function mdToTelegramHtml(raw: string, maxLen: number): string {
  const budget = maxLen - 2; // 给截断省略号留位
  const out: string[] = [];
  let len = 0;
  let truncated = false;

  const fits = (piece: string): boolean => len + piece.length + (out.length ? 1 : 0) <= budget;
  const push = (piece: string): void => {
    len += piece.length + (out.length ? 1 : 0);
    out.push(piece);
  };

  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      // 收集到闭合围栏（或文末，未闭合照样出 pre）
      const marker = fence[1]!;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // 跳过闭合行（越界无妨）
      let code = escapeHtml(buf.join('\n'));
      const room = budget - len - '<pre></pre>'.length - (out.length ? 1 : 0);
      if (room <= 1) {
        truncated = true;
        break;
      }
      if (code.length > room) {
        code = clipEntitySafe(code, room);
        truncated = true;
      }
      if (code) push(`<pre>${code}</pre>`);
      continue;
    }

    let rendered: string;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (heading) rendered = `<b>${inlineMd(heading[1]!)}</b>`;
    else if (bullet) rendered = `${bullet[1]!}• ${inlineMd(bullet[2]!)}`;
    else rendered = inlineMd(line);

    if (!fits(rendered)) {
      truncated = true;
      break;
    }
    push(rendered);
    i++;
  }

  if (!out.length) return escapeClipped(raw, maxLen);
  return out.join('\n') + (truncated ? '…' : '');
}

const ICONS: Record<AgentEventType, string> = {
  started: '🚀',
  output: '💬',
  waiting: '⏳',
  permission: '🔐',
  question: '❓',
  completed: '✅',
  failed: '❌',
  ended: '🏁',
};

function typeLabel(type: AgentEventType): string {
  return t(`ev-${type}` as MsgKey);
}

export function eventIcon(type: AgentEventType): string {
  return ICONS[type];
}

/** Topic 内的事件消息：已经在对应工位了，不重复报 pane 坐标。 */
export function formatEvent(event: NormalizedEvent, opts: { withTarget?: string } = {}): string {
  const icon = ICONS[event.type];
  const label = typeLabel(event.type);
  const head = opts.withTarget
    ? `${icon} <b>${label}</b> · <code>${escapeHtml(opts.withTarget)}</code>`
    : `${icon} <b>${label}</b>`;

  if (!event.summary) return head;
  return `${head}\n${escapeHtml(event.summary)}`;
}

/** 圆点配色跟话题图标对齐（topics.ts 的 providerTopicColor） */
const PROVIDER_DOT: Record<string, string> = {
  claude: '🟠',
  codex: '🟢',
  pi: '🔵',
};

/** `/home/finger/code/x` → `~/code/x`，列表里路径太长会把行撑爆 */
function shortenPath(cwd: string): string {
  const home = homedir();
  if (cwd === home) return '~';
  return cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd;
}

/** `ops:2.3` → `2.3`（session 已经是分组标题了，不重复） */
function paneCoord(display: string): string {
  const colon = display.indexOf(':');
  return colon > 0 ? display.slice(colon + 1) : display;
}

function sessionOf(display: string): string {
  const colon = display.indexOf(':');
  return colon > 0 ? display.slice(0, colon) : display;
}

/** 按 session 分组，组内按 pane 坐标排序，保持和 tmux 里看到的顺序一致 */
function groupBySession(instances: AgentInstance[]): Map<string, AgentInstance[]> {
  const groups = new Map<string, AgentInstance[]>();
  for (const inst of instances) {
    const key = sessionOf(inst.display);
    const list = groups.get(key);
    if (list) list.push(inst);
    else groups.set(key, [inst]);
  }
  return groups; // 顺序由调用方的 sortForDisplay 保证，这里只做分桶
}

/** `bound`: paneId → 它所在话题的 threadId（0 = 降级模式下的主聊天流） */
export function formatAgentList(
  instances: AgentInstance[],
  bound: ReadonlyMap<string, number>,
  opts: { disposableThread?: boolean } = {},
): string {
  if (!instances.length) {
    return t('no-agents');
  }

  const boundCount = instances.filter((i) => bound.has(i.paneId)).length;
  const head = boundCount
    ? t('agents-head-bound', { n: instances.length, m: boundCount })
    : t('agents-head', { n: instances.length });

  const lines = [head];

  // 按 tmux session 分组 —— 那是你自己划分工作区的方式，比一长条平铺好找
  for (const [session, group] of groupBySession(instances)) {
    lines.push('', `<b>${escapeHtml(session)}</b>`);
    for (const inst of group) {
      // 圆点颜色跟话题图标一致（claude 橙 / codex 绿 / pi 蓝），扫一眼就能对上
      const dot = PROVIDER_DOT[inst.providerId] ?? '⚪';
      const link = bound.has(inst.paneId) ? ' 🔗' : '';
      // 分支用等宽体，和斜体的路径分开；不用 ⎇ 之类的字符，手机上容易变豆腐块
      const branch = inst.branch ? ` <code>${escapeHtml(inst.branch)}</code>` : '';
      lines.push(
        `${dot} <code>${escapeHtml(inst.paneId)}</code> ` +
          `<i>${escapeHtml(shortenPath(inst.cwd))}</i>${branch} ` +
          `· ${escapeHtml(paneCoord(inst.display))}${link}`,
      );
    }
  }

  lines.push('', `<i>${t('agents-legend')}</i>`);
  return lines.join('\n');
}

export function formatBindingStatus(b: Binding, alive: boolean, display: string | null): string {
  const lines = [
    `<b>${escapeHtml(b.title)}</b>`,
    `${alive ? t('status-alive') : t('status-gone')} <code>${escapeHtml(b.paneId)}</code> ` +
      `${escapeHtml(b.providerId)} · <code>${escapeHtml(display ?? b.display)}</code>`,
  ];
  if (b.cwd) lines.push(`<i>${escapeHtml(shortenPath(b.cwd))}</i>`);
  lines.push(`${t('status-notify')} <code>${b.notifyLevel}</code>`);
  return lines.join('\n');
}

/**
 * 把原生 transcript 投影到话题（D12）。
 *
 * Bot 没法冒充你发言 —— Telegram 里 bot 发的消息永远是 bot 的、永远在左边，
 * 没有任何 API 能改这一点。能做的是把「你说的」放进引用块，视觉上和 agent 的话分开。
 *
 * 逐条发会刷屏（30 条历史 = 30 条通知），所以合并成几大块。
 */
function renderHistoryItem(item: HistoryItem, maxPerItem: number): string {
  const raw = item.text.trim();
  if (!raw) return '';
  if (item.role === 'user') return `<blockquote>🧑 ${escapeClipped(raw, maxPerItem)}</blockquote>`;
  if (item.role === 'assistant') {
    // agent 的正文按 markdown 渲染；工具行只是摘要，保持纯文本
    return item.kind === 'tool'
      ? `<i>🔧 ${escapeClipped(raw, maxPerItem)}</i>`
      : `🤖 ${mdToTelegramHtml(raw, maxPerItem)}`;
  }
  return `<i>⚙️ ${escapeClipped(raw, maxPerItem)}</i>`;
}

export function formatHistory(items: HistoryItem[], opts: { maxPerItem?: number } = {}): string[] {
  const maxPerItem = opts.maxPerItem ?? 1200;

  const rendered = items.map((item) => renderHistoryItem(item, maxPerItem));

  // 攒到接近单条上限再发，减少消息条数
  const blocks: string[] = [];
  let buf = '';
  for (const piece of rendered) {
    if (!piece) continue;
    const next = buf ? `${buf}\n\n${piece}` : piece;
    if (next.length > HISTORY_BLOCK_MAX && buf) {
      blocks.push(buf);
      buf = piece;
    } else {
      buf = next;
    }
  }
  if (buf) blocks.push(buf);
  return blocks;
}

/** 单条 Telegram 消息 4096 上限，镜像单条留点余量给前缀 */
const MIRROR_MAX = 3500;
/** 历史合并块的目标大小，留足余量给 HTML 标签 */
const HISTORY_BLOCK_MAX = 3000;

/**
 * 实时镜像的一条对话。
 * 和 /history 的区别：这里是流式追加，不加 role 之外的额外修饰，尽量像原文。
 */
export function formatMirrored(item: HistoryItem): string | null {
  const text = item.text.trim();
  if (!text) return null;

  // 和 /history 一致：你说的话进引用块，和 agent 的话视觉上分开
  if (item.role === 'user') {
    return `<blockquote>🧑 ${escapeClipped(text, MIRROR_MAX)}</blockquote>`;
  }
  if (item.role === 'assistant') {
    // 纯工具行不投影（和 /history 一致，design §4.3）：只有工具名没有参数，
    // 逐条推只会把正文冲散；「agent 在干活」的观感由 typing 指示器承担
    if (item.kind === 'tool') return null;
    // agent 正文按 markdown 渲染成 Telegram HTML 子集
    return mdToTelegramHtml(text, MIRROR_MAX);
  }
  return `⚙️ ${escapeClipped(text, 1000)}`;
}

export function historyHeader(count: number, source?: string): string {
  const head = t('history-header', { n: count });
  return source ? `${head}\n<i>${escapeHtml(source)}</i>` : head;
}

/** 分页视图必须挤进一条可编辑消息，预算比 4096 留足 HTML 余量 */
const HISTORY_PAGE_BUDGET = 3500;
/** 角色包裹标签的最大开销（blockquote 一套） */
const WRAP_OVERHEAD = 40;
/** 单条消息最多切成这么多段页 —— 防一条怪物消息把页数撑到上百 */
const MAX_PARTS = 20;

export type HistoryPageLayout = {
  body: string;
  /** 页头标注：「第 3–12 条」或「第 51 条 · 2/3 段」 */
  label: string;
};

/** 已转义正文（无标签）套上角色样式；分段续页每段单独套，保证 HTML 完整 */
function wrapEscaped(item: HistoryItem, esc: string): string {
  if (item.role === 'user') return `<blockquote>🧑 ${esc}</blockquote>`;
  if (item.role === 'assistant') {
    return item.kind === 'tool' ? `<i>🔧 ${esc}</i>` : `🤖 ${esc}`;
  }
  return `<i>⚙️ ${esc}</i>`;
}

/** 切已转义文本：优先在换行/空格断；硬切时避开 `&…;` 实体中间。 */
function splitEscapedText(esc: string, max: number): string[] {
  const parts: string[] = [];
  let rest = esc;
  while (rest.length > max && parts.length < MAX_PARTS - 1) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) {
      cut = max;
      // 实体最长 6 字符（&quot;）——切点前 6 字符内有未闭合的 & 就退到它前面
      const amp = rest.lastIndexOf('&', cut - 1);
      if (amp > cut - 7 && amp > 0 && rest.indexOf(';', amp) >= cut) cut = amp;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  // 触发 MAX_PARTS 护栏时兜底截断 —— 正常路径 rest 一定 ≤ max
  if (rest) parts.push(rest.length > max ? rest.slice(0, max - 1) + '…' : rest);
  return parts;
}

/**
 * 把整份历史排成页序列（内容驱动，不截断）：
 * - 普通消息按条数（≤size）与页预算攒页；
 * - 超过单页预算的消息独占页；一页放不下就切成多个「续段」页，翻页看完整原文。
 * 布局是确定性的：同样输入永远同样的页边界，无状态翻页每次重算也稳定；
 * 历史只追加，所以已有页的边界不会因新消息而漂移。
 */
export function layoutHistoryPages(
  items: HistoryItem[],
  opts: { size?: number; budget?: number } = {},
): HistoryPageLayout[] {
  const size = opts.size ?? 10;
  const budget = opts.budget ?? HISTORY_PAGE_BUDGET;

  const pages: HistoryPageLayout[] = [];
  let buf = '';
  let startNo = 0; // 当前页起止条号（1 起算）
  let lastNo = 0;
  let count = 0;

  const flush = (): void => {
    if (!buf) return;
    const label =
      startNo === lastNo
        ? t('item-one', { n: startNo })
        : t('items-range', { a: startNo, b: lastNo });
    pages.push({ body: buf, label });
    buf = '';
    count = 0;
  };

  items.forEach((item, idx) => {
    const no = idx + 1;
    const esc = escapeHtml(item.text.trim());
    if (!esc) return;

    const wrapped = wrapEscaped(item, esc);
    if (wrapped.length <= budget) {
      if (buf && (`${buf}\n\n${wrapped}`.length > budget || count >= size)) flush();
      if (count === 0) startNo = no;
      buf = buf ? `${buf}\n\n${wrapped}` : wrapped;
      lastNo = no;
      count++;
      return;
    }

    // 超长消息：独占页并切段，每段一页
    flush();
    const segs = splitEscapedText(esc, budget - WRAP_OVERHEAD);
    segs.forEach((seg, si) => {
      pages.push({
        body: wrapEscaped(item, seg),
        label: t('item-part', { n: no, i: si + 1, k: segs.length }),
      });
    });
  });
  flush();
  return pages;
}
