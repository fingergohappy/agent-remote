/**
 * 绑定时怎么选工位（modules.md §4.10 bind-flow）。
 *
 * 主路径：绑一个 agent 就给它开一个话题。
 *   命令台(All/General)里点绑定 → 新建话题
 *   已经在某个话题里点绑定       → 就地换绑，不另开
 *   话题建不出来（Bot 没开 threads / 老式群）→ 才退化成整个会话一个工位
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentButtons,
  bindPane,
  pruneStaleBindings,
  reconcileBindings,
  unbind,
} from '../src/app/bind-flow.ts';
import type { AppContext, TopicEnsureResult, TopicManager } from '../src/app/context.ts';
import { loadConfig } from '../src/config.ts';
import { ActivityTracker } from '../src/core/activity.ts';
import { AgentIndex } from '../src/core/agent-index.ts';
import { BindStore, computeFingerprint } from '../src/core/bind-store.ts';
import { DecisionBroker } from '../src/core/decision-broker.ts';
import { EchoGuard } from '../src/core/echo-guard.ts';
import { EgressQueue, type Transport } from '../src/core/egress-queue.ts';
import { instanceTitle, projectLabel, sortForDisplay } from '../src/core/discover.ts';
import { registerProvider, resetRegistry } from '../src/providers/registry.ts';
import type { AgentProvider } from '../src/providers/types.ts';

function tmux(args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8', timeout: 5000 });
}

function hasTmux(): boolean {
  try {
    tmux(['-V']);
    return true;
  } catch {
    return false;
  }
}

/** 只认领指定 pane 的假 provider —— 让 discover 结果完全可控 */
function fakeProvider(paneIds: string[]): AgentProvider {
  return {
    id: 'fake',
    displayName: 'Fake Agent',
    capabilities: {
      semanticPermission: false,
      structuredQuestion: false,
      nativeTranscript: false,
      resumeSession: false,
      spawnFromBot: false,
      activitySuppress: false,
    },
    detect: (ctx) =>
      paneIds.includes(ctx.paneId) ? { providerId: 'fake', confidence: 1, label: 'fake' } : null,
    normalizeIngress: () => null,
  };
}

type TopicCalls = {
  created: string[];
  renamed: { threadId: number; title: string }[];
  closed: number[];
  deleted: number[];
  verified: number[];
};

function harness(
  canCreateTopic: boolean,
  canCloseTopic = true,
  topicAlive = true,
): {
  app: AppContext;
  calls: TopicCalls;
  sent: string[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'agent-remote-bind-'));
  const config = {
    ...loadConfig(
      { AGENT_REMOTE_HOME: dir, TELEGRAM_BOT_TOKEN: 'x', ALLOWED_USERS: '1', INGRESS_SECRET: 's' },
      { strict: false },
    ),
    sessionAllowlist: [] as string[], // 不限 session，测试用的临时 session 才能被扫到
  };

  const calls: TopicCalls = { created: [], renamed: [], closed: [], deleted: [], verified: [] };
  let nextThread = 100;
  const topics: TopicManager = {
    async createTopic(_chatId, title): Promise<TopicEnsureResult> {
      calls.created.push(title);
      // 建不出来时退化到主聊天流（threadId 0）
      if (!canCreateTopic) return { threadId: 0, created: false, degraded: true };
      return { threadId: ++nextThread, created: true, degraded: false };
    },
    async renameTopic(_chatId, threadId, title) {
      calls.renamed.push({ threadId, title });
    },
    async closeTopic(_chatId, threadId) {
      calls.closed.push(threadId);
      return canCloseTopic; // 私聊话题关不掉
    },
    async deleteTopic(_chatId, threadId) {
      calls.deleted.push(threadId);
      return true;
    },
    linkTo(_chatId, threadId) {
      return threadId ? `https://t.me/c/0/${threadId}` : null;
    },
    async verifyTopic(_chatId, threadId) {
      calls.verified.push(threadId);
      return topicAlive;
    },
  };

  const sent: string[] = [];
  const transport: Transport = {
    async sendMessage(job) {
      sent.push(job.text);
      return { messageId: 1 };
    },
    async editMessage(job) {
      return { messageId: job.messageId };
    },
  };

  const app: AppContext = {
    config,
    store: new BindStore(join(dir, 'bindings.json')),
    index: new AgentIndex(),
    activity: new ActivityTracker(config.terminalActiveWindowMs),
    echo: new EchoGuard(),
    broker: new DecisionBroker(join(dir, 'run'), 1000),
    egress: new EgressQueue(transport),
    topics,
  };

  return { app, calls, sent, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('bind-flow 选工位', { skip: !hasTmux() }, async (t) => {
  const session = `agent-remote-bind-${process.pid}`;
  tmux(['new-session', '-d', '-s', session, '-x', '80', '-y', '24', 'sh']);
  tmux(['split-window', '-t', session, 'sh']);
  t.after(() => {
    try {
      tmux(['kill-session', '-t', session]);
    } catch {
      /* 已经没了 */
    }
    resetRegistry();
  });
  await new Promise((r) => setTimeout(r, 500));

  const panes = tmux(['list-panes', '-t', session, '-F', '#{pane_id}']).trim().split('\n');
  const [paneA, paneB] = panes as [string, string];

  resetRegistry();
  registerProvider(fakeProvider([paneA, paneB]));

  await t.test('命令台里绑定 → 给它开一个专属话题', async () => {
    const h = harness(true);
    const r = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.created, true);
    assert.ok(r.ok && r.binding.threadId > 0);
    assert.equal(h.calls.created.length, 1);
    h.cleanup();
  });

  await t.test('绑一个 agent 开一个话题，两者互不串键', async () => {
    const h = harness(true);
    const a = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    const b = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneB });
    assert.equal(a.ok && b.ok, true);
    assert.notEqual(a.ok && a.binding.threadId, b.ok && b.binding.threadId);
    assert.equal(h.calls.created.length, 2, '每个 agent 各建一个话题');
    h.cleanup();
  });

  await t.test('在命令台点一个已经有工位的 agent → 复用，绝不再开一个', async () => {
    // 不挡住的话：每点一次列表里那行就多一个话题，绑定迁到新的，旧话题变孤儿。
    // 私聊话题没有深链、点不进去，用户只会以为「没反应」，然后再点几下。
    const h = harness(true);
    const first = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const again = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    assert.equal(again.ok, true);
    if (!again.ok) return;

    assert.equal(again.reused, true);
    assert.equal(again.created, false);
    assert.equal(again.binding.threadId, first.binding.threadId, '还是原来那个工位');
    assert.equal(h.calls.created.length, 1, '第二次不该再建话题');
    assert.equal(h.app.store.list('111').length, 1);
    h.cleanup();
  });

  await t.test('复用前先探话题；话题已被删就清掉僵尸记录、重新建一个', async () => {
    // 绑定是持久化的，话题却可能早被用户删了 —— 而删除没有事件（D17）。
    // 不探就复用会把人卡死：点它只弹提示不重绑，想 /unbind 又得在
    // 那个已经不存在的话题里发命令。
    const h = harness(true, true, false); // topicAlive = false
    const first = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const again = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    assert.equal(again.ok, true);
    if (!again.ok) return;

    assert.deepEqual(h.calls.verified, [first.binding.threadId], '复用前必须探一下');
    assert.equal(again.reused, false, '话题没了就不该复用');
    assert.equal(again.created, true, '要给它建个新家');
    assert.notEqual(again.binding.threadId, first.binding.threadId);
    assert.equal(h.app.store.list('111').length, 1, '僵尸记录不能留着');
    assert.equal(h.app.store.getByThread('111', first.binding.threadId), null);
    h.cleanup();
  });

  await t.test('话题还活着才复用，且探测只做一次', async () => {
    const h = harness(true, true, true);
    const first = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const again = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    assert.equal(again.ok && again.reused, true);
    assert.deepEqual(h.calls.verified, [first.binding.threadId]);
    assert.equal(h.calls.created.length, 1);
    h.cleanup();
  });

  await t.test('在话题里点绑定不触发探测 —— 消息刚从这儿来，它显然活着', async () => {
    const h = harness(true, true, false);
    await bindPane(h.app, { chatId: '111', currentThreadId: 77, paneId: paneA });
    assert.deepEqual(h.calls.verified, [], '白探一次就白留一条「话题已修改」');
    h.cleanup();
  });

  await t.test('已经在某个话题里点绑定 → 就地换绑，不另开', async () => {
    const h = harness(true);
    const r = await bindPane(h.app, { chatId: '111', currentThreadId: 77, paneId: paneA });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.binding.threadId, 77);
    assert.deepEqual(h.calls.created, [], '当前话题够用，不该再开一个');
    assert.equal(h.calls.renamed[0]?.threadId, 77, '话题名要跟着换成新 agent');
    h.cleanup();
  });

  await t.test('建不出话题时才退化成单工位', async () => {
    const h = harness(false);
    const r = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.binding.threadId, 0);
    assert.equal(r.ok && r.degraded, true);
    h.cleanup();
  });

  await t.test('单工位下绑第二个 agent 才拒绝，且不破坏已有绑定', async () => {
    const h = harness(false);
    await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    const r = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneB });

    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : '', new RegExp(paneA));
    assert.equal(h.app.store.getByThread('111', 0)?.paneId, paneA);
    h.cleanup();
  });

  await t.test('单工位下重绑同一个 pane 是幂等的', async () => {
    const h = harness(false);
    await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    const r = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    assert.equal(r.ok, true);
    h.cleanup();
  });

  await t.test('unbind 后自动关闭话题（保留历史，不删）', async () => {
    const h = harness(true);
    const r = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    const outcome = await unbind(h.app, { chatId: '111', threadId: r.binding.threadId });
    assert.equal(outcome?.removed.paneId, paneA);
    assert.equal(outcome?.topicClosed, true);
    assert.deepEqual(h.calls.closed, [r.binding.threadId], '话题该被关掉');
    assert.equal(h.app.store.getByThread('111', r.binding.threadId), null);
    h.cleanup();
  });

  await t.test('关不掉话题时如实返回，交给上层给删除按钮', async () => {
    // 私聊话题：createForumTopic 能用，closeForumTopic 报 not a supergroup forum
    const h = harness(true, false);
    const r = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    const outcome = await unbind(h.app, { chatId: '111', threadId: r.binding.threadId });
    assert.equal(outcome?.topicClosed, false, '关不掉就得说关不掉');
    assert.deepEqual(h.calls.deleted, [], '删除是破坏性的，不能自动做');
    assert.equal(h.app.store.getByThread('111', r.binding.threadId), null, '绑定仍要清掉');
    h.cleanup();
  });

  await t.test('单工位（threadId 0）解绑时没有话题可关', async () => {
    const h = harness(false);
    await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    await unbind(h.app, { chatId: '111', threadId: 0 });
    assert.deepEqual(h.calls.closed, [], '主聊天流关不了，也不该去试');
    h.cleanup();
  });

  await t.test('/cleanup 只清话题没了的，活着的一条不动', async () => {
    const h = harness(true);
    const a = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    const b = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneB });
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;

    // 只有 paneA 那个话题被用户删了
    const deadThread = a.binding.threadId;
    h.app.topics.verifyTopic = async (_c, threadId) => threadId !== deadThread;

    const r = await pruneStaleBindings(h.app, '111');

    assert.equal(r.checked, 2);
    assert.deepEqual(
      r.removed.map((x) => x.paneId),
      [paneA],
    );
    assert.equal(h.app.store.getByThread('111', deadThread), null, '死的要清掉');
    assert.equal(h.app.store.getByThread('111', b.binding.threadId)?.paneId, paneB, '活的不许动');
    h.cleanup();
  });

  await t.test('/cleanup 不去探主聊天流 —— 它不会消失', async () => {
    const h = harness(false); // 降级模式，threadId 0
    await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });

    const r = await pruneStaleBindings(h.app, '111');
    assert.equal(r.checked, 0);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(h.calls.verified, [], '白探一次就白留一条痕');
    assert.equal(h.app.store.getByThread('111', 0)?.paneId, paneA);
    h.cleanup();
  });

  await t.test('pane 被关掉 → 对账时自动解绑，用不着话题那一侧配合', async () => {
    // pane 那一侧随时可查（tmux 随便问），所以这条路不依赖任何探测，
    // 60s 一轮的 reconcileBindings 就能清。真机验，不是嘴上说。
    const h = harness(true);
    tmux(['split-window', '-t', session, 'sh']);
    await new Promise((r) => setTimeout(r, 400));
    const all = tmux(['list-panes', '-t', session, '-F', '#{pane_id}']).trim().split('\n');
    const doomed = all[all.length - 1]!;

    resetRegistry();
    registerProvider(fakeProvider([paneA, paneB, doomed]));

    const r = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: doomed });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(h.app.store.getByThread('111', r.binding.threadId)?.paneId, doomed);

    tmux(['kill-pane', '-t', doomed]);
    await new Promise((res) => setTimeout(res, 400));

    await reconcileBindings(h.app);

    assert.equal(h.app.store.getByThread('111', r.binding.threadId), null, 'pane 没了就该解绑');
    assert.match(h.sent.join('\n'), /pane 已消失/);

    resetRegistry();
    registerProvider(fakeProvider([paneA, paneB]));
    h.cleanup();
  });

  await t.test('pane 和话题同时没了：先清绑定再发通知，通知失败也不回滚', async () => {
    // 这是最坏组合。关键在顺序：store.remove 在 enqueue 之前，
    // 所以「通知发不出去」绝不会让绑定活下来。
    const h = harness(true);
    tmux(['split-window', '-t', session, 'sh']);
    await new Promise((r) => setTimeout(r, 400));
    const all = tmux(['list-panes', '-t', session, '-F', '#{pane_id}']).trim().split('\n');
    const doomed = all[all.length - 1]!;

    resetRegistry();
    registerProvider(fakeProvider([paneA, paneB, doomed]));

    const r = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: doomed });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    // 话题也被用户删了：往它发什么都失败
    const deadThread = r.binding.threadId;
    h.app.egress = new EgressQueue({
      async sendMessage(job) {
        if (job.threadId === deadThread) {
          throw new Error('Bad Request: message thread not found');
        }
        return { messageId: 1 };
      },
      async editMessage(job) {
        return { messageId: job.messageId };
      },
    });

    tmux(['kill-pane', '-t', doomed]);
    await new Promise((res) => setTimeout(res, 400));

    await reconcileBindings(h.app);

    assert.equal(h.app.store.getByThread('111', deadThread), null, '两边都没了更该清掉');
    assert.equal(h.app.store.list('111').length, 0);

    resetRegistry();
    registerProvider(fakeProvider([paneA, paneB]));
    h.cleanup();
  });

  await t.test('话题名带 paneId', () => {
    const title = instanceTitle({
      paneId: '%22',
      providerId: 'codex',
      cwd: '/home/u/code/agent-remote',
      display: 'ops:2.3',
    });
    assert.match(title, /%22/);
    assert.match(title, /codex/);
    assert.match(title, /agent-remote/);
    assert.ok(title.length <= 128, 'Telegram 话题名上限 128');
  });

  await t.test('绑定写入的 fingerprint 与 pane 实际 pid 一致', async () => {
    const h = harness(true);
    const r = await bindPane(h.app, { chatId: '111', currentThreadId: 0, paneId: paneA });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const pid = Number(tmux(['display-message', '-p', '-t', paneA, '#{pane_pid}']).trim());
    assert.equal(r.binding.fingerprint, computeFingerprint(paneA, pid, 'fake'));
    assert.equal(await h.app.store.validate(r.binding), 'ok');
    h.cleanup();
  });
});

const INST = {
  paneId: '%1',
  display: 'a:1.1',
  providerId: 'claude',
  label: 'claude',
  title: '',
  cwd: '/home/u/proj',
  fg: 'claude',
  pid: 1,
  confidence: 1,
  fingerprint: 'x',
};

const linkFor = (threadId: number): string => `https://t.me/c/0/${threadId}`;

test('未绑定的话题会给一个删除出口', () => {
  const withDelete = agentButtons([INST], new Map(), { disposableThreadId: 3769 });
  const tail = withDelete[withDelete.length - 1]!;
  assert.equal(tail.length, 2);
  assert.equal(tail[1]!.callbackData, 'td:3769');

  // 已绑定的话题不该出现「删掉这个空话题」
  const plain = agentButtons([INST], new Map());
  assert.equal(plain[plain.length - 1]!.length, 1);
});

test('已绑定：有深链时 = [🔗 进去] + [🔓 解绑]', () => {
  // callback 按钮点了只能回调，没法让客户端跳转；url 按钮可以。
  // 所以「进去」必须走 url，否则一次点击进不去。
  const row = agentButtons([INST], new Map([['%1', 3793]]), { linkFor })[0]!;
  assert.equal(row.length, 2);
  assert.equal(row[0]!.url, 'https://t.me/c/0/3793');
  assert.equal(row[0]!.callbackData, undefined, 'url 按钮不该再带 callback_data');
  assert.match(row[0]!.text, /^🔗/);

  assert.equal(row[1]!.callbackData, 'u:3793');
  assert.equal(row[1]!.url, undefined);
});

test('已绑定：没深链（私聊）时整行就是解绑按钮', () => {
  const row = agentButtons([INST], new Map([['%1', 3793]]), { linkFor: () => null })[0]!;
  assert.equal(row.length, 1);
  assert.equal(row[0]!.callbackData, 'u:3793', '点它只断开绑定');
  assert.match(row[0]!.text, /^🔓/);
  assert.match(row[0]!.text, /%1/, '还得看得出是哪个 agent');
});

test('文字列表与按钮同序 —— 错位就会点错 agent', () => {
  const mk = (paneId: string, display: string, cwd: string): typeof INST => ({
    ...INST,
    paneId,
    display,
    cwd,
    providerId: 'claude',
  });
  const raw = [
    mk('%88', 'ops:3.2', '/home/u/a'),
    mk('%8', 'daily:1.1', '/home/u/b'),
    mk('%9', 'ops:1.2', '/home/u/c'),
    mk('%21', 'ops:2.1', '/home/u/d'),
  ];
  const sorted = sortForDisplay(raw);

  // 先 session 后坐标，且坐标要按数字比（2.1 在 3.2 前，不是字符串序）
  assert.deepEqual(
    sorted.map((i) => i.display),
    ['daily:1.1', 'ops:1.2', 'ops:2.1', 'ops:3.2'],
  );

  // 按钮就是照这个顺序排的
  const rows = agentButtons(sorted, new Map(), { linkFor: () => null });
  assert.deepEqual(
    rows.slice(0, -1).map((r) => r[0]!.text.match(/%\d+/)?.[0]),
    ['%8', '%9', '%21', '%88'],
  );
});

test('家目录的项目名是 ~，不是用户名', () => {
  // basename('/home/finger') === 'finger'，拿它当项目名毫无信息量
  assert.equal(projectLabel({ cwd: homedir(), display: 'a:1.1' }), '~');
  assert.equal(projectLabel({ cwd: '/home/u/code/proj', display: 'a:1.1' }), 'proj');
});

test('列表里的按钮绝不触发删除 —— 话题和历史必须留着', () => {
  // D8：对话历史只存在于 Telegram 话题里。列表上一个误触就毁掉一整段对话，
  // 这个代价太大。删话题只能是显式动作（话题里 /unbind 后再点删除按钮）。
  const rows = agentButtons([INST], new Map([['%1', 3793]]), { linkFor });
  const all = rows.flat().map((b) => b.callbackData ?? '');
  assert.equal(
    all.some((d) => d.startsWith('td:')),
    false,
  );
});

test('还没绑的 agent 只能是 callback —— 话题还不存在，没链接可给', () => {
  const row = agentButtons([INST], new Map(), { linkFor })[0]![0]!;
  assert.equal(row.callbackData, 'b:%1');
  assert.equal(row.url, undefined);
  assert.match(row.text, /^➕/);
});

test('降级模式（threadId 0）既没话题可跳也没话题可删', () => {
  // 整个会话一个工位时 agent 就在主聊天流里：删它等于删掉整个对话。
  // 维持幂等的绑定按钮，要解绑就在这儿直接 /unbind。
  const row = agentButtons([INST], new Map([['%1', 0]]), { linkFor })[0]!;
  assert.equal(row.length, 1);
  assert.equal(row[0]!.url, undefined);
  assert.equal(row[0]!.callbackData, 'b:%1');
  assert.equal(row[0]!.callbackData?.startsWith('td:'), false, '绝不能生成 td:0');
});
