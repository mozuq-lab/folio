import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_THEME, THEME_KEY, THEME_PREFERENCES, parseTheme, themeAttribute, themeInitScript } from '../lib/theme.ts';

test('保存済みの配色を読み取り、不明な値や未保存は既定の「端末の設定に合わせる」にする', () => {
  assert.equal(THEME_KEY, 'folio.theme');
  assert.equal(DEFAULT_THEME, 'system');
  assert.deepEqual([...THEME_PREFERENCES], ['system', 'light', 'dark']);
  for (const theme of THEME_PREFERENCES) assert.equal(parseTheme(theme), theme);
  for (const raw of [null, '', 'auto', 'DARK', 'sepia', '{"theme":"dark"}']) assert.equal(parseTheme(raw), 'system');
});

test('端末の設定に合わせるときは data-theme を付けず、CSSのメディアクエリに任せる', () => {
  assert.equal(themeAttribute('system'), null);
  assert.equal(themeAttribute('light'), 'light');
  assert.equal(themeAttribute('dark'), 'dark');
});

function runInitScript(stored: string | null | Error) {
  const attributes = new Map<string, string>();
  const localStorage = { getItem: (key: string) => { if (stored instanceof Error) throw stored; return key === THEME_KEY ? stored : null; } };
  const document = { documentElement: { setAttribute: (name: string, value: string) => { attributes.set(name, value); } } };
  new Function('localStorage', 'document', themeInitScript())(localStorage, document);
  return attributes.get('data-theme') ?? null;
}

test('最初の描画の前に、手動で選んだ配色だけを <html> に反映する', () => {
  assert.equal(runInitScript('dark'), 'dark');
  assert.equal(runInitScript('light'), 'light');
  for (const stored of [null, 'system', 'DARK', '"><script>']) assert.equal(runInitScript(stored), null);
  // localStorage が使えない環境（プライベートモードなど）でも例外を出さない。
  assert.equal(runInitScript(new Error('SecurityError')), null);
});

test('ダークの配色は、端末の設定とdata-themeの指定で同じ値を使う', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  const system = css.match(/@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{([^}]+)\}\}/)?.[1];
  const manual = css.match(/:root\[data-theme=dark\]\{([^}]+)\}/)?.[1];
  assert.ok(system && manual, 'ダークの変数の定義が見つかりません');
  assert.equal(system, manual);
  assert.match(system, /color-scheme:dark/);
  assert.match(css, /:root\{color-scheme:light;/);
});
