/**
 * codex 阻塞授权的响应形状：PermissionRequest 与 PreToolUse 期望的
 * hookResponse 不同（decision.behavior vs permissionDecision），
 * 这两个形状是 codex hooks 引擎的合约，改错了手机上的按钮就成了摆设。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexProvider } from '../src/providers/codex/index.ts';
import { normalizeCodex } from '../src/providers/codex/normalize.ts';

function permissionEvent(hook: 'PermissionRequest' | 'PreToolUse') {
  const e = normalizeCodex({
    hook_event_name: hook,
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    correlationId: 'cafe0001',
  });
  assert.ok(e, 'normalize 应产出事件');
  return e;
}

test('capabilities.semanticPermission 已兑现为 true', () => {
  assert.equal(codexProvider.capabilities.semanticPermission, true);
});

test('PermissionRequest allow → decision.behavior=allow', async () => {
  const out = await codexProvider.resolveDecision!(permissionEvent('PermissionRequest'), 'allow');
  assert.equal(out.ok, true);
  const resp = out.hookResponse as {
    hookSpecificOutput: { hookEventName: string; decision: { behavior: string } };
  };
  assert.equal(resp.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.deepEqual(resp.hookSpecificOutput.decision, { behavior: 'allow' });
});

test('PermissionRequest deny → decision.behavior=deny 且带 message', async () => {
  const out = await codexProvider.resolveDecision!(permissionEvent('PermissionRequest'), 'deny');
  const resp = out.hookResponse as {
    hookSpecificOutput: { decision: { behavior: string; message?: string } };
  };
  assert.equal(resp.hookSpecificOutput.decision.behavior, 'deny');
  assert.ok(resp.hookSpecificOutput.decision.message);
});

test('PreToolUse → permissionDecision 形状（与 Claude 同形）', async () => {
  const out = await codexProvider.resolveDecision!(permissionEvent('PreToolUse'), 'deny');
  const resp = out.hookResponse as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string };
  };
  assert.equal(resp.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(resp.hookSpecificOutput.permissionDecision, 'deny');
});

test('未知按钮 id → ok:false，不产生 hookResponse', async () => {
  const out = await codexProvider.resolveDecision!(permissionEvent('PermissionRequest'), 'wat');
  assert.equal(out.ok, false);
  assert.equal('hookResponse' in out ? out.hookResponse : undefined, undefined);
});

test('决策 UI 只在阻塞 permission 事件上出现', () => {
  const ui = codexProvider.buildDecisionUi!(permissionEvent('PermissionRequest'));
  assert.ok(ui);
  assert.deepEqual(ui!.buttons.map((b) => b.id), ['allow', 'deny']);

  const nonBlocking = normalizeCodex({ hook_event_name: 'PreToolUse', tool_name: 'Read' });
  assert.equal(codexProvider.buildDecisionUi!(nonBlocking!), null);
});

test('超时兜底是空响应 —— codex 退回本机权限框', () => {
  assert.deepEqual(codexProvider.decisionTimeoutResponse!(permissionEvent('PermissionRequest')), {});
});
