/** 「正在输入…」指示器：循环续期、停止、TTL 兜底。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TypingIndicator } from '../src/core/typing.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('start 后立即发一次并按间隔续期，stop 后停', async () => {
  const calls: string[] = [];
  const typing = new TypingIndicator(
    async (chatId, threadId) => {
      calls.push(`${chatId}:${threadId ?? 0}`);
    },
    { refreshMs: 20, maxMs: 10_000 },
  );

  typing.start('1', 7);
  await sleep(70);
  assert.ok(calls.length >= 2, `应持续续期，实际 ${calls.length} 次`);
  assert.ok(calls.every((c) => c === '1:7'));

  typing.stop('1', 7);
  const after = calls.length;
  await sleep(60);
  assert.equal(calls.length, after, 'stop 后不该再发');
});

test('重复 start 不叠加定时器', async () => {
  const calls: number[] = [];
  const typing = new TypingIndicator(
    async () => {
      calls.push(Date.now());
    },
    { refreshMs: 25, maxMs: 10_000 },
  );

  typing.start('1');
  typing.start('1');
  typing.start('1');
  await sleep(65);
  typing.stop('1');
  // 单个定时器 65ms 内最多发 1(立即) + 2(续期) 次；叠加了会翻倍
  assert.ok(calls.length <= 3, `疑似定时器叠加：${calls.length} 次`);
});

test('TTL 到期自动熄灭，不会永远转', async () => {
  const calls: number[] = [];
  const typing = new TypingIndicator(
    async () => {
      calls.push(Date.now());
    },
    { refreshMs: 15, maxMs: 50 },
  );

  typing.start('1');
  await sleep(120);
  const settled = calls.length;
  await sleep(50);
  assert.equal(calls.length, settled, 'TTL 之后不该再发');
  assert.ok(settled >= 1);
});

test('不同话题互不影响', async () => {
  const calls: string[] = [];
  const typing = new TypingIndicator(
    async (chatId, threadId) => {
      calls.push(`${chatId}:${threadId ?? 0}`);
    },
    { refreshMs: 20, maxMs: 10_000 },
  );

  typing.start('1', 7);
  typing.start('1', 8);
  await sleep(30);
  typing.stop('1', 7);
  calls.length = 0;
  await sleep(50);
  assert.ok(calls.length >= 1, '另一个话题应继续');
  assert.ok(calls.every((c) => c === '1:8'));
  typing.stopAll();
});

test('sender 抛错不打断续期循环', async () => {
  let attempts = 0;
  const typing = new TypingIndicator(
    async () => {
      attempts++;
      throw new Error('boom');
    },
    { refreshMs: 15, maxMs: 10_000 },
  );

  typing.start('1');
  await sleep(50);
  typing.stopAll();
  assert.ok(attempts >= 2, '失败后仍应继续尝试续期');
});
