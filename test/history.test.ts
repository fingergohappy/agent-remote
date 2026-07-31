import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeCwd, parseClaudeLines } from '../src/providers/claude/history.ts';
import { parseCodexLines } from '../src/providers/codex/history.ts';
import { buildHistoryPage } from '../src/app/history-flow.ts';
import { renderHistoryPage } from '../src/telegram/format.ts';
import { computeFingerprint, type Binding } from '../src/core/bind-store.ts';
import { registerProvider, resetRegistry } from '../src/providers/registry.ts';
import { claudeProvider } from '../src/providers/claude/index.ts';

test('cwd 编码与 ~/.claude/projects 下的真实目录名一致', () => {
  assert.equal(encodeCwd('/home/finger/code/mycode/gloss.nvim'), '-home-finger-code-mycode-gloss-nvim');
  assert.equal(encodeCwd('/home/finger/code/mycode/agent-remote'), '-home-finger-code-mycode-agent-remote');
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
    notifyLevel: 'verbose',
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

test('分页：单页超预算时截断显示并标注，不超 Telegram 上限', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    role: 'assistant' as const,
    text: `第${i}条 ` + 'x'.repeat(600),
  }));
  const { text, shown } = renderHistoryPage(items);
  assert.ok(text.length <= 4000, `单条消息超限: ${text.length}`);
  assert.ok(shown < 10, '应有条目被省略');
  assert.match(text, /放不下/);
});
