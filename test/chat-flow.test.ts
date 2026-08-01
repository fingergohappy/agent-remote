/**
 * Topic 里打字 → pane（modules.md §4.10 chat-flow）。
 *
 * 重点是「绑定失效时把四份缓存都清干净」这个契约：store / activity / index /
 * mirror 游标 / echo 记录分散在五个对象里，漏掉任何一个都不会报错，只会在很久
 * 之后表现成「pane 换人了还在往里投」或「镜像从一个早就换掉的 offset 接着读」。
 * 曾经漏过 mirror，所以这里逐个盯住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUserText } from '../src/app/chat-flow.ts';
import type { AppContext } from '../src/app/context.ts';
import { loadConfig } from '../src/config.ts';
import { AgentIndex } from '../src/core/agent-index.ts';
import { BindStore, type Binding } from '../src/core/bind-store.ts';
import { DecisionBroker } from '../src/core/decision-broker.ts';
import { EchoGuard } from '../src/core/echo-guard.ts';
import { EgressQueue, type Transport } from '../src/core/egress-queue.ts';

/** tmux 里绝不会存在的 pane —— validate 必然判死，不需要真机 */
const DEAD_PANE = '%999999';

function binding(over: Partial<Binding> = {}): Binding {
  const now = new Date().toISOString();
  return {
    chatId: '111',
    threadId: 42,
    paneId: DEAD_PANE,
    fingerprint: 'deadbeefdeadbeef',
    providerId: 'claude',
    display: 'ops:1.1',
    title: '🤖 %999999 claude',
    ownedByUs: false,
    notifyLevel: 'info',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function harness(t: { after(fn: () => void): void }): {
  app: AppContext;
  forgotten: string[];
} {
  const dir = mkdtempSync(join(tmpdir(), 'agent-remote-chat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const config = loadConfig(
    { AGENT_REMOTE_HOME: dir, TELEGRAM_BOT_TOKEN: 'x', ALLOWED_USERS: '1', INGRESS_SECRET: 's' },
    { strict: false },
  );

  const transport: Transport = {
    async sendMessage() {
      return { messageId: 1 };
    },
    async editMessage(job) {
      return { messageId: job.messageId };
    },
  };

  const forgotten: string[] = [];
  const app: AppContext = {
    config,
    store: new BindStore(join(dir, 'bindings.json')),
    index: new AgentIndex(),
    echo: new EchoGuard(),
    broker: new DecisionBroker(1000),
    egress: new EgressQueue(transport),
    mirror: {
      forget: (paneId) => void forgotten.push(paneId),
      kick: () => {},
      isMirroring: () => false,
    },
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

  return { app, forgotten };
}

test('没绑定的话题不往任何 pane 投', async (t) => {
  const { app } = harness(t);
  const r = await handleUserText(app, { chatId: '111', threadId: 42, text: '你好' });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'no_binding');
});

test('pane 已死 → 解绑并清光所有 per-pane 缓存', async (t) => {
  const { app, forgotten } = harness(t);
  const b = binding();
  app.store.upsert(b);

  // 先把各处都塞上这个 pane 的痕迹，才能验证真的被清掉
  app.index.noteEvent({ paneId: b.paneId, providerId: 'claude', sessionId: 'sess-1' });
  app.echo.note(b.paneId, '之前发过的话');

  const r = await handleUserText(app, { chatId: '111', threadId: 42, text: '在吗' });

  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'send_failed');
  assert.match(r.ok === false ? r.message : '', /已自动解绑/);

  assert.equal(app.store.getByThread('111', 42), null, 'store 里的绑定要没');
  assert.equal(app.index.get(b.paneId), undefined, 'index 反查要清');
  assert.equal(app.echo.consume(b.paneId, '之前发过的话'), false, '回声记录要清');
  assert.deepEqual(forgotten, [b.paneId], 'mirror 游标要清 —— 漏了会从旧 offset 接着读');
});

test('pane 已死时不会把这句话记进回声表', async (t) => {
  const { app } = harness(t);
  app.store.upsert(binding());

  await handleUserText(app, { chatId: '111', threadId: 42, text: '没发出去的话' });

  // 压根没送到 pane，agent 的 transcript 里不会有它；
  // 记进回声表只会让日后一句一模一样的真消息被无声吞掉。
  assert.equal(app.echo.consume(DEAD_PANE, '没发出去的话'), false);
});
