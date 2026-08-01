/** 国际化：自动跟随 Telegram 语言、手动覆盖、状态落盘。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  currentLang,
  initI18n,
  noteLanguageCode,
  resetI18n,
  setLangMode,
  t,
  tIn,
} from '../src/i18n.ts';
import { CB, parseCallback } from '../src/app/context.ts';

test('auto 跟随 language_code：zh* → 中文，其余 → 英文', () => {
  resetI18n();
  noteLanguageCode('zh-hans');
  assert.equal(currentLang(), 'zh');
  assert.equal(t('not-bound'), '未绑定。');

  noteLanguageCode('en-US');
  assert.equal(currentLang(), 'en');
  assert.equal(t('not-bound'), 'Not bound.');

  noteLanguageCode(undefined); // 没带语言码就保持现状
  assert.equal(currentLang(), 'en');
  resetI18n();
});

test('手动覆盖后不再跟随；切回 auto 恢复', () => {
  resetI18n();
  setLangMode('zh');
  noteLanguageCode('en');
  assert.equal(currentLang(), 'zh', '手动锁中文后 language_code 不该生效');

  setLangMode('auto');
  assert.equal(currentLang(), 'en', 'auto 恢复后用检测值');
  resetI18n();
});

test('参数替换与指定语言取文案', () => {
  resetI18n();
  assert.equal(t('already-bound', { pane: '%14' }), '已绑定 <code>%14</code>。');
  assert.equal(tIn('en', 'cleanup-all-ok', { n: 3 }), '✅ All 3 topics exist.');
  assert.equal(tIn('zh', 'menu-agents'), '列出并绑定 agent');
  resetI18n();
});

test('语言状态落盘：重启（重新 init）后仍生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-remote-i18n-'));
  const file = join(dir, 'lang.json');

  initI18n(file);
  setLangMode('en');

  resetI18n();
  initI18n(file);
  assert.equal(currentLang(), 'en', '手动选择应在重启后保留');

  setLangMode('auto');
  noteLanguageCode('zh');
  resetI18n();
  initI18n(file);
  assert.equal(currentLang(), 'zh', 'auto 的检测值也应落盘');

  resetI18n();
  rmSync(dir, { recursive: true, force: true });
});

test('lg: 回调编解码', () => {
  assert.deepEqual(parseCallback(CB.lang('auto')), { kind: 'lang', mode: 'auto' });
  assert.deepEqual(parseCallback(CB.lang('en')), { kind: 'lang', mode: 'en' });
  assert.equal(parseCallback('lg:fr'), null, '只认 auto/zh/en');
});
