/**
 * 配置加载：process.env 优先，其次 $AGENT_REMOTE_HOME/.env
 * （默认 ~/.config/agent-remote/.env，遵循 XDG_CONFIG_HOME）。
 * 见 modules.md §7。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type NotifyLevel = 'off' | 'important' | 'info';

export type Config = {
  home: string;
  bindingsFile: string;

  botToken: string;
  allowedUsers: number[];
  /** 空数组 = 不额外限制 chat（仍受 allowedUsers 约束） */
  allowedChats: number[];

  ingressHost: string;
  ingressPort: number;
  ingressSecret: string;

  /** 空数组 = 允许全部 tmux session */
  sessionAllowlist: string[];

  ackOnSend: boolean;
  defaultNotifyLevel: NotifyLevel;

  decisionTimeoutMs: number;
  historyDefaultLimit: number;
  syncHistoryOnBind: boolean;

  /** 解绑后自动关闭话题（保留历史，不删） */
  closeTopicOnUnbind: boolean;
  /** transcript 镜像的轮询间隔 */
  mirrorIntervalMs: number;

  /** send-keys 文本与 Enter 之间的间隔 */
  sendEnterDelayMs: number;
  /** 多行文本用 bracketed paste 包裹，避免 TUI 逐行提交 */
  sendBracketedPaste: boolean;

  logLevel: 'debug' | 'info' | 'warn' | 'error';
};

function parseEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function toList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function toNumberList(v: string | undefined): number[] {
  return toList(v)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

function toBool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function toInt(v: string | undefined, dflt: number, min = 1): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
}

/** 全量级旧名 `verbose` 已更名 `info`；老绑定、旧按钮、环境变量里的旧拼写统一在这归一。 */
export function toNotifyLevel(v: string | undefined, dflt: NotifyLevel): NotifyLevel {
  if (v === 'verbose') return 'info';
  return v === 'off' || v === 'important' || v === 'info' ? v : dflt;
}

/** XDG 位置：$XDG_CONFIG_HOME/agent-remote，默认 ~/.config/agent-remote。 */
export function xdgHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || homedir();
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'agent-remote');
}

/** 0.1.1 及更早的位置，保留只为让老安装无痛过渡。 */
export function legacyHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), '.agent-remote');
}

/**
 * 配置目录。AGENT_REMOTE_HOME > XDG 位置 > 旧位置。
 * 回落判据是 `.env` 而非目录本身：服务启动会 mkdir 新目录，若按目录判定，
 * 老用户第一次跑就会切到空目录、丢掉旧配置。
 */
export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_REMOTE_HOME) return env.AGENT_REMOTE_HOME;
  const xdg = xdgHome(env);
  if (existsSync(join(xdg, '.env'))) return xdg;
  const legacy = legacyHome(env);
  return existsSync(join(legacy, '.env')) ? legacy : xdg;
}

/** 读取配置。`strict=false` 时不校验必填项（供 CLI 子命令使用）。 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { strict?: boolean } = {},
): Config {
  const home = defaultHome(env);
  const fileEnv = parseEnvFile(join(home, '.env'));
  const get = (key: string): string | undefined => env[key] ?? fileEnv[key];

  const cfg: Config = {
    home,
    bindingsFile: join(home, 'bindings.json'),

    botToken: get('TELEGRAM_BOT_TOKEN') || '',
    allowedUsers: toNumberList(get('ALLOWED_USERS')),
    allowedChats: toNumberList(get('ALLOWED_CHATS')),

    ingressHost: get('INGRESS_HOST') || '127.0.0.1',
    ingressPort: toInt(get('INGRESS_PORT'), 8787),
    ingressSecret: get('INGRESS_SECRET') || '',

    // 不设默认名单：默认扫全部 session（与 .env.example「留空 = 全部」一致）
    sessionAllowlist: toList(get('SESSION_ALLOWLIST')),

    ackOnSend: toBool(get('ACK_ON_SEND'), false),
    defaultNotifyLevel: toNotifyLevel(get('DEFAULT_NOTIFY_LEVEL'), 'info'),

    decisionTimeoutMs: toInt(get('DECISION_TIMEOUT_SEC'), 90) * 1000,
    historyDefaultLimit: toInt(get('HISTORY_DEFAULT_LIMIT'), 30),
    syncHistoryOnBind: toBool(get('SYNC_HISTORY_ON_BIND'), false),

    closeTopicOnUnbind: toBool(get('CLOSE_TOPIC_ON_UNBIND'), true),
    // 镜像的兜底轮询间隔。主路径是 hook 触发 + fs.watch，这里只是保险丝；0 = 关闭兜底
    mirrorIntervalMs: toInt(get('MIRROR_INTERVAL_MS'), 20_000, 0),

    sendEnterDelayMs: toInt(get('SEND_ENTER_DELAY_MS'), 150, 0),
    sendBracketedPaste: toBool(get('SEND_BRACKETED_PASTE'), true),

    logLevel: (['debug', 'info', 'warn', 'error'] as const).includes(
      (get('LOG_LEVEL') || '') as never,
    )
      ? (get('LOG_LEVEL') as Config['logLevel'])
      : 'info',
  };

  if (opts.strict !== false) {
    const missing: string[] = [];
    if (!cfg.botToken) missing.push('TELEGRAM_BOT_TOKEN');
    if (!cfg.allowedUsers.length) missing.push('ALLOWED_USERS');
    if (!cfg.ingressSecret) missing.push('INGRESS_SECRET');
    if (missing.length) {
      throw new Error(
        `缺少必填配置: ${missing.join(', ')}（写入 ${join(home, '.env')} 或设为环境变量）`,
      );
    }
  }

  return cfg;
}
