import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from 'grammy/types';
import { threadIdOf } from '../src/telegram/commands.ts';
import { CB, parseCallback } from '../src/app/context.ts';
import { providerTopicColor, topicLink } from '../src/telegram/topics.ts';

function msg(over: {
  chatType: Message['chat']['type'];
  threadId?: number;
  isTopic?: boolean;
  isForum?: boolean;
}): Message {
  return {
    message_id: 1,
    date: 0,
    chat: { id: 1, type: over.chatType, is_forum: over.isForum } as Message['chat'],
    message_thread_id: over.threadId,
    is_topic_message: over.isTopic,
  } as Message;
}

test('话题消息按 message_thread_id 分工位', () => {
  assert.equal(threadIdOf(msg({ chatType: 'supergroup', isForum: true, threadId: 42, isTopic: true })), 42);
});

test('私聊里的话题同样是工位（BotFather 给 Bot 开了 threads）', () => {
  // 实测：这种私聊 getChat 报 is_forum=false，但 createForumTopic 能成功、
  // 消息也带 is_topic_message。曾经按 chat.type 把它归零，直接废掉了多工位能力。
  assert.equal(threadIdOf(msg({ chatType: 'private', threadId: 3614, isTopic: true })), 3614);
});

test('不在任何话题里的消息 → 0（命令台或单工位降级）', () => {
  assert.equal(threadIdOf(msg({ chatType: 'supergroup', isForum: true, threadId: 7 })), 0);
  assert.equal(threadIdOf(msg({ chatType: 'private' })), 0);
  // 回复线程会带 message_thread_id，但没有 is_topic_message —— 不能当工位
  assert.equal(threadIdOf(msg({ chatType: 'group', threadId: 99 })), 0);
  assert.equal(threadIdOf(undefined), 0);
});

test('callback_data 编解码往返，且不超 Telegram 的 64 字节', () => {
  const cases = [
    CB.bind('%14'),
    CB.decision('deadbeef', 'allow'),
    CB.history(30),
    CB.historyPage(0, 10),
    CB.historyPage(37, 50),
    CB.unbind(3793),
    CB.topicDelete(3732),
    CB.notifyLevel('verbose'),
    CB.refresh(),
  ];
  for (const data of cases) {
    assert.ok(Buffer.byteLength(data) <= 64, `${data} 超长`);
    assert.notEqual(parseCallback(data), null);
  }

  assert.deepEqual(parseCallback(CB.bind('%14')), { kind: 'bind', paneId: '%14' });
  assert.deepEqual(parseCallback(CB.decision('deadbeef', 'allow')), {
    kind: 'decision',
    correlationId: 'deadbeef',
    decisionId: 'allow',
  });
  assert.deepEqual(parseCallback(CB.historyPage(3, 10)), {
    kind: 'history-page',
    page: 3,
    size: 10,
  });
  assert.equal(parseCallback('hp:abc:10'), null, '非数字页码要拒绝');
  assert.equal(parseCallback('hp:1:0'), null, '每页 0 条要拒绝');
  assert.deepEqual(parseCallback(CB.history(30)), { kind: 'history', limit: 30 });
  assert.deepEqual(parseCallback(CB.unbind(3793)), { kind: 'unbind', threadId: 3793 });
  assert.deepEqual(parseCallback(CB.topicDelete(3732)), { kind: 'topic-delete', threadId: 3732 });
  // 解绑和删除只差一个字母，混了就是「本想断开却毁了历史」
  assert.notEqual(CB.unbind(3793), CB.topicDelete(3793));
  assert.deepEqual(parseCallback(CB.notifyLevel('off')), { kind: 'notify-level', level: 'off' });
  assert.deepEqual(parseCallback(CB.refresh()), { kind: 'refresh' });
});

test('非法 callback_data 返回 null 而不是抛异常', () => {
  assert.equal(parseCallback('垃圾'), null);
  assert.equal(parseCallback('d:'), null);
  assert.equal(parseCallback('d:nocolon'), null);
  assert.equal(parseCallback('td:0'), null);
  assert.equal(parseCallback('td:abc'), null);
  assert.equal(parseCallback('u:0'), null);
  assert.equal(parseCallback('u:abc'), null);
  assert.equal(parseCallback('nl:loud'), null);
  assert.equal(parseCallback(''), null);
});

test('话题深链只有超级群有；私聊话题一律 null', () => {
  assert.equal(topicLink('-1001234567890', 42), 'https://t.me/c/1234567890/42');
  assert.equal(topicLink('-1001234567890', 0), null, '主聊天流没有可跳转的话题');

  // 私聊话题实测无深链：t.me/c/0/<t>、t.me/c/<uid>/<t>、t.me/<bot>/<t>、
  // tg://privatepost、tg://openmessage、tg://resolve?thread 六种全部进不去。
  // 与其给一个点了没反应的按钮，不如不给 —— 上层看到 null 会退回 callback。
  assert.equal(topicLink('8161883123', 3793), null);
  assert.equal(topicLink('8161883123', 0), null);
});

test('话题配色：每个 provider 固定一色，且只用 Telegram 认的取值', () => {
  const allowed = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f];
  const claude = providerTopicColor('claude');
  const codex = providerTopicColor('codex');

  assert.ok(claude && allowed.includes(claude));
  assert.ok(codex && allowed.includes(codex));
  assert.notEqual(claude, codex, '两个 provider 得能分辨');
  assert.equal(providerTopicColor('unknown'), undefined, '不认识的交给 Telegram 随机配');
});
