import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EgressQueue, splitText, stripHtml, type Transport } from '../src/core/egress-queue.ts';

function recordingTransport(): {
  transport: Transport;
  sent: { chatId: string; threadId?: number; text: string; parseMode?: string }[];
  edits: number[];
} {
  const sent: { chatId: string; threadId?: number; text: string; parseMode?: string }[] = [];
  const edits: number[] = [];
  let id = 0;
  return {
    sent,
    edits,
    transport: {
      async sendMessage(job) {
        sent.push({
          chatId: job.chatId,
          threadId: job.threadId,
          text: job.text,
          parseMode: job.parseMode,
        });
        return { messageId: ++id };
      },
      async editMessage(job) {
        edits.push(job.messageId);
        return { messageId: job.messageId };
      },
    },
  };
}

test('长文按换行切分，不硬切在词中间', () => {
  const text = Array.from({ length: 500 }, (_, i) => `第 ${i} 行内容`).join('\n');
  const parts = splitText(text, 200);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 200);
  assert.equal(parts.join('\n'), text);
});

test('同一 thread 内严格 FIFO', async () => {
  const { transport, sent } = recordingTransport();
  const q = new EgressQueue(transport);

  const jobs = ['a', 'b', 'c', 'd'].map((t) =>
    q.enqueue({ chatId: '1', threadId: 5, text: t }),
  );
  await Promise.all(jobs);

  assert.deepEqual(
    sent.map((s) => s.text),
    ['a', 'b', 'c', 'd'],
  );
});

test('HTML 解析失败自动降级为纯文本重试', async () => {
  let attempts = 0;
  const transport: Transport = {
    async sendMessage(job) {
      attempts++;
      if (job.parseMode === 'HTML') {
        throw new Error("Bad Request: can't parse entities: unsupported start tag");
      }
      assert.equal(job.text, '危险 <script> 内容');
      return { messageId: 1 };
    },
    async editMessage() {
      return { messageId: 1 };
    },
  };

  const q = new EgressQueue(transport);
  await q.enqueue({
    chatId: '1',
    text: '危险 &lt;script&gt; 内容',
    parseMode: 'HTML',
  });
  assert.equal(attempts, 2);
});

test('429 按 retry_after 退避后重试', async () => {
  let attempts = 0;
  const transport: Transport = {
    async sendMessage() {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error('Too Many Requests'), { parameters: { retry_after: 0 } });
      }
      return { messageId: 7 };
    },
    async editMessage() {
      return { messageId: 7 };
    },
  };

  const q = new EgressQueue(transport);
  const result = await q.enqueue({ chatId: '1', text: 'hi' });
  assert.equal(attempts, 2);
  assert.equal(result.messageId, 7);
});

test('editMessageId 走编辑而不是新发', async () => {
  const { transport, sent, edits } = recordingTransport();
  const q = new EgressQueue(transport);
  await q.enqueue({ chatId: '1', text: '改过了', editMessageId: 42 });
  assert.equal(sent.length, 0);
  assert.deepEqual(edits, [42]);
});

test('stripHtml 还原实体，供降级使用', () => {
  assert.equal(stripHtml('<b>x</b> &lt;y&gt; &amp; z'), 'x <y> & z');
});

test('话题被删除：解绑 + 把内容改投主聊天流，不让它凭空消失', async () => {
  const gone: { chatId: string; threadId: number }[] = [];
  const landed: (number | undefined)[] = [];
  const transport: Transport = {
    async sendMessage(job) {
      landed.push(job.threadId);
      if (job.threadId === 3732) {
        throw new Error('Bad Request: message thread not found');
      }
      return { messageId: 1 };
    },
    async editMessage(job) {
      return { messageId: job.messageId };
    },
  };

  const q = new EgressQueue(transport, {
    onThreadGone: (chatId, threadId) => {
      gone.push({ chatId, threadId });
    },
  });

  // 发不出去是意料之中，不该冒泡成异常（否则 ingress 会 500）
  const result = await q.enqueue({ chatId: '1', threadId: 3732, text: 'hi' });

  assert.deepEqual(gone, [{ chatId: '1', threadId: 3732 }], '要解绑');
  // 话题没了不等于这条内容就该丢 —— 学 hermes，去掉 thread 重发一次
  assert.deepEqual(landed, [3732, 3732, undefined], '抖动重试一次，然后降级重发');
  assert.equal(result.messageId, 1, '内容最终落到了主聊天流');

  // 别的话题照常
  const ok = await q.enqueue({ chatId: '1', threadId: 11, text: 'hi' });
  assert.equal(ok.messageId, 1);
});

test('TOPIC_ID_INVALID 同样算话题没了', async () => {
  let called = 0;
  const transport: Transport = {
    async sendMessage(job) {
      if (job.threadId) throw new Error('Bad Request: TOPIC_ID_INVALID');
      return { messageId: 7 };
    },
    async editMessage(job) {
      return { messageId: job.messageId };
    },
  };
  const q = new EgressQueue(transport, { onThreadGone: () => void called++ });
  const r = await q.enqueue({ chatId: '1', threadId: 9, text: 'x' });
  assert.equal(called, 1);
  assert.equal(r.messageId, 7);
});

test('thread not found 只出现一次时不解绑 —— 那多半是抖动', async () => {
  // hermes #31501 的教训：第一次失败就判死会误杀活着的话题。
  // 同一个 thread 原样重试一次，成功了就当无事发生。
  let attempts = 0;
  let unbound = 0;
  const transport: Transport = {
    async sendMessage(job) {
      attempts++;
      if (attempts === 1) throw new Error('Bad Request: message thread not found');
      return { messageId: job.threadId ?? 0 };
    },
    async editMessage(job) {
      return { messageId: job.messageId };
    },
  };
  const q = new EgressQueue(transport, { onThreadGone: () => void unbound++ });

  const r = await q.enqueue({ chatId: '1', threadId: 55, text: 'x' });
  assert.equal(attempts, 2);
  assert.equal(unbound, 0, '话题还活着，绝不能解绑');
  assert.equal(r.messageId, 55, '仍然发进了原话题');
});

test('主聊天流（无 threadId）不触发解绑', async () => {
  let called = 0;
  const transport: Transport = {
    async sendMessage() {
      throw new Error('Bad Request: message thread not found');
    },
    async editMessage(job) {
      return { messageId: job.messageId };
    },
  };
  const q = new EgressQueue(transport, { onThreadGone: () => void called++ });
  await assert.rejects(() => q.enqueue({ chatId: '1', text: 'x' }));
  assert.equal(called, 0);
});

test('内容没变的编辑不算失败（刷新时列表未变化）', async () => {
  const transport: Transport = {
    async sendMessage() {
      return { messageId: 1 };
    },
    async editMessage() {
      throw new Error(
        'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
      );
    },
  };
  const q = new EgressQueue(transport);
  const r = await q.enqueue({ chatId: '1', text: '一样的内容', editMessageId: 42 });
  assert.equal(r.messageId, 42, '目标状态已达到，不该抛异常');
});
