/**
 * Pi 阻塞授权的响应形状：扩展读 hookResponse.block 决定是否拦 tool_call。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piProvider } from '../src/providers/pi/index.ts';
import { normalizePi } from '../src/providers/pi/normalize.ts';

function permissionEvent() {
  const e = normalizePi({
    hook_event_name: 'tool_call',
    tool_name: 'bash',
    tool_input: { command: 'echo hi' },
    correlationId: 'cafe0001',
  });
  assert.ok(e, 'normalize 应产出事件');
  return e;
}

test('capabilities.semanticPermission 已兑现为 true', () => {
  assert.equal(piProvider.capabilities.semanticPermission, true);
});

test('allow → { block: false }', async () => {
  const out = await piProvider.resolveDecision!(permissionEvent(), 'allow');
  assert.equal(out.ok, true);
  assert.deepEqual(out.hookResponse, { block: false });
});

test('deny → { block: true, reason }', async () => {
  const out = await piProvider.resolveDecision!(permissionEvent(), 'deny');
  const resp = out.hookResponse as { block: boolean; reason?: string };
  assert.equal(resp.block, true);
  assert.ok(resp.reason);
});

test('未知按钮 id → ok:false，不产生 hookResponse', async () => {
  const out = await piProvider.resolveDecision!(permissionEvent(), 'wat');
  assert.equal(out.ok, false);
  assert.equal('hookResponse' in out ? out.hookResponse : undefined, undefined);
});

test('决策 UI 只在阻塞 permission 事件上出现', () => {
  const ui = piProvider.buildDecisionUi!(permissionEvent());
  assert.ok(ui);
  assert.deepEqual(ui!.buttons.map((b) => b.id), ['allow', 'deny']);

  const nonBlocking = normalizePi({ hook_event_name: 'tool_call', tool_name: 'read' });
  assert.equal(piProvider.buildDecisionUi!(nonBlocking!), null);
});

test('超时兜底是空响应 —— 扩展不拦，pi 接着跑', () => {
  assert.deepEqual(piProvider.decisionTimeoutResponse!(permissionEvent()), {});
});
