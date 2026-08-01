/**
 * setup 的合并逻辑：幂等、不碰别人的条目、仓库挪位置自动修正路径。
 * 文件级行为（备份、坏 JSON 跳过、.env 初始化）走临时目录冒烟。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeMergeSpec,
  codexMergeSpec,
  isOurCommand,
  mergeOurHooks,
  removeOurHooks,
  runSetup,
  type HooksMap,
} from '../src/setup.ts';

const HOOK = '/home/u/code/agent-remote/hooks/claude-hook.sh';

test('isOurCommand 只认 hooks/{claude,codex}-hook.sh 结尾的命令', () => {
  assert.ok(isOurCommand(HOOK));
  assert.ok(isOurCommand(`${HOOK} --blocking`));
  assert.ok(isOurCommand('/other/path/hooks/codex-hook.sh'));
  // 插件副本（scripts/ 前缀）归插件管理器管，不认
  assert.ok(!isOurCommand('${CLAUDE_PLUGIN_ROOT}/scripts/claude-hook.sh'));
  // 别人的 hook 不认
  assert.ok(!isOurCommand('bash /home/u/tmux-agent-sidebar/hook.sh codex stop'));
});

test('merge 幂等：跑两遍结果一致', () => {
  const spec = claudeMergeSpec(HOOK, { approval: true, timeoutSec: 130 });
  const once = mergeOurHooks({}, spec);
  const twice = mergeOurHooks(once, spec);
  assert.deepEqual(twice, once);
});

test('merge 不碰别人的条目，uninstall 也只摘我们的', () => {
  const foreign: HooksMap = {
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'bash /x/sidebar/hook.sh stop' }] }],
  };
  const merged = mergeOurHooks(foreign, codexMergeSpec('/repo/hooks/codex-hook.sh', { timeoutSec: 130 }));
  // 别人的 Stop 条目还在，我们的追加在后
  assert.equal(merged.Stop!.length, 2);
  assert.equal(merged.Stop![0]!.hooks[0]!.command, 'bash /x/sidebar/hook.sh stop');

  const removed = removeOurHooks(merged);
  assert.deepEqual(removed, foreign);
});

test('仓库挪位置后重跑 setup：旧路径条目被替换，不累积', () => {
  const oldSpec = claudeMergeSpec('/old/place/hooks/claude-hook.sh', { approval: false, timeoutSec: 130 });
  const newSpec = claudeMergeSpec('/new/place/hooks/claude-hook.sh', { approval: false, timeoutSec: 130 });
  const migrated = mergeOurHooks(mergeOurHooks({}, oldSpec), newSpec);
  const commands = Object.values(migrated)
    .flat()
    .flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(commands.every((c) => c.startsWith('/new/place/')));
  assert.equal(commands.length, 5);
});

test('claude 默认不带 PreToolUse，--approval 才有且 timeout 跟配置走', () => {
  const plain = mergeOurHooks({}, claudeMergeSpec(HOOK, { approval: false, timeoutSec: 130 }));
  assert.equal(plain.PreToolUse, undefined);

  const armed = mergeOurHooks({}, claudeMergeSpec(HOOK, { approval: true, timeoutSec: 150 }));
  const pre = armed.PreToolUse![0]!;
  assert.equal(pre.matcher, 'Bash|Write|Edit');
  assert.match(pre.hooks[0]!.command, /--blocking$/);
  assert.equal(pre.hooks[0]!.timeout, 150);
});

test('codex 默认带阻塞式 PermissionRequest（等授权的唯一信号）', () => {
  const merged = mergeOurHooks({}, codexMergeSpec('/repo/hooks/codex-hook.sh', { timeoutSec: 130 }));
  const perm = merged.PermissionRequest![0]!;
  assert.match(perm.hooks[0]!.command, /--blocking$/);
  assert.equal(perm.hooks[0]!.timeout, 130);
});

// ── 文件级冒烟 ───────────────────────────────────────────────────────────────

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-remote-setup-'));
  return {
    dir,
    paths: {
      repoRoot: join(import.meta.dirname, '..'),
      claudeSettings: join(dir, 'claude', 'settings.json'),
      codexHooks: join(dir, 'codex', 'hooks.json'),
      home: join(dir, 'agent-remote-home'),
    },
  };
}

test('runSetup 冒烟：建 .env（600 + secret）、写两侧配置、重跑幂等', async () => {
  const { dir, paths } = tmpPaths();
  const code = await runSetup([], paths);
  assert.equal(code, 0);

  const env = readFileSync(join(paths.home, '.env'), 'utf8');
  assert.match(env, /^INGRESS_SECRET=[0-9a-f]{64}$/m);
  assert.equal(statSync(join(paths.home, '.env')).mode & 0o777, 0o600);

  const claude = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'));
  assert.ok(claude.hooks.SessionStart);
  assert.equal(claude.hooks.PreToolUse, undefined);

  const codex = JSON.parse(readFileSync(paths.codexHooks, 'utf8'));
  assert.ok(codex.hooks.PermissionRequest);

  // 重跑：内容不变，也不产生备份文件
  await runSetup([], paths);
  assert.deepEqual(JSON.parse(readFileSync(paths.claudeSettings, 'utf8')), claude);
  const backups = readdirSync(join(dir, 'claude')).filter((f) => f.includes('.bak-agent-remote-'));
  assert.equal(backups.length, 0);
});

test('runSetup 改已有文件前先备份；uninstall 摘干净但保留别人的键', async () => {
  const { dir, paths } = tmpPaths();
  mkdirSync(join(dir, 'claude'), { recursive: true });
  writeFileSync(
    paths.claudeSettings,
    JSON.stringify({ model: 'opus', hooks: {} }, null, 2),
  );

  await runSetup([], paths);
  const backups = readdirSync(join(dir, 'claude')).filter((f) => f.includes('.bak-agent-remote-'));
  assert.equal(backups.length, 1);

  await runSetup(['--uninstall'], paths);
  const after = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'));
  assert.equal(after.model, 'opus'); // 别的键原样保留
  assert.equal(after.hooks, undefined); // 我们的条目摘干净后不留空壳
});

test('坏 JSON 不动、退出码 1', async () => {
  const { dir, paths } = tmpPaths();
  mkdirSync(join(dir, 'claude'), { recursive: true });
  writeFileSync(paths.claudeSettings, '{ not json');

  const code = await runSetup([], paths);
  assert.equal(code, 1);
  assert.equal(readFileSync(paths.claudeSettings, 'utf8'), '{ not json');
});
