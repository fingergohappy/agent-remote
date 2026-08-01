/**
 * `agent-remote setup`：一键把 hook 注册进两侧配置（INSTALL.md 的自动化等价物）。
 *
 *   - ~/.config/agent-remote/.env 不存在则从 .env.example 初始化，自动生成 INGRESS_SECRET
 *   - ~/.claude/settings.json 合并观察类 hook；--approval 追加阻塞式 PreToolUse
 *   - ~/.codex/hooks.json 合并观察类 hook + PermissionRequest（codex 没有等价于
 *     Claude Notification 的事件，没有它，绑定的 codex 等授权时手机端无信号）
 *   - --uninstall 摘除我们写入的条目，别人的 hook 一律不碰
 *
 * 幂等策略：合并 = 先移除「我们的」条目再写入当前路径 —— 重复跑不累积，
 * 仓库挪了位置重跑即自动修正路径。「我们的」由命令路径判定：
 * 任何以 hooks/claude-hook.sh、hooks/codex-hook.sh 结尾的命令（含插件副本的
 * scripts/ 前缀不算 —— 插件条目归插件管理器管，这里只认裸脚本路径）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultHome, legacyHome, loadConfig, xdgHome } from './config.ts';

// ── 结构与判定 ────────────────────────────────────────────────────────────────

export type HookHandler = { type: 'command'; command: string; timeout?: number };
export type MatcherGroup = { matcher?: string; hooks: HookHandler[] };
export type HooksMap = Record<string, MatcherGroup[]>;

const OURS = /(^|[/\s])\S*hooks\/(claude|codex)-hook\.sh(\s|$)/;

export function isOurCommand(command: string): boolean {
  return OURS.test(command);
}

/** 从 hooks 映射里摘掉我们的条目；空组、空事件顺手清干净。 */
export function removeOurHooks(hooks: HooksMap): HooksMap {
  const out: HooksMap = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept: MatcherGroup[] = [];
    for (const group of groups ?? []) {
      const rest = (group.hooks ?? []).filter((h) => !isOurCommand(h.command ?? ''));
      if (rest.length) kept.push({ ...group, hooks: rest });
    }
    if (kept.length) out[event] = kept;
  }
  return out;
}

export type MergeSpec = {
  /** 非阻塞观察事件 → 追加 { hooks: [{command}] } */
  observe: { event: string; matcher?: string }[];
  /** 阻塞事件（可选）：带 --blocking 与 timeout */
  blocking?: { event: string; matcher?: string; timeoutSec: number }[];
  command: string;
};

/** 合并 = 移除旧的我们条目 + 写入当前条目（幂等；路径漂移自动修正）。 */
export function mergeOurHooks(hooks: HooksMap, spec: MergeSpec): HooksMap {
  const out = removeOurHooks(hooks);
  for (const { event, matcher } of spec.observe) {
    const group: MatcherGroup =
      matcher === undefined
        ? { hooks: [{ type: 'command', command: spec.command }] }
        : { matcher, hooks: [{ type: 'command', command: spec.command }] };
    out[event] = [...(out[event] ?? []), group];
  }
  for (const { event, matcher, timeoutSec } of spec.blocking ?? []) {
    const handler: HookHandler = {
      type: 'command',
      command: `${spec.command} --blocking`,
      timeout: timeoutSec,
    };
    const group: MatcherGroup =
      matcher === undefined ? { hooks: [handler] } : { matcher, hooks: [handler] };
    out[event] = [...(out[event] ?? []), group];
  }
  return out;
}

// ── 两侧的事件清单 ────────────────────────────────────────────────────────────

export function claudeMergeSpec(
  claudeHook: string,
  opts: { approval: boolean; timeoutSec: number },
): MergeSpec {
  return {
    command: claudeHook,
    observe: [
      { event: 'SessionStart' },
      { event: 'UserPromptSubmit' },
      { event: 'Notification' },
      { event: 'Stop' },
      { event: 'SessionEnd' },
    ],
    blocking: opts.approval
      ? [{ event: 'PreToolUse', matcher: 'Bash|Write|Edit', timeoutSec: opts.timeoutSec }]
      : [],
  };
}

export function codexMergeSpec(codexHook: string, opts: { timeoutSec: number }): MergeSpec {
  return {
    command: codexHook,
    // codex 的 matcher 语义与 Claude 相同，空串 = 全匹配；显式写上更直观
    observe: [
      { event: 'SessionStart', matcher: '' },
      { event: 'UserPromptSubmit', matcher: '' },
      { event: 'Stop', matcher: '' },
      { event: 'SessionEnd', matcher: '' },
    ],
    blocking: [{ event: 'PermissionRequest', matcher: '', timeoutSec: opts.timeoutSec }],
  };
}

// ── 文件级操作 ────────────────────────────────────────────────────────────────

type FileReport = { path: string; action: 'created' | 'updated' | 'unchanged' | 'skipped'; note?: string };

function loadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null; // 解析不了就不动它 —— 绝不清空别人的配置
  }
}

function backupThenWrite(path: string, content: string): void {
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    copyFileSync(path, `${path}.bak-agent-remote-${stamp}`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, content);
}

/** 对一个「顶层有 hooks 键」的 JSON 文件应用 transform（settings.json / hooks.json 同构）。 */
function applyHooksFile(path: string, transform: (hooks: HooksMap) => HooksMap): FileReport {
  const doc = loadJson(path);
  if (doc === null) {
    return { path, action: 'skipped', note: '不是合法 JSON，手工处理（见 hooks/INSTALL.md）' };
  }
  const before = JSON.stringify(doc.hooks ?? {});
  const next = transform((doc.hooks ?? {}) as HooksMap);
  if (JSON.stringify(next) === before) return { path, action: 'unchanged' };

  const existed = existsSync(path);
  if (Object.keys(next).length) doc.hooks = next;
  else delete doc.hooks;
  backupThenWrite(path, JSON.stringify(doc, null, 2) + '\n');
  return { path, action: existed ? 'updated' : 'created' };
}

function ensureEnvFile(home: string, exampleFile: string): FileReport {
  const envPath = join(home, '.env');
  if (existsSync(envPath)) return { path: envPath, action: 'unchanged' };

  mkdirSync(home, { recursive: true, mode: 0o700 });
  let content = '';
  try {
    content = readFileSync(exampleFile, 'utf8');
  } catch {
    content = 'TELEGRAM_BOT_TOKEN=\nALLOWED_USERS=\nINGRESS_SECRET=\n';
  }
  const secret = randomBytes(32).toString('hex');
  content = content.includes('INGRESS_SECRET=')
    ? content.replace(/^INGRESS_SECRET=.*$/m, `INGRESS_SECRET=${secret}`)
    : content + `\nINGRESS_SECRET=${secret}\n`;
  writeFileSync(envPath, content, { mode: 0o600 });
  return { path: envPath, action: 'created', note: '已生成 INGRESS_SECRET，请补 TELEGRAM_BOT_TOKEN / ALLOWED_USERS' };
}

async function checkHealth(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── CLI 入口 ──────────────────────────────────────────────────────────────────

export type SetupPaths = {
  repoRoot: string;
  claudeSettings: string;
  codexHooks: string;
  home: string;
};

export function defaultPaths(env: NodeJS.ProcessEnv = process.env): SetupPaths {
  const homeDir = env.HOME || homedir();
  return {
    repoRoot: join(import.meta.dirname, '..'),
    claudeSettings: join(homeDir, '.claude', 'settings.json'),
    codexHooks: join(homeDir, '.codex', 'hooks.json'),
    home: defaultHome(env),
  };
}

export async function runSetup(
  argv: string[],
  paths: SetupPaths = defaultPaths(),
): Promise<number> {
  const approval = argv.includes('--approval');
  const uninstall = argv.includes('--uninstall');
  const unknown = argv.filter((a) => a !== '--approval' && a !== '--uninstall');
  if (unknown.length) {
    process.stdout.write(
      `用法: agent-remote setup [--approval] [--uninstall]\n` +
        `  --approval   Claude 侧追加阻塞式 PreToolUse（手机上批 Bash|Write|Edit）\n` +
        `  --uninstall  摘除 setup 写入的 hook 条目（不碰其它工具的条目）\n`,
    );
    return unknown[0] === '--help' || unknown[0] === '-h' ? 0 : 1;
  }

  const claudeHook = join(paths.repoRoot, 'hooks', 'claude-hook.sh');
  const codexHook = join(paths.repoRoot, 'hooks', 'codex-hook.sh');
  const reports: FileReport[] = [];

  if (uninstall) {
    reports.push(applyHooksFile(paths.claudeSettings, removeOurHooks));
    reports.push(applyHooksFile(paths.codexHooks, removeOurHooks));
  } else {
    reports.push(ensureEnvFile(paths.home, join(paths.repoRoot, '.env.example')));

    // timeout 跟着 .env 的 DECISION_TIMEOUT_SEC 走（+40s 余量），不再是文档里的死数字
    const config = loadConfig(process.env, { strict: false });
    const timeoutSec = Math.round(config.decisionTimeoutMs / 1000) + 40;

    reports.push(
      applyHooksFile(paths.claudeSettings, (hooks) =>
        mergeOurHooks(hooks, claudeMergeSpec(claudeHook, { approval, timeoutSec })),
      ),
    );
    reports.push(
      applyHooksFile(paths.codexHooks, (hooks) =>
        mergeOurHooks(hooks, codexMergeSpec(codexHook, { timeoutSec })),
      ),
    );
  }

  const lines: string[] = [];
  for (const r of reports) {
    const mark = { created: '＋', updated: '✎', unchanged: '＝', skipped: '⚠' }[r.action];
    lines.push(`${mark} ${r.path}  ${r.action}${r.note ? `（${r.note}）` : ''}`);
  }

  if (!uninstall) {
    const config = loadConfig(process.env, { strict: false });
    const healthy = await checkHealth(config.ingressHost, config.ingressPort);
    lines.push('');
    lines.push(
      healthy
        ? `✓ 服务在跑（http://${config.ingressHost}:${config.ingressPort}/health）`
        : `✗ 服务没在跑 —— hook 会静默跳过。启动: node src/main.ts（常驻见 systemd/README.md）`,
    );
    lines.push(`  自检: node src/main.ts doctor`);
    // 只提示「回落到旧位置」这一种情况；显式设了 AGENT_REMOTE_HOME 的不算跑偏
    if (!process.env.AGENT_REMOTE_HOME && paths.home === legacyHome()) {
      lines.push(`  配置仍在旧位置: mv ${paths.home} ${xdgHome()}（迁移后重启服务）`);
    }
    if (!approval) {
      lines.push(`  想在手机上批 Claude 的工具调用: 重跑 setup --approval`);
    }
    lines.push(`  Codex 首次触发 hook 时会要求确认信任，确认一次即可`);
  }

  process.stdout.write(lines.join('\n') + '\n');
  return reports.some((r) => r.action === 'skipped') ? 1 : 0;
}
