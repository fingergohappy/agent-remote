/**
 * 配置目录的解析顺序：AGENT_REMOTE_HOME > XDG 位置 > 旧位置（~/.agent-remote）。
 * 回落判据是 .env 文件而非目录 —— 服务启动会 mkdir 新目录，按目录判会把老用户
 * 切到空目录上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultHome, legacyHome, xdgHome } from '../src/config.ts';

/** 造一个假 HOME，可选地在新/旧位置放 .env */
function fakeHome(opts: { xdgEnv?: boolean; legacyEnv?: boolean; xdgDirOnly?: boolean }): string {
  const home = mkdtempSync(join(tmpdir(), 'agent-remote-home-'));
  if (opts.xdgEnv || opts.xdgDirOnly) {
    mkdirSync(join(home, '.config', 'agent-remote'), { recursive: true });
    if (opts.xdgEnv) writeFileSync(join(home, '.config', 'agent-remote', '.env'), 'X=1\n');
  }
  if (opts.legacyEnv) {
    mkdirSync(join(home, '.agent-remote'), { recursive: true });
    writeFileSync(join(home, '.agent-remote', '.env'), 'X=1\n');
  }
  return home;
}

test('全新安装：默认落在 ~/.config/agent-remote', () => {
  const home = fakeHome({});
  assert.equal(defaultHome({ HOME: home }), join(home, '.config', 'agent-remote'));
});

test('XDG_CONFIG_HOME 生效', () => {
  const home = fakeHome({});
  const xdg = join(home, 'xdg');
  assert.equal(defaultHome({ HOME: home, XDG_CONFIG_HOME: xdg }), join(xdg, 'agent-remote'));
  assert.equal(xdgHome({ HOME: home, XDG_CONFIG_HOME: xdg }), join(xdg, 'agent-remote'));
});

test('AGENT_REMOTE_HOME 覆盖一切，哪怕两个位置都有 .env', () => {
  const home = fakeHome({ xdgEnv: true, legacyEnv: true });
  assert.equal(defaultHome({ HOME: home, AGENT_REMOTE_HOME: '/opt/ar' }), '/opt/ar');
});

test('老安装：只有旧位置有 .env 时继续读旧位置', () => {
  const home = fakeHome({ legacyEnv: true });
  assert.equal(defaultHome({ HOME: home }), legacyHome({ HOME: home }));
});

test('迁移后：新位置有 .env 就用新位置，旧目录残留不再影响', () => {
  const home = fakeHome({ xdgEnv: true, legacyEnv: true });
  assert.equal(defaultHome({ HOME: home }), xdgHome({ HOME: home }));
});

test('新目录被 mkdir 出来但还没 .env 时，不把老用户切到空目录', () => {
  const home = fakeHome({ xdgDirOnly: true, legacyEnv: true });
  assert.equal(defaultHome({ HOME: home }), legacyHome({ HOME: home }));
});
