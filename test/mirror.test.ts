/**
 * 对话镜像：绑定后 agent 说的每句话都要能推到话题里。
 *
 * Claude 的 Stop hook 不含回复正文 —— 这层是「看得到 agent 说了什么」的唯一来源。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIncremental, type StreamCursor } from '../src/providers/transcript-io.ts';
import { pollClaudeTranscript } from '../src/providers/claude/history.ts';
import { TranscriptWatcher } from '../src/core/transcript-watcher.ts';
import { BindStore, computeFingerprint, type Binding } from '../src/core/bind-store.ts';
import { registerProvider, resetRegistry } from '../src/providers/registry.ts';
import { claudeProvider } from '../src/providers/claude/index.ts';
import { formatHistory, formatMirrored } from '../src/telegram/format.ts';
import { EchoGuard } from '../src/core/echo-guard.ts';
import type { AgentProvider, HistoryItem } from '../src/providers/types.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 只实现镜像所需最小面的假 provider，poll 行为由测试注入 */
function fakeMirrorProvider(
  poll: () => Promise<{ nextCursor: unknown; messages: HistoryItem[]; source?: string }>,
): AgentProvider {
  return {
    id: 'fake',
    displayName: 'Fake',
    capabilities: {
      semanticPermission: false,
      structuredQuestion: false,
      nativeTranscript: true,
      resumeSession: false,
      spawnFromBot: false,
      activitySuppress: false,
    },
    detect: () => null,
    normalizeIngress: () => null,
    pollNativeEnhancements: poll,
  };
}

function fakeBinding(dir: string): { store: BindStore } {
  const store = new BindStore(join(dir, 'bindings.json'));
  const now = new Date().toISOString();
  store.upsert({
    chatId: '1',
    threadId: 10,
    paneId: '%1',
    fingerprint: computeFingerprint('%1', 1, 'fake'),
    providerId: 'fake',
    display: 'a:1.1',
    title: 't',
    ownedByUs: false,
    notifyLevel: 'verbose',
    createdAt: now,
    updatedAt: now,
  });
  return { store };
}

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-remote-mirror-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function claudeLine(role: 'user' | 'assistant', text: string): string {
  return (
    JSON.stringify(
      role === 'user'
        ? { type: 'user', message: { role: 'user', content: text } }
        : { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    ) + '\n'
  );
}

test('增量读：首次只记位置，不回放历史', async () => {
  const { dir, cleanup } = tempDir();
  const file = join(dir, 'a.jsonl');
  writeFileSync(file, 'old1\nold2\n');

  const first = await readIncremental(file, undefined);
  assert.equal(first?.fresh, true);
  assert.deepEqual(first?.lines, [], '重启后不该把旧内容重新推一遍');

  appendFileSync(file, 'new1\n');
  const second = await readIncremental(file, first!.cursor);
  assert.equal(second?.fresh, false);
  assert.deepEqual(second?.lines, ['new1']);
  cleanup();
});

test('增量读：写了一半的行留到下次', async () => {
  const { dir, cleanup } = tempDir();
  const file = join(dir, 'a.jsonl');
  writeFileSync(file, '');
  const start = (await readIncremental(file, undefined))!.cursor;

  appendFileSync(file, 'complete\npartial-');
  const r1 = await readIncremental(file, start);
  assert.deepEqual(r1?.lines, ['complete'], '半行不能吐出去');

  appendFileSync(file, 'rest\n');
  const r2 = await readIncremental(file, r1!.cursor);
  assert.deepEqual(r2?.lines, ['partial-rest'], '补齐后要完整交付');
  cleanup();
});

test('增量读：换文件（新会话）重新定位，不串会话', async () => {
  const { dir, cleanup } = tempDir();
  const a = join(dir, 'a.jsonl');
  const b = join(dir, 'b.jsonl');
  writeFileSync(a, 'x\n');
  writeFileSync(b, 'y1\ny2\n');

  const cursorA: StreamCursor = { file: a, offset: 2 };
  const r = await readIncremental(b, cursorA);
  assert.equal(r?.fresh, true);
  assert.deepEqual(r?.lines, []);
  assert.equal(r?.cursor.file, b);
  cleanup();
});

test('增量读：文件被截断时不崩、重新定位', async () => {
  const { dir, cleanup } = tempDir();
  const file = join(dir, 'a.jsonl');
  writeFileSync(file, 'aaaa\nbbbb\n');
  const cursor: StreamCursor = { file, offset: 10 };

  writeFileSync(file, 'c\n'); // 变短了
  const r = await readIncremental(file, cursor);
  assert.equal(r?.fresh, true);
  assert.deepEqual(r?.lines, []);
  cleanup();
});

test('Claude 增量：新写入的对话被解析出来', async () => {
  const { dir, cleanup } = tempDir();
  const file = join(dir, 'sess.jsonl');
  writeFileSync(file, claudeLine('user', '旧的'));

  const ref = { paneId: '%1', transcriptPath: file };
  const first = await pollClaudeTranscript(ref, undefined);
  assert.deepEqual(first?.messages, []);

  appendFileSync(file, claudeLine('assistant', '改好了，测试都过了'));
  appendFileSync(file, claudeLine('user', '再跑一次'));

  const second = await pollClaudeTranscript(ref, first?.nextCursor);
  assert.deepEqual(
    second?.messages.map((m) => [m.role, m.text]),
    [
      ['assistant', '改好了，测试都过了'],
      ['user', '再跑一次'],
    ],
  );
  cleanup();
});

test('watcher：只镜像 verbose 的绑定，且能把消息交出去', async () => {
  const { dir, cleanup } = tempDir();
  resetRegistry();
  registerProvider(claudeProvider);

  const file = join(dir, 'sess.jsonl');
  writeFileSync(file, '');

  const store = new BindStore(join(dir, 'bindings.json'));
  const now = new Date().toISOString();
  const base: Binding = {
    chatId: '1',
    threadId: 10,
    paneId: '%1',
    fingerprint: computeFingerprint('%1', 1, 'claude'),
    providerId: 'claude',
    display: 'a:1.1',
    title: 't',
    ownedByUs: false,
    transcriptPath: file,
    notifyLevel: 'verbose',
    createdAt: now,
    updatedAt: now,
  };
  store.upsert(base);

  const got: string[] = [];
  const watcher = new TranscriptWatcher({
    store,
    onMessages: async (msgs) => {
      for (const m of msgs) got.push(`${m.item.role}:${m.item.text}`);
    },
  });

  await watcher.tick(); // 首轮只定位
  appendFileSync(file, claudeLine('assistant', 'hello'));
  await watcher.tick();
  assert.deepEqual(got, ['assistant:hello']);

  // 调成 important 后不再镜像全文
  store.patch('1', 10, { notifyLevel: 'important' });
  appendFileSync(file, claudeLine('assistant', '这条不该出现'));
  await watcher.tick();
  assert.deepEqual(got, ['assistant:hello']);

  resetRegistry();
  cleanup();
});

test('watcher：单轮吐出的条数有上限，防止刷爆话题', async () => {
  const { dir, cleanup } = tempDir();
  resetRegistry();
  registerProvider(claudeProvider);

  const file = join(dir, 'sess.jsonl');
  writeFileSync(file, '');
  const store = new BindStore(join(dir, 'bindings.json'));
  const now = new Date().toISOString();
  store.upsert({
    chatId: '1',
    threadId: 10,
    paneId: '%1',
    fingerprint: computeFingerprint('%1', 1, 'claude'),
    providerId: 'claude',
    display: 'a:1.1',
    title: 't',
    ownedByUs: false,
    transcriptPath: file,
    notifyLevel: 'verbose',
    createdAt: now,
    updatedAt: now,
  });

  let delivered = 0;
  const watcher = new TranscriptWatcher({
    store,
    maxPerTick: 3,
    onMessages: async (msgs) => {
      delivered += msgs.length;
    },
  });

  await watcher.tick();
  for (let i = 0; i < 20; i++) appendFileSync(file, claudeLine('assistant', `m${i}`));
  await watcher.tick();
  assert.equal(delivered, 3);

  resetRegistry();
  cleanup();
});

test('kick 防抖：连续多次 kick 合并成一轮 tick', async () => {
  const { dir, cleanup } = tempDir();
  resetRegistry();
  let polls = 0;
  registerProvider(
    fakeMirrorProvider(async () => {
      polls++;
      return { nextCursor: undefined, messages: [] };
    }),
  );
  const { store } = fakeBinding(dir);
  const watcher = new TranscriptWatcher({
    store,
    kickDebounceMs: 20,
    onMessages: async () => {},
  });

  watcher.kick();
  watcher.kick();
  watcher.kick();
  await sleep(120);
  assert.equal(polls, 1, '防抖窗口内的多次 kick 该合并');

  watcher.kick();
  await sleep(120);
  assert.equal(polls, 2);

  watcher.stop();
  resetRegistry();
  cleanup();
});

test('tick 进行中被踢不丢：结束后补一轮', async () => {
  const { dir, cleanup } = tempDir();
  resetRegistry();
  let polls = 0;
  registerProvider(
    fakeMirrorProvider(async () => {
      polls++;
      return { nextCursor: undefined, messages: [{ role: 'assistant', text: `m${polls}` }] };
    }),
  );
  const { store } = fakeBinding(dir);
  const watcher = new TranscriptWatcher({
    store,
    kickDebounceMs: 20,
    onMessages: async () => {
      if (polls === 1) await sleep(80); // 第一轮故意拖慢，让 kick 打在进行中
    },
  });

  const first = watcher.tick();
  await sleep(10);
  watcher.kick(); // 此刻第一轮还挂在 onMessages 里
  await first;

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && polls < 2) await sleep(20);
  assert.equal(polls, 2, '进行中被踢应该在结束后补一轮');

  await sleep(80);
  assert.equal(polls, 2, '补跑只补一轮，不该滚雪球');

  watcher.stop();
  resetRegistry();
  cleanup();
});

test('fs.watch：transcript 有写入自动镜像，不等兜底轮询', async () => {
  const { dir, cleanup } = tempDir();
  resetRegistry();
  registerProvider(claudeProvider);

  const file = join(dir, 'sess.jsonl');
  writeFileSync(file, '');

  const store = new BindStore(join(dir, 'bindings.json'));
  const now = new Date().toISOString();
  store.upsert({
    chatId: '1',
    threadId: 10,
    paneId: '%1',
    fingerprint: computeFingerprint('%1', 1, 'claude'),
    providerId: 'claude',
    display: 'a:1.1',
    title: 't',
    ownedByUs: false,
    transcriptPath: file,
    notifyLevel: 'verbose',
    createdAt: now,
    updatedAt: now,
  });

  const got: string[] = [];
  const watcher = new TranscriptWatcher({
    store,
    kickDebounceMs: 10,
    onMessages: async (msgs) => {
      for (const m of msgs) got.push(`${m.item.role}:${m.item.text}`);
    },
  });

  await watcher.tick(); // 首轮定位文件并建立 fs.watch

  appendFileSync(file, claudeLine('assistant', 'hello'));
  // 全程不手动 tick —— 消息必须由文件监听自己送到
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !got.length) await sleep(25);
  assert.deepEqual(got, ['assistant:hello']);

  watcher.stop();
  resetRegistry();
  cleanup();
});

test('镜像文案：agent 回复直出，终端输入标出来源，空内容丢弃', () => {
  assert.equal(formatMirrored({ role: 'assistant', text: '改完了' }), '改完了');
  assert.match(formatMirrored({ role: 'user', text: '继续' }) ?? '', /<blockquote>/);
  assert.match(formatMirrored({ role: 'assistant', text: '[工具] Bash', kind: 'tool' }) ?? '', /🔧/);
  assert.equal(formatMirrored({ role: 'assistant', text: '   ' }), null);
});

test('镜像文案：HTML 被转义，不会打断消息格式', () => {
  const out = formatMirrored({ role: 'assistant', text: '用 <script> 和 a & b' });
  assert.match(out ?? '', /&lt;script&gt;/);
  assert.match(out ?? '', /a &amp; b/);
});

test('回声抑制：从 Telegram 发的话不会被镜像推回来', () => {
  const echo = new EchoGuard();
  echo.note('%1', '帮我跑一下测试');

  // agent 把它记进 transcript，镜像读到时应该被挡掉
  assert.equal(echo.consume('%1', '帮我跑一下测试'), true);
  // 只挡一次：真在终端又敲了同一句，照常镜像
  assert.equal(echo.consume('%1', '帮我跑一下测试'), false);
});

test('回声抑制：只影响对应 pane，且忽略首尾空白差异', () => {
  const echo = new EchoGuard();
  echo.note('%1', 'hello');

  assert.equal(echo.consume('%2', 'hello'), false, '别的 pane 不受影响');
  assert.equal(echo.consume('%1', '  hello  '), true, '空白差异不该漏网');
});

test('回声抑制：在终端敲的内容照常镜像', () => {
  const echo = new EchoGuard();
  echo.note('%1', 'from telegram');
  assert.equal(echo.consume('%1', '我在终端敲的'), false);
});

test('回声抑制：过期的记录不再拦截', () => {
  const echo = new EchoGuard();
  const old = Date.now() - 10 * 60_000;
  echo.note('%1', 'stale', old);
  assert.equal(echo.consume('%1', 'stale'), false, '10 分钟前发的不该再挡');
});

test('回声抑制：解绑后清空，gc 不留垃圾', () => {
  const echo = new EchoGuard();
  echo.note('%1', 'x');
  echo.forget('%1');
  assert.equal(echo.consume('%1', 'x'), false);

  echo.note('%2', 'y', Date.now() - 10 * 60_000);
  echo.gc();
  assert.equal(echo.consume('%2', 'y'), false);
});

test('历史投影：你说的话进引用块，agent 的话平铺', () => {
  const blocks = formatHistory([
    { role: 'user', text: '帮我看看这个 bug' },
    { role: 'assistant', text: '是空指针' },
  ]);
  assert.equal(blocks.length, 1, '两条应该合并进一块');
  assert.match(blocks[0]!, /<blockquote>🧑 帮我看看这个 bug<\/blockquote>/);
  assert.match(blocks[0]!, /🤖 是空指针/);
});

test('历史投影：多条合并成少数几块，不逐条刷屏', () => {
  const many: HistoryItem[] = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: `第 ${i} 条`,
  }));
  const blocks = formatHistory(many);
  assert.ok(blocks.length <= 3, `30 条历史不该发 ${blocks.length} 条消息`);
  for (const b of blocks) assert.ok(b.length <= 4096, '单条不能超 Telegram 上限');
});

test('历史投影：超长单条会被切开，且每块都不超上限', () => {
  const long: HistoryItem[] = Array.from({ length: 10 }, () => ({
    role: 'assistant',
    text: 'x'.repeat(1200),
  }));
  const blocks = formatHistory(long, { maxPerItem: 1200 });
  assert.ok(blocks.length > 1);
  for (const b of blocks) assert.ok(b.length <= 4096);
});

test('历史投影：HTML 被转义，引用块不会被内容打断', () => {
  const blocks = formatHistory([{ role: 'user', text: '</blockquote><script>' }]);
  assert.match(blocks[0]!, /&lt;\/blockquote&gt;&lt;script&gt;/);
});
