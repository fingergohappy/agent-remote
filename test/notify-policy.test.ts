import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelAllows, shouldEmit } from '../src/core/notify-policy.ts';
import type { AgentEventType, NormalizedEvent } from '../src/providers/types.ts';

function evt(type: AgentEventType, extra: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return { type, providerId: 'claude', paneId: '%1', ts: '2026-07-29T00:00:00Z', ...extra };
}

const base = {
  terminalActive: false,
  fromTelegram: false,
  quietWhenTerminalActive: true,
};

test('important 默认只放行等人/授权/完成/失败（D13）', () => {
  assert.equal(levelAllows('important', 'completed'), true);
  assert.equal(levelAllows('important', 'waiting'), true);
  assert.equal(levelAllows('important', 'permission'), true);
  assert.equal(levelAllows('important', 'failed'), true);
  assert.equal(levelAllows('important', 'output'), false);
  assert.equal(levelAllows('important', 'started'), false);
});

test('verbose 放行全部，off 全拦', () => {
  assert.equal(levelAllows('verbose', 'output'), true);
  assert.equal(levelAllows('off', 'permission'), false);
});

test('silent 事件永不推送', () => {
  const d = shouldEmit({ ...base, event: evt('output', { silent: true }), level: 'verbose' });
  assert.equal(d.emit, false);
  assert.equal(d.reason, 'silent-event');
});

test('终端活跃时压制 completed，但不压制 permission/waiting', () => {
  const completed = shouldEmit({
    ...base,
    event: evt('completed'),
    level: 'important',
    terminalActive: true,
  });
  assert.equal(completed.emit, false);
  assert.equal(completed.reason, 'terminal-active');

  const permission = shouldEmit({
    ...base,
    event: evt('permission'),
    level: 'important',
    terminalActive: true,
  });
  assert.equal(permission.emit, true);

  const waiting = shouldEmit({
    ...base,
    event: evt('waiting'),
    level: 'important',
    terminalActive: true,
  });
  assert.equal(waiting.emit, true);
});

test('指令来自 Telegram 时不静音 —— 手机侧要闭环', () => {
  const d = shouldEmit({
    ...base,
    event: evt('completed'),
    level: 'important',
    terminalActive: true,
    fromTelegram: true,
  });
  assert.equal(d.emit, true);
});

test('关掉 quietWhenTerminalActive 后照常推', () => {
  const d = shouldEmit({
    ...base,
    event: evt('completed'),
    level: 'important',
    terminalActive: true,
    quietWhenTerminalActive: false,
  });
  assert.equal(d.emit, true);
});

test('阻塞式授权无视一切压制', () => {
  const d = shouldEmit({
    ...base,
    event: evt('permission', { blocking: true, correlationId: 'x' }),
    level: 'important',
    terminalActive: true,
  });
  assert.equal(d.emit, true);
  assert.equal(d.reason, 'blocking');
});

test('镜像开着时不推「完成」这类空洞事件', () => {
  const covered = shouldEmit({ ...base, event: evt('completed'), level: 'verbose', mirrored: true });
  assert.equal(covered.emit, false);
  assert.equal(covered.reason, 'covered-by-mirror');

  // 要你动手的事件镜像里没有，照推
  for (const type of ['waiting', 'permission', 'failed', 'ended'] as const) {
    const d = shouldEmit({ ...base, event: evt(type), level: 'verbose', mirrored: true });
    assert.equal(d.emit, true, `${type} 不该被镜像规则吞掉`);
  }
});

test('没有镜像时，完成事件是唯一信号，必须推', () => {
  const d = shouldEmit({ ...base, event: evt('completed'), level: 'important', mirrored: false });
  assert.equal(d.emit, true);
});

test('off 时连授权都不推（用户明确要求安静）', () => {
  const d = shouldEmit({ ...base, event: evt('permission'), level: 'off' });
  assert.equal(d.emit, false);
});
