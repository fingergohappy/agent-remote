/**
 * e2e：hook → ingress → provider.normalize → notify-flow → egress（mock 出站）。
 * 覆盖 MVP 验收 3：两个 provider 的事件各回各的 Topic。
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from '../src/config.ts';
import { ActivityTracker } from '../src/core/activity.ts';
import { AgentIndex } from '../src/core/agent-index.ts';
import { BindStore, computeFingerprint, type Binding } from '../src/core/bind-store.ts';
import { DecisionBroker } from '../src/core/decision-broker.ts';
import { EchoGuard } from '../src/core/echo-guard.ts';
import { EgressQueue, type Transport } from '../src/core/egress-queue.ts';
import { createIngressServer } from '../src/core/ingress-http.ts';
import { handleEvent } from '../src/app/notify-flow.ts';
import { resolveDecision } from '../src/app/decision-flow.ts';
import type { AppContext } from '../src/app/context.ts';
import { sign } from '../src/infra/http.ts';
import { registerProvider, resetRegistry } from '../src/providers/registry.ts';
import { claudeProvider } from '../src/providers/claude/index.ts';
import { codexProvider } from '../src/providers/codex/index.ts';

const SECRET = 'test-secret';

type Harness = {
  app: AppContext;
  url: string;
  sent: { chatId: string; threadId?: number; text: string }[];
  close: () => Promise<void>;
};

async function harness(t: TestContext, overrides: Partial<Config> = {}): Promise<Harness> {
  resetRegistry();
  registerProvider(claudeProvider);
  registerProvider(codexProvider);

  const dir = mkdtempSync(join(tmpdir(), 'agent-remote-e2e-'));
  const config: Config = {
    ...loadConfig(
      {
        AGENT_REMOTE_HOME: dir,
        TELEGRAM_BOT_TOKEN: 'x',
        ALLOWED_USERS: '1',
        INGRESS_SECRET: SECRET,
        INGRESS_PORT: '0',
      },
      { strict: false },
    ),
    ...overrides,
  };

  const sent: { chatId: string; threadId?: number; text: string }[] = [];
  let messageId = 0;
  const transport: Transport = {
    async sendMessage(job) {
      sent.push({ chatId: job.chatId, threadId: job.threadId, text: job.text });
      return { messageId: ++messageId };
    },
    async editMessage(job) {
      return { messageId: job.messageId };
    },
  };

  const broker = new DecisionBroker(join(dir, 'run'), 1500);
  const app: AppContext = {
    config,
    store: new BindStore(join(dir, 'bindings.json')),
    index: new AgentIndex(),
    activity: new ActivityTracker(config.terminalActiveWindowMs),
    echo: new EchoGuard(),
    broker,
    egress: new EgressQueue(transport),
    topics: {
      async createTopic() {
        return { threadId: 0, created: false, degraded: true };
      },
      async renameTopic() {},
      async closeTopic() {
        return false;
      },
      async deleteTopic() {
        return false;
      },
      linkTo() {
        return null;
      },
      async verifyTopic() {
        return true;
      },
    },
  };

  const server = createIngressServer({
    config,
    broker,
    onEvent: (event) => handleEvent(app, event),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const close = async (): Promise<void> => {
    broker.stopGc();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  };
  // 断言失败时也要收摊，否则 server 挂着，测试进程要空等到超时
  t.after(close);

  return { app, url: `http://127.0.0.1:${port}`, sent, close };
}

function bind(over: Partial<Binding>): Binding {
  const now = new Date().toISOString();
  return {
    chatId: '-100999',
    threadId: 1,
    paneId: '%14',
    fingerprint: computeFingerprint('%14', 1, 'claude'),
    providerId: 'claude',
    display: 'ops:1.1',
    title: '🤖 claude · proj',
    ownedByUs: false,
    notifyLevel: 'important',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

async function post(url: string, body: unknown, secret = SECRET): Promise<Response> {
  const payload = JSON.stringify(body);
  return fetch(`${url}/ingress`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Remote-Signature': sign(secret, payload),
    },
    body: payload,
  });
}

test('签名不对直接 401，不进 normalize', async (t) => {
  const h = await harness(t);
  const res = await post(h.url, { hook_event_name: 'Stop', paneId: '%14' }, 'wrong-secret');
  assert.equal(res.status, 401);
  assert.equal(h.sent.length, 0);
});

test('health 端点可用', async (t) => {
  const h = await harness(t);
  const res = await fetch(`${h.url}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { ok: boolean }).ok, true);
});

test('claude 与 codex 的完成事件各进各的 Topic（不串线）', async (t) => {
  const h = await harness(t);
  h.app.store.upsert(bind({ threadId: 11, paneId: '%14', providerId: 'claude' }));
  h.app.store.upsert(
    bind({
      threadId: 22,
      paneId: '%15',
      providerId: 'codex',
      fingerprint: computeFingerprint('%15', 2, 'codex'),
    }),
  );

  const r1 = await post(h.url, {
    hook_event_name: 'Stop',
    session_id: 'sess-c',
    paneId: '%14',
    provider: 'claude',
  });
  const r2 = await post(h.url, {
    type: 'agent-turn-complete',
    'last-assistant-message': 'codex 干完了',
    paneId: '%15',
    provider: 'codex',
  });

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(h.sent.length, 2);
  const claudeMsg = h.sent.find((s) => s.threadId === 11);
  const codexMsg = h.sent.find((s) => s.threadId === 22);
  assert.ok(claudeMsg && /完成/.test(claudeMsg.text));
  assert.ok(codexMsg && /codex 干完了/.test(codexMsg.text));

  // hook 带来的 session id 回写到了绑定，供 /history 精确定位
  assert.equal(h.app.store.getByPane('%14')?.sessionId, 'sess-c');
});

test('hook 事件到达即踢镜像；无绑定不踢', async (t) => {
  const h = await harness(t);
  let kicked = 0;
  h.app.mirror = {
    forget() {},
    kick() {
      kicked++;
    },
  };

  // 没绑定的 pane：不该白跑一轮镜像
  await post(h.url, { hook_event_name: 'Stop', paneId: '%77', provider: 'claude' });
  assert.equal(kicked, 0);

  h.app.store.upsert(bind({ threadId: 11, paneId: '%14' }));
  await post(h.url, { hook_event_name: 'Stop', session_id: 's1', paneId: '%14', provider: 'claude' });
  assert.ok(kicked >= 1, 'hook 到达应触发镜像增量读');
});

test('UserPromptSubmit 只打活跃度戳，不产生消息', async (t) => {
  const h = await harness(t);
  h.app.store.upsert(bind({ threadId: 11, paneId: '%14' }));

  await post(h.url, { hook_event_name: 'UserPromptSubmit', paneId: '%14', provider: 'claude' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.sent.length, 0);
  assert.equal(h.app.activity.isTerminalActive('%14'), true);
});

test('verbose 下不推「✅ 完成」—— 对话原文已经由镜像送达', async (t) => {
  const h = await harness(t);
  h.app.store.upsert(bind({ threadId: 11, paneId: '%14', notifyLevel: 'verbose' }));

  await post(h.url, { hook_event_name: 'Stop', paneId: '%14', provider: 'claude' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.sent.length, 0, '空洞的完成通知是噪声');

  // 但要你动手的事件镜像里没有，必须推
  await post(h.url, {
    hook_event_name: 'Notification',
    message: 'Claude is waiting for your input',
    paneId: '%14',
    provider: 'claude',
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.sent.length, 1);
});

test('important 下没有镜像，completed 仍是唯一信号，要推', async (t) => {
  const h = await harness(t);
  h.app.store.upsert(bind({ threadId: 11, paneId: '%14', notifyLevel: 'important' }));

  await post(h.url, { hook_event_name: 'Stop', paneId: '%14', provider: 'claude' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.sent.length, 1, '这时候不推就什么都看不到了');
});

test('显式打开终端静音后，completed 被压制但等人事件仍推', async (t) => {
  const h = await harness(t, { quietWhenTerminalActive: true });
  h.app.store.upsert(bind({ threadId: 11, paneId: '%14', notifyLevel: 'important' }));

  await post(h.url, { hook_event_name: 'UserPromptSubmit', paneId: '%14', provider: 'claude' });
  await new Promise((r) => setTimeout(r, 30));
  await post(h.url, { hook_event_name: 'Stop', paneId: '%14', provider: 'claude' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.sent.length, 0, 'completed 应被终端活跃压制');

  await post(h.url, {
    hook_event_name: 'Notification',
    message: 'Claude is waiting for your input',
    paneId: '%14',
    provider: 'claude',
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.sent.length, 1, '等人的事件不该被吞');
});

test('未绑定的 pane 事件不投递到任何 Topic', async (t) => {
  const h = await harness(t);
  await post(h.url, { hook_event_name: 'Stop', paneId: '%99', provider: 'claude' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.sent.length, 0);
});

test('未绑定的 pane 发来阻塞式授权 → 立刻放行，绝不 hold', async (t) => {
  // 没绑定就没人会去点那个按钮，hold 满超时只会让终端前的你干等着。
  // 立刻返回空响应，Claude 就地弹自己的 TUI。
  const h = await harness(t);

  const started = Date.now();
  const res = await post(h.url, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build' },
    correlationId: 'nobody-home',
    paneId: '%99', // 没绑定
    provider: 'claude',
  });
  const elapsed = Date.now() - started;

  assert.equal(res.status, 200);
  assert.ok(elapsed < 500, `不该等满 broker 超时，实际 ${elapsed}ms`);
  assert.equal(h.sent.length, 0, '没绑定就别推消息');

  const body = (await res.json()) as { ok: boolean; decided?: boolean };
  assert.equal(body.ok, true);
  assert.notEqual(body.decided, true, '没人拍板，不能声称已决策');
});

test('阻塞授权：hook 被 hold，用户点允许后拿到 hookResponse', async (t) => {
  const h = await harness(t);
  h.app.store.upsert(bind({ threadId: 11, paneId: '%14' }));

  const pending = post(h.url, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build' },
    correlationId: 'deadbeef',
    paneId: '%14',
    provider: 'claude',
  });

  // 等按钮消息发出去
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.text, /授权/);

  const outcome = await resolveDecision(h.app, {
    correlationId: 'deadbeef',
    decisionId: 'allow',
  });
  assert.equal(outcome.ok, true);

  const body = (await (await pending).json()) as {
    decided: boolean;
    hookResponse: { hookSpecificOutput?: { permissionDecision?: string } };
  };
  assert.equal(body.decided, true);
  assert.equal(body.hookResponse.hookSpecificOutput?.permissionDecision, 'allow');
});

test('没人点按钮 → 超时，hook 拿到 provider 的兜底响应（退回本机 TUI）', async (t) => {
  const h = await harness(t);
  h.app.store.upsert(bind({ threadId: 11, paneId: '%14' }));

  const res = await post(h.url, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    correlationId: 'cafe0000',
    paneId: '%14',
    provider: 'claude',
  });

  const body = (await res.json()) as { decided: boolean; timeout?: boolean; hookResponse: unknown };
  assert.equal(body.decided, false);
  assert.equal(body.timeout, true);
  assert.deepEqual(body.hookResponse, {}, '兜底响应必须是空对象，不能替用户 allow/deny');
});
