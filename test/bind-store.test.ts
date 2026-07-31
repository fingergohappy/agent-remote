import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BindStore, computeFingerprint, type Binding } from '../src/core/bind-store.ts';

function tempStore(): { store: BindStore; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-remote-test-'));
  const file = join(dir, 'bindings.json');
  return { store: new BindStore(file), file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function binding(over: Partial<Binding> = {}): Binding {
  const now = new Date().toISOString();
  return {
    chatId: '-100123',
    threadId: 7,
    paneId: '%14',
    fingerprint: computeFingerprint('%14', 4242, 'claude'),
    providerId: 'claude',
    display: 'ibnk:1.2',
    title: '🤖 claude · proj',
    ownedByUs: false,
    notifyLevel: 'important',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

test('按 thread 与按 pane 都能查到', () => {
  const { store, cleanup } = tempStore();
  store.upsert(binding());
  assert.equal(store.getByThread('-100123', 7)?.paneId, '%14');
  assert.equal(store.getByPane('%14')?.threadId, 7);
  assert.equal(store.getByThread('-100123', 8), null);
  cleanup();
});

test('同一 pane 绑到新 Topic 会顶掉旧的（一 pane 一 thread）', () => {
  const { store, cleanup } = tempStore();
  store.upsert(binding({ threadId: 7 }));
  const { replaced } = store.upsert(binding({ threadId: 9 }));

  assert.equal(replaced?.threadId, 7);
  assert.equal(store.getByThread('-100123', 7), null);
  assert.equal(store.getByThread('-100123', 9)?.paneId, '%14');
  assert.equal(store.list().length, 1);
  cleanup();
});

test('不同 pane 各占一个 Topic，互不串键（MVP 验收 2）', () => {
  const { store, cleanup } = tempStore();
  store.upsert(binding({ threadId: 7, paneId: '%14', providerId: 'claude' }));
  store.upsert(binding({ threadId: 8, paneId: '%15', providerId: 'codex' }));

  assert.equal(store.getByThread('-100123', 7)?.providerId, 'claude');
  assert.equal(store.getByThread('-100123', 8)?.providerId, 'codex');
  assert.equal(store.list().length, 2);
  cleanup();
});

test('落盘后重新载入仍在', () => {
  const { store, file, cleanup } = tempStore();
  store.upsert(binding({ sessionId: 'sess-1' }));

  const reloaded = new BindStore(file);
  assert.equal(reloaded.getByPane('%14')?.sessionId, 'sess-1');
  assert.equal(reloaded.getBySessionId('sess-1')?.threadId, 7);
  cleanup();
});

test('patch 更新字段并刷新 updatedAt', async () => {
  const { store, cleanup } = tempStore();
  store.upsert(binding({ updatedAt: '2020-01-01T00:00:00.000Z' }));
  const next = store.patch('-100123', 7, { notifyLevel: 'verbose' });
  assert.equal(next?.notifyLevel, 'verbose');
  assert.notEqual(next?.updatedAt, '2020-01-01T00:00:00.000Z');
  cleanup();
});

test('remove 返回被删的绑定', () => {
  const { store, cleanup } = tempStore();
  store.upsert(binding());
  assert.equal(store.remove('-100123', 7)?.paneId, '%14');
  assert.equal(store.remove('-100123', 7), null);
  cleanup();
});

test('fingerprint 随 pid 变化 —— %N 被 tmux 复用时能识别', () => {
  const a = computeFingerprint('%14', 4242, 'claude');
  const b = computeFingerprint('%14', 9999, 'claude');
  const c = computeFingerprint('%14', 4242, 'codex');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, computeFingerprint('%14', 4242, 'claude'));
});

// ── released：解绑后话题还在，得记住它上次属于谁，/rebind 才有得可绑 ──

test('主动解绑留下 released 记录，且跨重启还在', () => {
  const { store, file, cleanup } = tempStore();
  const b = binding({ threadId: 7, paneId: '%14' });
  store.upsert(b);

  store.noteReleased(b);
  store.remove(b.chatId, b.threadId);

  const again = new BindStore(file); // 模拟服务重启
  const rec = again.getReleased('-100123', 7);
  assert.equal(rec?.paneId, '%14');
  assert.equal(rec?.providerId, 'claude');
  assert.equal(rec?.title, '🤖 claude · proj');
  assert.equal(again.getByThread('-100123', 7), null, '绑定本身确实已经解掉');
  cleanup();
});

test('主聊天流（threadId 0）不记 released —— 那不是话题，没有「回到这里」', () => {
  const { store, cleanup } = tempStore();
  store.noteReleased(binding({ threadId: 0 }));
  assert.equal(store.getReleased('-100123', 0), null);
  cleanup();
});

test('rebind 成功后清掉 released，别留着下次误绑', () => {
  const { store, cleanup } = tempStore();
  const b = binding({ threadId: 7 });
  store.noteReleased(b);
  assert.ok(store.getReleased('-100123', 7));

  store.clearReleased('-100123', 7);
  assert.equal(store.getReleased('-100123', 7), null);
  cleanup();
});

test('released 记录会过期，不会无限攒着', () => {
  const { store, cleanup } = tempStore();
  const old = Date.now() - 31 * 24 * 3600_000; // 超过 30 天
  store.noteReleased(binding({ threadId: 7, paneId: '%14' }), old);
  // 再记一条新的会触发过期清理
  store.noteReleased(binding({ threadId: 8, paneId: '%15' }));

  assert.equal(store.getReleased('-100123', 7), null, '一个月前的该扔了');
  assert.equal(store.getReleased('-100123', 8)?.paneId, '%15');
  cleanup();
});

test('同一话题重复解绑，released 只留最后一次', () => {
  const { store, cleanup } = tempStore();
  store.noteReleased(binding({ threadId: 7, paneId: '%14' }));
  store.noteReleased(binding({ threadId: 7, paneId: '%22', providerId: 'codex' }));

  const rec = store.getReleased('-100123', 7);
  assert.equal(rec?.paneId, '%22');
  assert.equal(rec?.providerId, 'codex');
  cleanup();
});
