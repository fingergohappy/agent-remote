/** markdown → Telegram HTML 子集：常见格式渲染、预算截断、标签闭合。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdToTelegramHtml } from '../src/telegram/format.ts';

const MAX = 3500;

test('粗体/斜体/删除线/行内代码', () => {
  assert.equal(
    mdToTelegramHtml('**加粗** *斜体* ~~删除~~ `code`', MAX),
    '<b>加粗</b> <i>斜体</i> <s>删除</s> <code>code</code>',
  );
});

test('标题降级为粗体，无序列表换 •', () => {
  assert.equal(
    mdToTelegramHtml('## 标题\n- 第一项\n- 第二项', MAX),
    '<b>标题</b>\n• 第一项\n• 第二项',
  );
});

test('围栏代码块 → pre，内容转义且不再套行内格式', () => {
  const out = mdToTelegramHtml('```ts\nconst a = 1 < 2; // **not bold**\n```', MAX);
  assert.equal(out, '<pre>const a = 1 &lt; 2; // **not bold**</pre>');
});

test('未闭合围栏照样出 pre', () => {
  assert.equal(mdToTelegramHtml('```\nabc', MAX), '<pre>abc</pre>');
});

test('链接 → a 标签，仅认 http(s)', () => {
  assert.equal(
    mdToTelegramHtml('看[文档](https://example.com/a?x=1&y=2)', MAX),
    '看<a href="https://example.com/a?x=1&amp;y=2">文档</a>',
  );
});

test('snake_case 与 a*b 不被误判为强调', () => {
  assert.equal(mdToTelegramHtml('foo_bar_baz 和 2*3*4', MAX), 'foo_bar_baz 和 2*3*4');
});

test('code span 内容不参与其它行内规则', () => {
  assert.equal(mdToTelegramHtml('`**raw**` 与 **真加粗**', MAX), '<code>**raw**</code> 与 <b>真加粗</b>');
});

test('HTML 特殊字符照常转义', () => {
  assert.equal(mdToTelegramHtml('a < b && c > d', MAX), 'a &lt; b &amp;&amp; c &gt; d');
});

test('正文里的 NUL 包数字不会撞 code span 占位符', () => {
  assert.equal(mdToTelegramHtml('x \u00007\u0000 y `z`', MAX), 'x 7 y <code>z</code>');
});

test('超预算按行截断，输出 ≤ maxLen 且标签闭合', () => {
  const raw = Array.from({ length: 50 }, (_, i) => `**第${i}行** 一些正文`).join('\n');
  const out = mdToTelegramHtml(raw, 200);
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith('…'));
  assert.equal((out.match(/<b>/g) ?? []).length, (out.match(/<\/b>/g) ?? []).length);
});

test('超长代码块在 pre 内截断，pre 保持闭合', () => {
  const raw = '```\n' + 'x'.repeat(500) + '\n```';
  const out = mdToTelegramHtml(raw, 200);
  assert.ok(out.length <= 200);
  assert.ok(out.startsWith('<pre>') && out.includes('</pre>'));
});

test('单行怪物消息回落为纯转义截断', () => {
  const out = mdToTelegramHtml('**a**' + 'x'.repeat(1000), 100);
  assert.ok(out.length <= 100);
  assert.ok(!out.includes('<'), '回落路径不该有标签');
});
