import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeCwd, parseClaudeLines } from '../src/providers/claude/history.ts';
import { parseCodexLines } from '../src/providers/codex/history.ts';
import {
  encodeCwd as encodePiCwd,
  parsePiLines,
  pollPiTranscript,
  sessionIdFromPath,
  sessionLooksIdle,
} from '../src/providers/pi/history.ts';
import { buildHistoryPage } from '../src/app/history-flow.ts';
import { layoutHistoryPages } from '../src/telegram/format.ts';
import { computeFingerprint, type Binding } from '../src/core/bind-store.ts';
import { registerProvider, resetRegistry } from '../src/providers/registry.ts';
import { claudeProvider } from '../src/providers/claude/index.ts';

test('cwd 编码与 ~/.claude/projects 下的真实目录名一致', () => {
  assert.equal(encodeCwd('/home/finger/code/mycode/gloss.nvim'), '-home-finger-code-mycode-gloss-nvim');
  assert.equal(encodeCwd('/home/finger/code/mycode/agent-remote'), '-home-finger-code-mycode-agent-remote');
});

test('Pi cwd 编码与 ~/.pi/agent/sessions 下的真实目录名一致', () => {
  assert.equal(encodePiCwd('/home/finger/code/mycode/agent-remote'), '--home-finger-code-mycode-agent-remote--');
  assert.equal(encodePiCwd('/home/finger'), '--home-finger--');
});

test('Pi jsonl：取 user/assistant 文本，跳过 thinking 与 toolResult', () => {
  const items = parsePiLines([
    JSON.stringify({ type: 'session', version: 3, id: 's', cwd: '/home/u/proj' }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-08-18T07:21:01.603Z',
      message: { role: 'user', content: [{ type: 'text', text: '帮我看看这个 bug' }] },
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-08-18T07:21:07.002Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内部推理不外泄' },
          { type: 'text', text: '看起来是空指针。' },
          { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }],
      },
    }),
    '不是 json',
  ]);
  assert.deepEqual(
    items.map((i) => [i.role, i.text, i.kind]),
    [
      ['user', '帮我看看这个 bug', 'message'],
      ['assistant', '看起来是空指针。', 'message'],
    ],
  );
  assert.equal(items[1]?.terminal, true);
});

test('Pi sessionId 从文件名拆出来', () => {
  assert.equal(
    sessionIdFromPath(
      '/home/u/.pi/agent/sessions/--home-u--/2026-08-18T07-20-03-976Z_01a013bd-d888-71bf-a6e0-e948ece43ece.jsonl',
    ),
    '01a013bd-d888-71bf-a6e0-e948ece43ece',
  );
});

test('Pi sessionLooksIdle：最后一条 assistant 收尾才算空闲', () => {
  assert.equal(sessionLooksIdle([]), true);
  assert.equal(
    sessionLooksIdle([{ role: 'user', text: 'hi', kind: 'message' }]),
    false,
  );
  assert.equal(
    sessionLooksIdle([
      { role: 'user', text: 'hi', kind: 'message' },
      { role: 'assistant', text: 'ok', kind: 'message', terminal: true },
    ]),
    true,
  );
  assert.equal(
    sessionLooksIdle([
      { role: 'assistant', text: 'calling', kind: 'message', terminal: false },
    ]),
    false,
  );
});

test('Pi 首次挂上 transcript 时，since 之后的回复会补推', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-remote-pi-hist-'));
  const file = join(dir, '2026-08-18T07-20-03-976Z_01a013bd-d888-71bf-a6e0-e948ece43ece.jsonl');
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-08-18T09:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '更早的' }] },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-08-18T09:30:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '绑之后的回复' }],
          stopReason: 'stop',
        },
      }),
    ].join('\n') + '\n',
  );
  const first = await pollPiTranscript(
    { paneId: '%1', transcriptPath: file, since: '2026-08-18T09:26:00.000Z' },
    undefined,
  );
  assert.equal(first?.idle, true);
  assert.deepEqual(
    first?.messages.map((m) => m.text),
    ['绑之后的回复'],
  );
  const second = await pollPiTranscript(
    { paneId: '%1', transcriptPath: file, since: '2026-08-18T09:26:00.000Z' },
    first?.nextCursor,
  );
  assert.deepEqual(second?.messages, []);
  rmSync(dir, { recursive: true, force: true });
});

test('Claude jsonl：取 user/assistant 文本，跳过 thinking 与 tool_result', () => {
  const lines = [
    JSON.stringify({ type: 'mode', mode: 'normal' }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-07-22T17:24:17.403Z',
      message: { role: 'user', content: '帮我看看这个 bug' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-22T17:24:35.652Z',
      message: {
        content: [
          { type: 'thinking', thinking: '内部推理不外泄' },
          { type: 'text', text: '看起来是空指针。' },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
      },
    }),
    '不是 json',
  ];

  const items = parseClaudeLines(lines);
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((i) => [i.role, i.text]),
    [
      ['user', '帮我看看这个 bug'],
      ['assistant', '看起来是空指针。'],
    ],
  );
});

test('Claude jsonl：只有 tool_use 的 assistant 消息标成工具行', () => {
  const items = parseClaudeLines([
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'tool');
  assert.match(items[0]?.text ?? '', /Bash/);
});

test('Codex rollout：只取 event_msg 的 user/agent message，滤掉 developer 提示与噪声', () => {
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: { session_id: 'abc', cwd: '/home/u/proj' },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ text: '系统提示不要投影' }] },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-29T16:45:04.647Z',
      payload: { type: 'user_message', message: '看下这个 mcp 配置' },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-29T16:45:09.182Z',
      payload: { type: 'agent_message', message: '当前用的是本地 stdio。' },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } }),
  ];

  const items = parseCodexLines(lines);
  assert.deepEqual(
    items.map((i) => [i.role, i.text]),
    [
      ['user', '看下这个 mcp 配置'],
      ['assistant', '当前用的是本地 stdio。'],
    ],
  );
});

// ── 分页浏览 ──────────────────────────────────────────────────────────────────

function pagingFixture(): { binding: Binding; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-remote-hist-'));
  const file = join(dir, 'sess.jsonl');
  const lines: string[] = [];
  for (let i = 1; i <= 25; i++) {
    lines.push(
      JSON.stringify(
        i % 2
          ? { type: 'user', message: { role: 'user', content: `m${i}` } }
          : { type: 'assistant', message: { content: [{ type: 'text', text: `m${i}` }] } },
      ),
    );
  }
  writeFileSync(file, lines.join('\n') + '\n');
  const now = new Date().toISOString();
  const binding: Binding = {
    chatId: '1',
    threadId: 10,
    paneId: '%1',
    fingerprint: computeFingerprint('%1', 1, 'claude'),
    providerId: 'claude',
    display: 'a:1.1',
    title: 't',
    ownedByUs: false,
    transcriptPath: file,
    notifyLevel: 'info',
    createdAt: now,
    updatedAt: now,
  };
  return { binding, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('分页：page 0 进尾页（最新），页码与切片正确', async () => {
  resetRegistry();
  registerProvider(claudeProvider);
  const { binding, cleanup } = pagingFixture();

  const view = await buildHistoryPage(binding, 0, 10);
  assert.ok(view.ok);
  assert.equal(view.page, 3);
  assert.equal(view.pages, 3);
  assert.match(view.text, /3\/3/);
  assert.match(view.text, /m25/, '尾页要有最新一条');
  assert.doesNotMatch(view.text, /m5\b/, '尾页不该出现前页内容');

  // 导航一行五键：⏮ ◀ 页码 ▶ ⏭；⏭ 用 0 哨兵，数据增长后仍指向真尾页
  const nav = view.buttons[0]!;
  assert.equal(nav.length, 5);
  assert.equal(nav[0]!.callbackData, 'hp:1:10');
  assert.equal(nav[1]!.callbackData, 'hp:2:10');
  assert.equal(nav[2]!.text, '3/3');
  assert.equal(nav[3]!.callbackData, 'hp:3:10');
  assert.equal(nav[4]!.callbackData, 'hp:0:10');

  resetRegistry();
  cleanup();
});

test('分页：首页从最早开始，越界页码自动收敛', async () => {
  resetRegistry();
  registerProvider(claudeProvider);
  const { binding, cleanup } = pagingFixture();

  const first = await buildHistoryPage(binding, 1, 10);
  assert.ok(first.ok);
  assert.match(first.text, /m1\b/);
  assert.doesNotMatch(first.text, /m11/);

  const wild = await buildHistoryPage(binding, 99, 10);
  assert.ok(wild.ok);
  assert.equal(wild.page, 3, '越界要收敛到尾页');

  resetRegistry();
  cleanup();
});

test('布局：内容超页预算时自动开新页，每页都不超 Telegram 上限', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    role: 'assistant' as const,
    text: `第${i}条 ` + 'x'.repeat(600),
  }));
  const pages = layoutHistoryPages(items);
  assert.ok(pages.length > 1, '10×600 字塞不进一页，应分页而不是截断');
  for (const p of pages) assert.ok(p.body.length <= 3500, `页超限: ${p.body.length}`);
  // 所有内容一个字不丢
  const joined = pages.map((p) => p.body).join('');
  for (let i = 0; i < 10; i++) assert.ok(joined.includes(`第${i}条`));
});

test('布局：超长消息独占页并切成续段，拼回完整原文', () => {
  const long = 'y'.repeat(8000);
  const pages = layoutHistoryPages([
    { role: 'user', text: '短问题' },
    { role: 'assistant', text: long },
    { role: 'user', text: '追问' },
  ]);

  const segPages = pages.filter((p) => p.label.includes('段'));
  assert.ok(segPages.length >= 3, `8000 字应切成 ≥3 段页，实际 ${segPages.length}`);
  assert.match(segPages[0]!.label, /^第 2 条 · 1\/\d+ 段$/);
  for (const p of segPages) assert.ok(p.body.length <= 3500);

  // 段拼回去必须是完整原文 —— 「不截断」的硬承诺
  const rebuilt = segPages.map((p) => p.body.replace(/^🤖 /, '')).join('');
  assert.equal(rebuilt, long);

  // 前后的短消息各归自己的页，不跟段页混
  assert.equal(pages[0]!.label, '第 1 条');
  assert.equal(pages[pages.length - 1]!.label, '第 3 条');
});
