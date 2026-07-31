/**
 * 真机 tmux 集成测试（modules.md §10 的 integration 切面，slow）。
 * 起一个临时 detached session，测完 kill。没有 tmux / zsh 就整体跳过。
 *
 * 为什么用 `zsh -f`：目标 pane 里跑的是 Claude/Codex 的 TUI —— raw mode + bracketed
 * paste。zsh 的 zle 行为与之一致，能真实反映「多行消息会不会被当成多次提交」。
 * 用 `sh` 测这件事没有意义：它是 tty canonical 模式，根本没有多行输入缓冲的概念。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { capturePane, paneAlive, panePid, sendKeys } from '../src/infra/tmux.ts';

/** tmux 认的是 -V，不是 --version */
function has(bin: string, versionFlag = '--version'): boolean {
  try {
    execFileSync(bin, [versionFlag], { encoding: 'utf8', timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function tmux(args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8', timeout: 5000 });
}

const SESSION = `agent-remote-it-${process.pid}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test(
  'tmux 真机：send / capture / 多行粘贴',
  { skip: !has('tmux', '-V') || !has('zsh') },
  async (t) => {
    // -f：不读用户 rc，提示符与插件不干扰断言
    tmux(['new-session', '-d', '-s', SESSION, '-x', '100', '-y', '40', 'zsh', '-f']);
    t.after(() => {
      try {
        tmux(['kill-session', '-t', SESSION]);
      } catch {
        /* 已经没了 */
      }
    });
    await sleep(700);

    const paneId = tmux(['list-panes', '-t', SESSION, '-F', '#{pane_id}']).trim().split('\n')[0]!;
    assert.match(paneId, /^%\d+$/);

    await t.test('pane 存活与 pid 可查（fingerprint 依赖这两个）', async () => {
      assert.equal(await paneAlive(paneId), true);
      assert.equal(typeof (await panePid(paneId)), 'number');
      assert.equal(await paneAlive('%999999'), false);
      assert.equal(await panePid('%999999'), null);
    });

    await t.test('单行文本 + Enter 会被执行', async () => {
      await sendKeys(paneId, 'echo ar-single-ok', { enter: true, enterDelayMs: 150 });
      await sleep(800);
      assert.match(await capturePane(paneId, 20), /^ar-single-ok$/m);
    });

    await t.test('多行文本进同一个输入缓冲，Enter 后才一次性执行', async () => {
      await sendKeys(paneId, 'echo L1\necho L2\necho L3', { enter: false });
      await sleep(600);

      const beforeEnter = await capturePane(paneId, 30);
      // 曾经的 bug：手工拼 ESC[200~ 时 tmux 吃掉 LF，三行被拼成 "echo L1echo L2echo L3"
      assert.doesNotMatch(beforeEnter, /L1echo/, '换行被吞了');
      assert.match(beforeEnter, /^echo L2$/m, '第二行没有独立成行');
      assert.equal(/^L1$/m.test(beforeEnter), false, '不该在 Enter 之前就执行');

      tmux(['send-keys', '-t', paneId, 'Enter']);
      await sleep(900);

      const after = await capturePane(paneId, 40);
      for (const line of ['L1', 'L2', 'L3']) {
        assert.ok(new RegExp(`^${line}$`, 'm').test(after), `${line} 没有被执行`);
      }
    });

    await t.test('长文本走 paste buffer，不撞 argv 上限', async () => {
      const long = 'x'.repeat(5000);
      await sendKeys(paneId, `echo ${long} | wc -c`, { enter: true, enterDelayMs: 200 });
      await sleep(1200);
      assert.match(await capturePane(paneId, 120), /^\s*5001$/m);
    });

    await t.test('不留 tmux buffer 垃圾', () => {
      let buffers = '';
      try {
        buffers = tmux(['list-buffers']);
      } catch {
        buffers = ''; // 一个 buffer 都没有时 tmux 返回非 0
      }
      assert.doesNotMatch(buffers, /agent-remote-/);
    });

    await t.test('拒绝非 %N 的 target（绝不降维到 window）', async () => {
      await assert.rejects(() => sendKeys('ops:1.1', 'x'), /非法 pane id/);
      await assert.rejects(() => sendKeys(paneId, ''), /空文本/);
    });
  },
);
