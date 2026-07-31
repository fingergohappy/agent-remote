/**
 * 分支读取（infra/git）。
 *
 * 关键约束是**不许 fork git 进程** —— discover 一轮十几个 pane，
 * 每个 spawn 一次就是几百毫秒。分支名就写在 .git/HEAD 里，直接读。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearGitCache, gitBranch, gitBranches } from '../src/infra/git.ts';

function repo(head: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-remote-git-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'HEAD'), head);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('普通分支', async () => {
  clearGitCache();
  const r = repo('ref: refs/heads/main\n');
  assert.equal(await gitBranch(r.dir), 'main');
  r.cleanup();
});

test('带斜杠的分支名不能被截断', async () => {
  clearGitCache();
  const r = repo('ref: refs/heads/release/0.1\n');
  assert.equal(await gitBranch(r.dir), 'release/0.1');
  r.cleanup();
});

test('detached HEAD 给短 sha', async () => {
  clearGitCache();
  const r = repo('a'.repeat(40) + '\n');
  assert.equal(await gitBranch(r.dir), 'aaaaaaa');
  r.cleanup();
});

test('子目录能向上找到仓库根', async () => {
  clearGitCache();
  const r = repo('ref: refs/heads/main\n');
  const deep = join(r.dir, 'src', 'core');
  mkdirSync(deep, { recursive: true });
  assert.equal(await gitBranch(deep), 'main');
  r.cleanup();
});

test('.git 是文件时（worktree / submodule）跟着 gitdir 走', async () => {
  clearGitCache();
  const outer = mkdtempSync(join(tmpdir(), 'agent-remote-wt-'));
  const realGit = join(outer, 'real-git-dir');
  mkdirSync(realGit);
  writeFileSync(join(realGit, 'HEAD'), 'ref: refs/heads/feature/x\n');

  const wt = join(outer, 'worktree');
  mkdirSync(wt);
  writeFileSync(join(wt, '.git'), `gitdir: ${realGit}\n`);

  assert.equal(await gitBranch(wt), 'feature/x');
  rmSync(outer, { recursive: true, force: true });
});

test('不是仓库返回 null，绝不抛 —— 分支只是锦上添花', async () => {
  clearGitCache();
  const dir = mkdtempSync(join(tmpdir(), 'agent-remote-nogit-'));
  assert.equal(await gitBranch(dir), null);
  assert.equal(await gitBranch('/definitely/not/here'), null);
  rmSync(dir, { recursive: true, force: true });
});

test('HEAD 内容看不懂时返回 null，不把垃圾当分支名', async () => {
  clearGitCache();
  const r = repo('这不是一个合法的 HEAD\n');
  assert.equal(await gitBranch(r.dir), null);
  r.cleanup();
});

test('同一个 cwd 只读一次盘（缓存生效）', async () => {
  clearGitCache();
  const r = repo('ref: refs/heads/main\n');
  assert.equal(await gitBranch(r.dir), 'main');

  // 缓存期内改了 HEAD 也不会立刻反映 —— 这是有意的取舍，60s 一轮的 discover 够用
  writeFileSync(join(r.dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
  assert.equal(await gitBranch(r.dir), 'main');

  // 过了 TTL 才重新读
  assert.equal(await gitBranch(r.dir, Date.now() + 31_000), 'other');
  r.cleanup();
});

test('批量查：重复的 cwd 只算一次', async () => {
  clearGitCache();
  const r = repo('ref: refs/heads/main\n');
  const map = await gitBranches([r.dir, r.dir, r.dir]);
  assert.equal(map.size, 1);
  assert.equal(map.get(r.dir), 'main');
  r.cleanup();
});
