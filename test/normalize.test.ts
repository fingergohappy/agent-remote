import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaude } from '../src/providers/claude/normalize.ts';
import { normalizeCodex } from '../src/providers/codex/normalize.ts';

test('Claude Stop → completed，并带上 pane/session/transcript', () => {
  const e = normalizeClaude({
    hook_event_name: 'Stop',
    session_id: 'sess-1',
    transcript_path: '/home/u/.claude/projects/-home-u-proj/sess-1.jsonl',
    cwd: '/home/u/proj',
    paneId: '%14',
  });
  assert.equal(e?.type, 'completed');
  assert.equal(e?.paneId, '%14');
  assert.equal(e?.sessionId, 'sess-1');
  assert.equal(e?.transcriptPath, '/home/u/.claude/projects/-home-u-proj/sess-1.jsonl');
  assert.equal(e?.providerId, 'claude');
});

test('Claude Notification 按文案分成 permission / waiting', () => {
  const perm = normalizeClaude({
    hook_event_name: 'Notification',
    message: 'Claude needs your permission to use Bash',
  });
  assert.equal(perm?.type, 'permission');

  const idle = normalizeClaude({
    hook_event_name: 'Notification',
    message: 'Claude is waiting for your input',
  });
  assert.equal(idle?.type, 'waiting');
});

test('UserPromptSubmit 是 silent —— 只用于终端活跃打点', () => {
  const e = normalizeClaude({ hook_event_name: 'UserPromptSubmit', paneId: '%3' });
  assert.equal(e?.silent, true);
});

test('PreToolUse 带 correlationId 才算阻塞事件', () => {
  const blocking = normalizeClaude({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /tmp/x' },
    correlationId: 'abcd1234',
  });
  assert.equal(blocking?.type, 'permission');
  assert.equal(blocking?.blocking, true);
  assert.match(blocking?.summary ?? '', /Bash: rm -rf/);

  const nonBlocking = normalizeClaude({ hook_event_name: 'PreToolUse', tool_name: 'Read' });
  assert.equal(nonBlocking?.blocking, false);
});

test('不认识的 hook 返回 null（由 ingress 回 400）', () => {
  assert.equal(normalizeClaude({ hook_event_name: 'SomethingNew' }), null);
  assert.equal(normalizeClaude({}), null);
  assert.equal(normalizeClaude('nope'), null);
});

test('Codex agent-turn-complete → completed，摘要取 last-assistant-message', () => {
  const e = normalizeCodex({
    type: 'agent-turn-complete',
    'turn-id': 'turn-1',
    'input-messages': ['帮我改一下'],
    'last-assistant-message': '改好了，跑过测试。',
    paneId: '%9',
    cwd: '/home/u/proj',
  });
  assert.equal(e?.type, 'completed');
  assert.equal(e?.providerId, 'codex');
  assert.equal(e?.paneId, '%9');
  assert.equal(e?.summary, '改好了，跑过测试。');
});

test('Codex 不认识的事件不产事件', () => {
  assert.equal(normalizeCodex({ type: 'token-count' }), null);
  assert.equal(normalizeCodex({}), null);
});
