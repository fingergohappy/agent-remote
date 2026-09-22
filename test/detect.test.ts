import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectClaude } from '../src/providers/claude/detect.ts';
import { detectCodex } from '../src/providers/codex/detect.ts';
import { detectPi } from '../src/providers/pi/detect.ts';
import { detectBest, registerProvider, resetRegistry } from '../src/providers/registry.ts';
import { claudeProvider } from '../src/providers/claude/index.ts';
import { codexProvider } from '../src/providers/codex/index.ts';
import { piProvider } from '../src/providers/pi/index.ts';
import type { DetectContext } from '../src/providers/types.ts';

function ctx(partial: Partial<DetectContext>): DetectContext {
  return {
    paneId: '%1',
    fgCommand: 'zsh',
    panePid: 100,
    paneTty: '/dev/pts/5',
    title: '',
    cwd: '/home/u/proj',
    processTree: [],
    ...partial,
  };
}

const shell = { pid: 100, ppid: 1, comm: 'zsh', args: '-zsh', stat: 'Ss', tty: 'pts/5' };

test('进程树缺失时退回 pane_current_command，同名才认领', () => {
  const hit = detectClaude(ctx({ fgCommand: 'claude' }));
  assert.equal(hit?.providerId, 'claude');
  assert.ok((hit?.confidence ?? 0) >= 0.9);
  assert.equal(detectClaude(ctx({ fgCommand: 'node' })), null);
});

test('codex 伪装成 node 时靠进程树识别（D4）', () => {
  const hit = detectCodex(
    ctx({
      fgCommand: 'node',
      processTree: [
        {
          pid: 100,
          ppid: 1,
          comm: 'node',
          args: 'node /usr/lib/node_modules/@openai/codex/bin/codex.js',
          stat: 'Sl+',
          tty: 'pts/5',
        },
        {
          pid: 101,
          ppid: 100,
          comm: 'codex-x86_64-un',
          args: '/opt/vendor/x86_64-unknown-linux-musl/bin/codex',
          stat: 'Sl+',
          tty: 'pts/5',
        },
      ],
    }),
  );
  assert.equal(hit?.providerId, 'codex');
  assert.ok((hit?.confidence ?? 0) >= 0.8);
});

test('claude 跑在 node 包装器下也能认出来', () => {
  const hit = detectClaude(
    ctx({
      fgCommand: 'node',
      processTree: [
        {
          pid: 100,
          ppid: 1,
          comm: 'node',
          args: 'node /home/u/.npm/@anthropic-ai/claude-code/cli.js',
          stat: 'Sl+',
          tty: 'pts/5',
        },
      ],
    }),
  );
  assert.equal(hit?.providerId, 'claude');
});

test('pager 打开叫 claude 的文件不被认领 —— args 命中只对解释器包装有效', () => {
  // less 的 args 是 `less /notes/claude`，尾部 /claude 会命中 args 正则；
  // 但 comm 不是 node/bun 这类解释器，认领它等于把手机消息打进 pager
  const tree = [
    shell,
    { pid: 200, ppid: 100, comm: 'less', args: 'less /notes/claude', stat: 'S+', tty: 'pts/5' },
  ];
  assert.equal(detectClaude(ctx({ fgCommand: 'less', processTree: tree })), null);

  const tail = [
    shell,
    { pid: 200, ppid: 100, comm: 'tail', args: 'tail -f codex', stat: 'S+', tty: 'pts/5' },
  ];
  assert.equal(detectCodex(ctx({ fgCommand: 'tail', processTree: tail })), null);
});

test('args 里恰好出现名字不算：编辑 claude.md 的 nvim 不被认领', () => {
  const tree = [shell, { pid: 200, ppid: 100, comm: 'nvim', args: 'nvim claude.md', stat: 'S+', tty: 'pts/5' }];
  assert.equal(detectClaude(ctx({ fgCommand: 'nvim', processTree: tree })), null);
  assert.equal(detectCodex(ctx({ fgCommand: 'nvim', processTree: tree })), null);
});

test('Ctrl-Z 挂起的 claude 不认领——按键此时会直达 shell', () => {
  const tree = [
    shell,
    { pid: 200, ppid: 100, comm: 'nvim', args: 'nvim foo.ts', stat: 'S+', tty: 'pts/5' },
    { pid: 300, ppid: 100, comm: 'claude', args: 'claude', stat: 'Tl', tty: 'pts/5' },
  ];
  assert.equal(detectClaude(ctx({ fgCommand: 'nvim', processTree: tree })), null);
});

test('嵌套终端（nvim :term）里的 claude 不认领——tty 不是 pane 的', () => {
  const tree = [
    shell,
    { pid: 200, ppid: 100, comm: 'nvim', args: 'nvim', stat: 'S+', tty: 'pts/5' },
    { pid: 300, ppid: 200, comm: 'claude', args: 'claude', stat: 'Ssl+', tty: 'pts/9' },
  ];
  assert.equal(detectClaude(ctx({ fgCommand: 'nvim', processTree: tree })), null);
});

test('不在前台进程组（setsid/nohup 起的）不认领', () => {
  const tree = [shell, { pid: 300, ppid: 100, comm: 'claude', args: 'claude', stat: 'Ssl', tty: 'pts/5' }];
  assert.equal(detectClaude(ctx({ processTree: tree })), null);
});

test('claude 用 Bash 工具跑 codex 子进程时，pane 归更浅的 claude', () => {
  resetRegistry();
  registerProvider(claudeProvider);
  registerProvider(codexProvider);

  const hit = detectBest(
    ctx({
      fgCommand: 'node',
      processTree: [
        shell,
        {
          pid: 200,
          ppid: 100,
          comm: 'node',
          args: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
          stat: 'Sl+',
          tty: 'pts/5',
        },
        { pid: 300, ppid: 200, comm: 'bash', args: 'bash -c codex exec …', stat: 'S+', tty: 'pts/5' },
        { pid: 400, ppid: 300, comm: 'codex', args: '/usr/local/bin/codex exec …', stat: 'Sl+', tty: 'pts/5' },
      ],
    }),
  );
  assert.equal(hit?.result.providerId, 'claude');
  resetRegistry();
});

test('前台是 pi 时认领为 pi', () => {
  const hit = detectPi(
    ctx({
      fgCommand: 'pi',
      processTree: [shell, { pid: 300, ppid: 100, comm: 'pi', args: 'pi', stat: 'Ssl+', tty: 'pts/5' }],
    }),
  );
  assert.equal(hit?.providerId, 'pi');
  assert.ok((hit?.confidence ?? 0) >= 0.8);
});

test('node 包装器跑 pi-coding-agent 也能认出来', () => {
  const hit = detectPi(
    ctx({
      fgCommand: 'node',
      processTree: [
        {
          pid: 100,
          ppid: 1,
          comm: 'node',
          args: 'node /home/u/.npm/@earendil-works/pi-coding-agent/dist/cli.js',
          stat: 'Sl+',
          tty: 'pts/5',
        },
      ],
    }),
  );
  assert.equal(hit?.providerId, 'pi');
});

test('两个 provider 竞争时各归其主', () => {
  resetRegistry();
  registerProvider(claudeProvider);
  registerProvider(codexProvider);
  registerProvider(piProvider);

  const claudePane = detectBest(
    ctx({
      fgCommand: 'claude',
      processTree: [shell, { pid: 300, ppid: 100, comm: 'claude', args: 'claude', stat: 'Ssl+', tty: 'pts/5' }],
    }),
  );
  assert.equal(claudePane?.result.providerId, 'claude');

  const codexPane = detectBest(
    ctx({
      fgCommand: 'codex',
      processTree: [shell, { pid: 300, ppid: 100, comm: 'codex', args: 'codex', stat: 'Ssl+', tty: 'pts/5' }],
    }),
  );
  assert.equal(codexPane?.result.providerId, 'codex');

  const piPane = detectBest(
    ctx({
      fgCommand: 'pi',
      processTree: [shell, { pid: 300, ppid: 100, comm: 'pi', args: 'pi', stat: 'Ssl+', tty: 'pts/5' }],
    }),
  );
  assert.equal(piPane?.result.providerId, 'pi');
  resetRegistry();
});

test('无痕迹的 pane 不产生实例', () => {
  resetRegistry();
  registerProvider(claudeProvider);
  registerProvider(codexProvider);
  registerProvider(piProvider);
  assert.equal(
    detectBest(
      ctx({
        fgCommand: 'go',
        processTree: [shell, { pid: 300, ppid: 100, comm: 'go', args: 'go run .', stat: 'Sl+', tty: 'pts/5' }],
      }),
    ),
    null,
  );
  resetRegistry();
});
