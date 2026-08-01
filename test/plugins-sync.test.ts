/**
 * 插件目录必须自包含（安装时被整目录拷走），所以 scripts/ 里放的是
 * hooks/ 脚本的副本。这组测试保证副本不漂移：改了 hooks/*.sh 忘了跑
 * `npm run sync:plugins` 时在这里跑红，而不是在用户机器上静默用旧脚本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const COPIES: [string, string][] = [
  ['hooks/agent-remote-hook.sh', 'plugins/claude/scripts/agent-remote-hook.sh'],
  ['hooks/agent-remote-hook.sh', 'plugins/codex/scripts/agent-remote-hook.sh'],
  ['hooks/claude-hook.sh', 'plugins/claude/scripts/claude-hook.sh'],
  ['hooks/codex-hook.sh', 'plugins/codex/scripts/codex-hook.sh'],
];

for (const [source, copy] of COPIES) {
  test(`插件脚本副本与源一致: ${copy}`, () => {
    assert.equal(read(copy), read(source), `${copy} 与 ${source} 不一致，跑 npm run sync:plugins`);
  });
}

const HOOK_JSONS = ['plugins/claude/hooks/hooks.json', 'plugins/codex/hooks/hooks.json'];

for (const rel of HOOK_JSONS) {
  test(`${rel} 是合法 JSON 且命令都指向插件自身`, () => {
    const parsed = JSON.parse(read(rel)) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
    };
    const groups = Object.values(parsed.hooks);
    assert.ok(groups.length > 0);
    for (const group of groups) {
      for (const matcherGroup of group) {
        for (const h of matcherGroup.hooks) {
          assert.equal(h.type, 'command');
          // 副本必须用 ${CLAUDE_PLUGIN_ROOT} 引用自身 —— 指到仓库路径的话，
          // 装到别人机器上就断了
          assert.match(h.command, /^\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//);
        }
      }
    }
  });
}

test('marketplace.json 指向 plugins/claude', () => {
  const mp = JSON.parse(read('.claude-plugin/marketplace.json')) as {
    plugins: { name: string; source: string }[];
  };
  const entry = mp.plugins.find((p) => p.name === 'agent-remote');
  assert.equal(entry?.source, './plugins/claude');
});

test('阻塞式 hook 带 --blocking 且配了 timeout', () => {
  const codex = JSON.parse(read('plugins/codex/hooks/hooks.json')) as {
    hooks: Record<string, { hooks: { command: string; timeout?: number }[] }[]>;
  };
  const perm = codex.hooks['PermissionRequest']?.[0]?.hooks?.[0];
  assert.ok(perm, 'codex 插件必须带 PermissionRequest —— 没有它，绑定的 codex 等授权时手机端无信号');
  assert.match(perm!.command, /--blocking/);
  assert.ok((perm!.timeout ?? 0) >= 130, 'timeout 必须 ≥ DECISION_TIMEOUT_SEC + 40');
});
