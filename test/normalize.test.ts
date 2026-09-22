import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaude } from '../src/providers/claude/normalize.ts';
import { normalizeCodex } from '../src/providers/codex/normalize.ts';
import { normalizePi } from '../src/providers/pi/normalize.ts';

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

// ── hooks 引擎（v0.124+）通路 ────────────────────────────────────────────────

test('Codex hooks 引擎 Stop → completed，带 session/transcript/pane', () => {
  const e = normalizeCodex({
    hook_event_name: 'Stop',
    session_id: 'sess-9',
    transcript_path: '/home/u/.codex/sessions/2026/08/01/rollout-x-sess-9.jsonl',
    cwd: '/home/u/proj',
    paneId: '%7',
  });
  assert.equal(e?.type, 'completed');
  assert.equal(e?.providerId, 'codex');
  assert.equal(e?.paneId, '%7');
  assert.equal(e?.sessionId, 'sess-9');
  assert.equal(e?.transcriptPath, '/home/u/.codex/sessions/2026/08/01/rollout-x-sess-9.jsonl');
});

test('Codex SessionStart / UserPromptSubmit 与 Claude 同约定', () => {
  const started = normalizeCodex({ hook_event_name: 'SessionStart', session_id: 's' });
  assert.equal(started?.type, 'started');

  const typed = normalizeCodex({ hook_event_name: 'UserPromptSubmit', paneId: '%2' });
  assert.equal(typed?.type, 'output');
  assert.equal(typed?.silent, true);
});

test('Codex PermissionRequest 带 correlationId 才算阻塞事件', () => {
  const blocking = normalizeCodex({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /tmp/x' },
    correlationId: 'beef1234',
  });
  assert.equal(blocking?.type, 'permission');
  assert.equal(blocking?.blocking, true);
  assert.match(blocking?.summary ?? '', /Bash: rm -rf/);

  const nonBlocking = normalizeCodex({ hook_event_name: 'PreToolUse', tool_name: 'Read' });
  assert.equal(nonBlocking?.type, 'permission');
  assert.equal(nonBlocking?.blocking, false);
});

test('Codex transcript_path 为 null 时不进事件（hooks 引擎会给 null）', () => {
  const e = normalizeCodex({ hook_event_name: 'Stop', transcript_path: null });
  assert.equal(e?.transcriptPath, undefined);
});

test('Codex 不认识的 hook_event_name 返回 null', () => {
  assert.equal(normalizeCodex({ hook_event_name: 'SomethingNew' }), null);
});

// ── Pi 扩展 ───────────────────────────────────────────────────────────────────

test('Pi agent_settled → completed，带 session/transcript/pane', () => {
  const e = normalizePi({
    hook_event_name: 'agent_settled',
    session_id: 'sess-pi',
    transcript_path: '/home/u/.pi/agent/sessions/--home-u-proj--/x_sess-pi.jsonl',
    cwd: '/home/u/proj',
    paneId: '%3',
  });
  assert.equal(e?.type, 'completed');
  assert.equal(e?.providerId, 'pi');
  assert.equal(e?.paneId, '%3');
  assert.equal(e?.sessionId, 'sess-pi');
  assert.equal(
    e?.transcriptPath,
    '/home/u/.pi/agent/sessions/--home-u-proj--/x_sess-pi.jsonl',
  );
});

test('Pi session_start / user_prompt 与 Claude 同约定', () => {
  const started = normalizePi({ hook_event_name: 'session_start', session_id: 's' });
  assert.equal(started?.type, 'started');

  const typed = normalizePi({ hook_event_name: 'user_prompt', paneId: '%2' });
  assert.equal(typed?.type, 'output');
  assert.equal(typed?.silent, true);
});

test('Pi tool_call 带 correlationId 才算阻塞事件', () => {
  const blocking = normalizePi({
    hook_event_name: 'tool_call',
    tool_name: 'bash',
    tool_input: { command: 'rm -rf /tmp/x' },
    correlationId: 'cafe1234',
  });
  assert.equal(blocking?.type, 'permission');
  assert.equal(blocking?.blocking, true);
  assert.match(blocking?.summary ?? '', /bash: rm -rf/);

  const nonBlocking = normalizePi({ hook_event_name: 'tool_call', tool_name: 'read' });
  assert.equal(nonBlocking?.blocking, false);
});

test('Pi 不认识的 hook_event_name 返回 null', () => {
  assert.equal(normalizePi({ hook_event_name: 'SomethingNew' }), null);
  assert.equal(normalizePi({}), null);
});
