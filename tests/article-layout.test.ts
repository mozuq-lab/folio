import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTICLE_LAYOUT_KEY, DEFAULT_ARTICLE_LAYOUT, parseArticleLayout } from '../lib/article-layout.ts';

test('保存済みの表示スタイルを読み取り、不明な値や未保存は既定のカード表示にする', () => {
  assert.equal(ARTICLE_LAYOUT_KEY, 'folio.articleLayout');
  assert.equal(DEFAULT_ARTICLE_LAYOUT, 'grid');
  for (const layout of ['grid', 'list', 'compact'] as const) assert.equal(parseArticleLayout(layout), layout);
  for (const raw of [null, '', 'table', 'GRID', '{"layout":"list"}']) assert.equal(parseArticleLayout(raw), 'grid');
});
