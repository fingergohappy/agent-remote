/**
 * CLI 入口：不认识的开关曾经会直接掉进「启动常驻服务」，撞端口才停 ——
 * 看着像挂了。这里守住 --help / --version 走独立分支、不碰 config、不开端口。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');

/** 故意不给任何配置：--help / --version 不该因为缺 .env 就失败 */
const BARE_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

test('--help 打用法，不启动服务', async () => {
  const { stdout } = await run(process.execPath, [MAIN, '--help'], {
    env: BARE_ENV,
    timeout: 30_000,
  });
  assert.match(stdout, /agent-remote/);
  assert.match(stdout, /setup/);
  assert.match(stdout, /doctor/);
  assert.doesNotMatch(stdout, /ingress 监听/, '不该真的起服务');
});

test('-h / help 是同一个出口', async () => {
  for (const arg of ['-h', 'help']) {
    const { stdout } = await run(process.execPath, [MAIN, arg], {
      env: BARE_ENV,
      timeout: 30_000,
    });
    assert.match(stdout, /用法:/, `${arg} 应该打用法`);
  }
});

test('--version 只打版本号，和 package.json 对得上', async () => {
  const { stdout } = await run(process.execPath, [MAIN, '--version'], {
    env: BARE_ENV,
    timeout: 30_000,
  });
  // 不用 JSON import attribute：CI 是 node 22，本地可能更新，别让语法差异卡住发布
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { version: string };
  assert.equal(stdout.trim(), pkg.version);
});
