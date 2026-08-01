/**
 * 发送前的在场校验（verifyPresence）。
 *
 * 这是「手机消息绝不落进 shell」的最后一道闸：fingerprint 只证明 pane 没换人
 * （它的输入是 pane 根进程 pid，通常是 shell），agent 退出后 shell 回到前台时
 * fingerprint 依然匹配 —— 此时发送等于让 shell 执行那句话。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPresence } from '../src/core/discover.ts';
import { computeFingerprint } from '../src/core/bind-store.ts';
import type { TmuxPane } from '../src/infra/tmux.ts';
import type { ProcNode, ProcessSnapshot } from '../src/infra/process-tree.ts';
import { registerProvider, resetRegistry } from '../src/providers/registry.ts';
import { claudeProvider } from '../src/providers/claude/index.ts';

function pane(over: Partial<TmuxPane> = {}): TmuxPane {
  return {
    paneId: '%1',
    session: 'dev',
    window: 1,
    index: 1,
    fg: 'zsh',
    pid: 100,
    tty: '/dev/pts/5',
    title: '',
    cwd: '/home/u/proj',
    display: 'dev:1.1',
    ...over,
  };
}

function snapOf(nodes: ProcNode[]): ProcessSnapshot {
  const byPid = new Map(nodes.map((n) => [n.pid, n]));
  const children = new Map<number, number[]>();
  for (const n of nodes) {
    const list = children.get(n.ppid) ?? [];
    list.push(n.pid);
    children.set(n.ppid, list);
  }
  return { byPid, children };
}

const shell: ProcNode = { pid: 100, ppid: 1, comm: 'zsh', args: '-zsh', stat: 'Ss', tty: 'pts/5' };
const claude: ProcNode = {
  pid: 200,
  ppid: 100,
  comm: 'claude',
  args: 'claude',
  stat: 'Ssl+',
  tty: 'pts/5',
};

const binding = {
  paneId: '%1',
  fingerprint: computeFingerprint('%1', 100, 'claude'),
  providerId: 'claude',
};

function withClaude<T>(fn: () => T): T {
  resetRegistry();
  registerProvider(claudeProvider);
  try {
    return fn();
  } finally {
    resetRegistry();
  }
}

test('agent 仍是前台作业 → ok', async () => {
  await withClaude(async () => {
    const r = await verifyPresence(binding, {
      panes: [pane()],
      snap: snapOf([shell, claude]),
    });
    assert.equal(r, 'ok');
  });
});

test('agent 退出只剩 shell → agent_gone（此时发送会被 shell 执行）', async () => {
  await withClaude(async () => {
    const r = await verifyPresence(binding, {
      panes: [pane()],
      snap: snapOf([shell]),
    });
    assert.equal(r, 'agent_gone');
  });
});

test('agent 被 Ctrl-Z 挂起 → agent_gone（按键到不了它，前台是 shell）', async () => {
  await withClaude(async () => {
    const r = await verifyPresence(binding, {
      panes: [pane()],
      snap: snapOf([shell, { ...claude, stat: 'Tl' }]),
    });
    assert.equal(r, 'agent_gone');
  });
});

test('pane 消失 → pane_dead', async () => {
  await withClaude(async () => {
    const r = await verifyPresence(binding, { panes: [], snap: snapOf([]) });
    assert.equal(r, 'pane_dead');
  });
});

test('pane_pid 变了（tmux 重启后 %N 复用）→ fingerprint_mismatch', async () => {
  await withClaude(async () => {
    const r = await verifyPresence(binding, {
      panes: [pane({ pid: 999 })],
      snap: snapOf([shell, claude]),
    });
    assert.equal(r, 'fingerprint_mismatch');
  });
});

test('ps 快照拿不到时降级：pane_current_command 同名即放行', async () => {
  await withClaude(async () => {
    const r = await verifyPresence(binding, {
      panes: [pane({ fg: 'claude' })],
      snap: snapOf([]),
    });
    assert.equal(r, 'ok', 'detect 的降级路径（只信 tmux 前台命令）要能通过');
  });
});
