/** 镜像出站：绑定即推送，唯一的拦截是回声抑制（自己发的话不能绕回来）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMirrored } from '../src/app/mirror-flow.ts';
import type { AppContext } from '../src/app/context.ts';
import { loadConfig } from '../src/config.ts';
import { AgentIndex } from '../src/core/agent-index.ts';
import { BindStore, type Binding } from '../src/core/bind-store.ts';
import { DecisionBroker } from '../src/core/decision-broker.ts';
import { EchoGuard } from '../src/core/echo-guard.ts';
import { EgressQueue, type Transport } from '../src/core/egress-queue.ts';
import type { MirroredMessage } from '../src/core/transcript-watcher.ts';

function binding(over: Partial<Binding> = {}): Binding {
  const now = new Date().toISOString();
  return {
    chatId: '1',
    threadId: 10,
    paneId: '%1',
    fingerprint: 'x',
    providerId: 'claude',
    display: 'a:1.1',
    title: 't',
    ownedByUs: false,
    notifyLevel: 'info',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function harness(t: { after(fn: () => void): void }): { app: AppContext; sent: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-remote-mirror-flow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const config = loadConfig(
    {
      AGENT_REMOTE_HOME: dir,
      TELEGRAM_BOT_TOKEN: 'x',
      ALLOWED_USERS: '1',
      INGRESS_SECRET: 's',
    },
    { strict: false },
  );

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
    echo: new EchoGuard(),
    broker: new DecisionBroker(1000),
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
  return { app, sent };
}

function msg(b: Binding, text: string, role: 'user' | 'assistant' = 'assistant'): MirroredMessage {
  return { binding: b, item: { role, text, kind: 'message' } };
}

test('绑定即推送：镜像消息直达话题，无任何活跃度揣测', async (t) => {
  const { app, sent } = harness(t);
  const b = binding();

  await handleMirrored(app, [msg(b, 'agent 的回复')]);
  assert.equal(sent.length, 1);
});

test('回声抑制：从 TG 发的话不绕回来，且只挡一次', async (t) => {
  const { app, sent } = harness(t);
  const b = binding();
  app.echo.note(b.paneId, '我从 TG 发的话');

  await handleMirrored(app, [msg(b, '我从 TG 发的话', 'user')]);
  assert.equal(sent.length, 0, '自己发的话不该被镜像推回来');

  // 回声已消费：之后同样内容的真消息（在终端亲手敲的）不能再被吞
  await handleMirrored(app, [msg(b, '我从 TG 发的话', 'user')]);
  assert.equal(sent.length, 1);
});
