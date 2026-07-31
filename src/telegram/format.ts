/**
 * NormalizedEvent / discover 结果 → 用户可见文案。
 * 只用公共字段；不碰 event.payload（provider 私有）。
 */
import { homedir } from 'node:os';
import type { AgentInstance } from '../core/discover.ts';
import type { Binding } from '../core/bind-store.ts';
import type { AgentEventType, HistoryItem, NormalizedEvent } from '../providers/types.ts';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
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

const TYPE_LABEL: Record<AgentEventType, string> = {
  started: '开始',
  output: '输出',
  waiting: '等待输入',
  permission: '需要授权',
  question: '提问',
  completed: '完成',
  failed: '失败',
  ended: '结束',
};

export function eventIcon(type: AgentEventType): string {
  return ICONS[type];
}

/** Topic 内的事件消息：已经在对应工位了，不重复报 pane 坐标。 */
export function formatEvent(event: NormalizedEvent, opts: { withTarget?: string } = {}): string {
  const icon = ICONS[event.type];
  const label = TYPE_LABEL[event.type];
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
    return [
      '未发现 agent。',
      '· 是否运行在 tmux 中',
      '· session 是否在 <code>SESSION_ALLOWLIST</code> 内',
    ].join('\n');
  }

  const boundCount = instances.filter((i) => bound.has(i.paneId)).length;
  const head = boundCount
    ? `🤖 <b>${instances.length}</b> 个 agent · 已绑定 <b>${boundCount}</b>`
    : `🤖 <b>${instances.length}</b> 个 agent`;

  const lines = [head];

  // 按 tmux session 分组 —— 那是你自己划分工作区的方式，比一长条平铺好找
  for (const [session, group] of groupBySession(instances)) {
    lines.push('', `<b>${escapeHtml(session)}</b>`);
    for (const inst of group) {
      // 圆点颜色跟话题图标一致（claude 橙 / codex 绿），扫一眼就能对上
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

  lines.push('', '<i>🟠 claude · 🟢 codex · ➕ 绑定 · 🔓 解绑</i>');
  return lines.join('\n');
}

export function formatBindingStatus(b: Binding, alive: boolean, display: string | null): string {
  const lines = [
    `<b>${escapeHtml(b.title)}</b>`,
    `${alive ? '✅' : '❌ 已消失'} <code>${escapeHtml(b.paneId)}</code> ` +
      `${escapeHtml(b.providerId)} · <code>${escapeHtml(display ?? b.display)}</code>`,
  ];
  if (b.cwd) lines.push(`<i>${escapeHtml(shortenPath(b.cwd))}</i>`);
  lines.push(`推送 <code>${b.notifyLevel}</code>`);
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
  const text = escapeHtml(clip(item.text.trim(), maxPerItem));
  if (!text) return '';
  if (item.role === 'user') return `<blockquote>🧑 ${text}</blockquote>`;
  if (item.role === 'assistant') {
    return item.kind === 'tool' ? `<i>🔧 ${text}</i>` : `🤖 ${text}`;
  }
  return `<i>⚙️ ${text}</i>`;
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
    return `<blockquote>🧑 ${escapeHtml(clip(text, MIRROR_MAX))}</blockquote>`;
  }
  if (item.role === 'assistant') {
    return item.kind === 'tool'
      ? `🔧 <i>${escapeHtml(clip(text, 200))}</i>`
      : escapeHtml(clip(text, MIRROR_MAX));
  }
  return `⚙️ ${escapeHtml(clip(text, 1000))}`;
}

export function historyHeader(count: number, source?: string): string {
  const head = `—— 绑定前最近 ${count} 条 ——`;
  return source ? `${head}\n<i>${escapeHtml(source)}</i>` : head;
}

/** 分页视图必须挤进一条可编辑消息，预算比 4096 留足 HTML 余量 */
const HISTORY_PAGE_BUDGET = 3500;

/**
 * 把一页历史渲染成**单条**消息文本（分页靠 editMessage 原地翻，不能分块多发）。
 * 预算内放不下的条目省略并标注 —— 分页索引不受影响，只是显示截断。
 */
export function renderHistoryPage(
  items: HistoryItem[],
  opts: { maxPerItem?: number; budget?: number } = {},
): { text: string; shown: number } {
  const maxPerItem = opts.maxPerItem ?? 500;
  const budget = opts.budget ?? HISTORY_PAGE_BUDGET;

  let buf = '';
  let shown = 0;
  for (const item of items) {
    const piece = renderHistoryItem(item, maxPerItem);
    if (!piece) {
      shown++; // 空条目视为已展示，否则截断标注会虚报
      continue;
    }
    const next = buf ? `${buf}\n\n${piece}` : piece;
    if (next.length > budget && buf) break;
    buf = next;
    shown++;
  }

  const dropped = items.length - shown;
  if (dropped > 0) {
    buf += `\n\n<i>（本页还有 ${dropped} 条太长放不下，可用更小的每页条数，如 /history 5）</i>`;
  }
  return { text: buf, shown };
}
