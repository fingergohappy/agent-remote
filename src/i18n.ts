/**
 * 国际化（中/英）。只覆盖**用户在 Telegram 看到的文案**，运维日志保持中文。
 *
 * 语言来源两层：
 *  - auto（默认）：跟随 Telegram update 里的 from.language_code —— zh* → 中文，
 *    其余 → 英文。检测结果落盘，主动推送（hook 事件/镜像）没有 update 上下文，
 *    用的就是最近一次检测值。
 *  - /lang 手动覆盖：zh / en 固定，auto 恢复跟随。
 *
 * 单用户系统（ALLOWED_USERS 通常一个人），语言是全局状态，不按 chat 区分。
 */
import { readJson, writeJsonAtomic } from './infra/state-fs.ts';

export type Lang = 'zh' | 'en';
export type LangMode = 'auto' | Lang;

type LangState = { version: 1; mode: LangMode; detected: Lang };

let stateFile: string | undefined;
let mode: LangMode = 'auto';
let detected: Lang = 'zh';

export function initI18n(file?: string): void {
  stateFile = file;
  if (!file) return;
  const s = readJson<LangState>(file, { version: 1, mode: 'auto', detected: 'zh' });
  mode = s.mode === 'zh' || s.mode === 'en' || s.mode === 'auto' ? s.mode : 'auto';
  detected = s.detected === 'en' ? 'en' : 'zh';
}

function persist(): void {
  if (!stateFile) return;
  try {
    writeJsonAtomic(stateFile, { version: 1, mode, detected } satisfies LangState);
  } catch {
    /* 语言状态丢了顶多下次重启回到检测值，不致命 */
  }
}

export function currentLang(): Lang {
  return mode === 'auto' ? detected : mode;
}

export function langMode(): LangMode {
  return mode;
}

export function setLangMode(next: LangMode): void {
  mode = next;
  persist();
}

/** 每条 Telegram update 进来时喂一次 language_code；auto 模式下据此切换 */
export function noteLanguageCode(code: string | undefined): void {
  if (!code) return;
  const lang: Lang = /^zh/i.test(code) ? 'zh' : 'en';
  if (lang !== detected) {
    detected = lang;
    persist();
  }
}

/** 测试用：回到干净状态 */
export function resetI18n(): void {
  stateFile = undefined;
  mode = 'auto';
  detected = 'zh';
}

type Dict = Record<string, { zh: string; en: string }>;

const M = {
  // ── 通用 ──
  'not-bound': { zh: '未绑定。', en: 'Not bound.' },
  'not-bound-pick': { zh: '未绑定，请用 /agents 选择。', en: 'Not bound — pick one with /agents.' },
  'bind-first': { zh: '请先绑定：/agents', en: 'Bind first: /agents' },
  'unknown-action': { zh: '无法识别的操作', en: 'Unrecognized action' },
  'failed-see-log': { zh: '处理失败，详见日志', en: 'Failed — see server log' },

  // ── 绑定 / 解绑 ──
  'topic-not-bound': { zh: '此话题未绑定。', en: 'This topic is not bound.' },
  'unbound-rebind': { zh: '已解绑。/rebind 可恢复。', en: 'Unbound. /rebind to restore.' },
  'rebind-hint': { zh: '\n/rebind 可恢复。', en: '\n/rebind to restore.' },
  'rebind-in-topic': {
    zh: '/rebind 需在工位话题内使用。',
    en: '/rebind only works inside a bound topic.',
  },
  'already-bound': { zh: '已绑定 <code>{pane}</code>。', en: 'Already bound to <code>{pane}</code>.' },
  'nothing-to-rebind': {
    zh: '无可恢复的记录，请用 /agents 选择。',
    en: 'Nothing to restore — pick one with /agents.',
  },
  'rebind-gone-deleted': {
    zh: '🗑 <code>{pane}</code> 已不存在，话题「{title}」一并删除。',
    en: '🗑 <code>{pane}</code> is gone; topic “{title}” deleted with it.',
  },
  'rebind-gone-manual': {
    zh: '<code>{pane}</code> 已不存在。话题删除失败，请手动长按删除。',
    en: '<code>{pane}</code> is gone. Failed to delete the topic — long-press to delete it manually.',
  },
  'bound-toast': { zh: '已绑定至 {title}', en: 'Bound to {title}' },
  'bind-failed': { zh: '绑定失败', en: 'Bind failed' },
  'bound-receipt': {
    zh: '✅ 已绑定 <code>{pane}</code> · {provider} · <code>{display}</code>',
    en: '✅ Bound <code>{pane}</code> · {provider} · <code>{display}</code>',
  },
  'bound-degraded': {
    zh: '⚠️ 此会话不支持 Topics，消息均在主聊天流。',
    en: '⚠️ Topics unavailable in this chat — messages go to the main stream.',
  },
  'bound-migrated': { zh: 'ℹ️ 已从其他话题迁移。', en: 'ℹ️ Migrated from another topic.' },
  'browse-history': { zh: '📜 浏览历史', en: '📜 Browse history' },
  'unbound-toast': { zh: '已解绑', en: 'Unbound' },
  'unbound-head': { zh: '🔓 已解绑 <code>{pane}</code>', en: '🔓 Unbound <code>{pane}</code>' },
  'unbind-delete-progress': {
    zh: '解绑 {pane} 并删除话题…',
    en: 'Unbinding {pane} and deleting topic…',
  },
  'deleting': { zh: '删除中…', en: 'Deleting…' },
  'topic-deleted': { zh: '🗑 话题已删除。', en: '🗑 Topic deleted.' },
  'topic-delete-failed': {
    zh: '话题删除失败，请手动长按删除。',
    en: 'Failed to delete the topic — long-press to delete it manually.',
  },
  'delete-empty-topic': { zh: '🗑 删除空话题', en: '🗑 Delete empty topic' },
  refresh: { zh: '🔄 刷新', en: '🔄 Refresh' },
  refreshing: { zh: '刷新中…', en: 'Refreshing…' },
  'delete-topic-btn': { zh: '🗑 删除话题', en: '🗑 Delete topic' },

  // ── cleanup / status ──
  'no-bindings': { zh: '无绑定。', en: 'No bindings.' },
  'cleanup-progress': {
    zh: '核对 {n} 条…（存活话题会多出一条「话题已修改」，忽略即可）',
    en: 'Checking {n} binding(s)… (live topics will show a “topic edited” notice — ignore it)',
  },
  'cleanup-all-ok': { zh: '✅ {n} 个话题均存在。', en: '✅ All {n} topics exist.' },
  'status-alive': { zh: '✅', en: '✅' },
  'status-gone': { zh: '❌ 已消失', en: '❌ gone' },
  'status-notify': { zh: '推送', en: 'Notify' },

  // ── 聊天注入 ──
  'cmd-only-here': {
    zh: '命令台仅接受命令，请在话题内与 agent 对话。',
    en: 'This is the command console — talk to agents inside their topics.',
  },
  'was-bound-hint': {
    zh: '未绑定。上次为 <code>{pane}</code>，/rebind 恢复，或 /agents 更换。',
    en: 'Not bound. Last was <code>{pane}</code> — /rebind to restore, /agents to switch.',
  },
  'send-failed': { zh: '❌ 发送失败：{err}', en: '❌ Send failed: {err}' },
  'auto-unbound': { zh: '❌ {err}\n已自动解绑。', en: '❌ {err}\nUnbound automatically.' },

  // ── 推送级别 ──
  'notify-current': { zh: '当前 <b>{label}</b>', en: 'Current: <b>{label}</b>' },
  'level-info': { zh: '📢 全量转播', en: '📢 Relay everything' },
  'level-important': {
    zh: '🔔 只推完成 / 等待 / 授权 / 失败',
    en: '🔔 Done / waiting / permission / failure only',
  },
  'level-off': { zh: '🔇 静音', en: '🔇 Muted' },
  'btn-info': { zh: '📢 全量', en: '📢 All' },
  'btn-important': { zh: '🔔 只推要事', en: '🔔 Important' },
  'btn-off': { zh: '🔇 静音', en: '🔇 Mute' },
  'notify-help': {
    zh: '📢 <b>info</b> 全量，含 agent 每条回复\n🔔 <b>important</b> 只推完成 / 等待 / 授权 / 失败\n🔇 <b>off</b> 不推',
    en: '📢 <b>info</b> everything, incl. each agent reply\n🔔 <b>important</b> done / waiting / permission / failure only\n🔇 <b>off</b> nothing',
  },

  // ── 语言 ──
  'lang-title': { zh: '界面语言', en: 'Interface language' },
  'lang-auto': { zh: '🌐 跟随 Telegram', en: '🌐 Follow Telegram' },
  'lang-zh': { zh: '中文', en: '中文' },
  'lang-en': { zh: 'English', en: 'English' },

  // ── 历史 ──
  'history-none': { zh: '未找到会话记录。', en: 'No session transcript found.' },
  'history-divider': {
    zh: '—— 以上为历史，以下实时 ——',
    en: '—— history above, live below ——',
  },
  'history-header': { zh: '—— 绑定前最近 {n} 条 ——', en: '—— last {n} before binding ——' },
  'history-loading': { zh: '读取中…', en: 'Loading…' },
  'page-word': { zh: '页', en: '' },
  'history-page-header': {
    zh: '📜 <b>{page}/{pages}</b> 页 · {label}（共 {total} 条）',
    en: '📜 Page <b>{page}/{pages}</b> · {label} ({total} total)',
  },
  'history-fresh': { zh: '🔄 刷出 {n} 条新记录', en: '🔄 {n} new since last look' },
  'history-latest': { zh: '🔄 已是最新 · 共 {n} 条', en: '🔄 Up to date · {n} total' },
  'items-range': { zh: '第 {a}–{b} 条', en: 'items {a}–{b}' },
  'item-one': { zh: '第 {n} 条', en: 'item {n}' },
  'item-part': { zh: '第 {n} 条 · {i}/{k} 段', en: 'item {n} · part {i}/{k}' },

  // ── 授权决策 ──
  'perm-title': { zh: '🔐 <b>授权</b> {prompt}', en: '🔐 <b>Permission</b> {prompt}' },
  'perm-prompt': { zh: '请求授权：{summary}', en: 'Requesting permission: {summary}' },
  'perm-prompt-bare': { zh: '请求授权', en: 'Requesting permission' },
  allow: { zh: '✅ 允许', en: '✅ Allow' },
  deny: { zh: '⛔ 拒绝', en: '⛔ Deny' },
  allowed: { zh: '已允许', en: 'Allowed' },
  denied: { zh: '已拒绝', en: 'Denied' },
  'approved-via-tg': { zh: '已在 Telegram 批准', en: 'Approved via Telegram' },
  'denied-via-tg': { zh: '已在 Telegram 拒绝', en: 'Denied via Telegram' },
  'decision-expired': { zh: '请求已过期。', en: 'Request expired.' },
  'decision-done': { zh: '已处理。', en: 'Already handled.' },
  'decision-invalid': { zh: '请求已失效。', en: 'Request no longer valid.' },
  'decision-failed': { zh: '决策失败', en: 'Decision failed' },
  'decision-handled': { zh: '已处理', en: 'Handled' },
  'unknown-decision': { zh: '未知决策: {id}', en: 'Unknown decision: {id}' },
  'no-structured-decision': {
    zh: '{provider} 不支持结构化决策。',
    en: '{provider} does not support structured decisions.',
  },

  // ── 事件标签 ──
  'ev-started': { zh: '开始', en: 'Started' },
  'ev-output': { zh: '输出', en: 'Output' },
  'ev-waiting': { zh: '等待输入', en: 'Waiting for input' },
  'ev-permission': { zh: '需要授权', en: 'Needs permission' },
  'ev-question': { zh: '提问', en: 'Question' },
  'ev-completed': { zh: '完成', en: 'Done' },
  'ev-failed': { zh: '失败', en: 'Failed' },
  'ev-ended': { zh: '结束', en: 'Ended' },

  // ── provider 摘要 ──
  'sum-session-start': { zh: '会话开始', en: 'Session started' },
  'sum-user-typed': { zh: '用户在终端输入', en: 'User typed in terminal' },
  'sum-need-permission': { zh: '需要授权', en: 'Needs permission' },
  'sum-waiting': { zh: '等待输入', en: 'Waiting for input' },
  'sum-task-done': { zh: '任务完成', en: 'Task done' },
  'sum-subtask-done': { zh: '子任务完成', en: 'Subtask done' },
  'sum-compact': { zh: '上下文压缩', en: 'Context compacted' },
  'sum-session-end': { zh: '会话结束', en: 'Session ended' },
  'sum-session-end-reason': { zh: '会话结束（{reason}）', en: 'Session ended ({reason})' },
  'sum-task-failed': { zh: '任务失败', en: 'Task failed' },
  'sum-task-aborted': { zh: '任务中断', en: 'Task aborted' },

  // ── agent 列表 ──
  'no-agents': {
    zh: '未发现 agent。\n· 是否运行在 tmux 中\n· session 是否在 <code>SESSION_ALLOWLIST</code> 内',
    en: 'No agents found.\n· Is it running inside tmux?\n· Is its session in <code>SESSION_ALLOWLIST</code>?',
  },
  'agents-head': { zh: '🤖 <b>{n}</b> 个 agent', en: '🤖 <b>{n}</b> agent(s)' },
  'agents-head-bound': {
    zh: '🤖 <b>{n}</b> 个 agent · 已绑定 <b>{m}</b>',
    en: '🤖 <b>{n}</b> agent(s) · <b>{m}</b> bound',
  },
  'agents-legend': {
    zh: '🟠 claude · 🟢 codex · 🔵 pi · ➕ 绑定 · 🔓 解绑',
    en: '🟠 claude · 🟢 codex · 🔵 pi · ➕ bind · 🔓 unbind',
  },

  // ── 命令菜单 ──
  'menu-agents': { zh: '列出并绑定 agent', en: 'List and bind agents' },
  'menu-status': { zh: '当前绑定状态', en: 'Current binding status' },
  'menu-history': { zh: '浏览会话历史（分页）', en: 'Browse session history (paged)' },
  'menu-notify': { zh: '推送级别：全量 / 只推要事 / 静音', en: 'Notify level: all / important / mute' },
  'menu-unbind': { zh: '解绑当前话题', en: 'Unbind this topic' },
  'menu-rebind': { zh: '绑回上次那个 agent', en: 'Rebind the previous agent' },
  'menu-cleanup': { zh: '清掉失效绑定', en: 'Clean up stale bindings' },
  'menu-lang': { zh: '界面语言', en: 'Interface language' },
  'menu-start': { zh: '使用说明', en: 'How to use' },

  'input-placeholder': {
    zh: '输入即发送给绑定的 agent',
    en: 'Type to send to the bound agent',
  },
  'start-text': {
    zh: '<b>agent-remote</b> · tmux 里的 agent 遥控器\n\n/agents 选择并绑定，之后在其话题内直接输入。\n默认全量转播，可用 /notify 调整。\n绑定前的记录可用 /history 浏览。',
    en: '<b>agent-remote</b> · remote control for agents in tmux\n\n/agents to pick and bind, then just type inside its topic.\nEverything is relayed by default — tune with /notify.\nBrowse pre-binding history with /history.',
  },
} satisfies Dict;

export type MsgKey = keyof typeof M;

export function t(key: MsgKey, params?: Record<string, string | number>): string {
  let s = M[key][currentLang()];
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

/** 指定语言取文案（给按语言注册命令菜单之类的场景用） */
export function tIn(lang: Lang, key: MsgKey, params?: Record<string, string | number>): string {
  let s = M[key][lang];
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}
