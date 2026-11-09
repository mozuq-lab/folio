import test from 'node:test';
import assert from 'node:assert/strict';
import { COLLAPSED_FOLDERS_KEY, parseCollapsedFolders, parseViewParam, toggleFolder, viewHref } from '../lib/sidebar.ts';

test('閉じたフォルダの保存値を読み取り、壊れた値は空にする', () => {
  assert.equal(COLLAPSED_FOLDERS_KEY, 'folio.collapsedFolders');
  assert.deepEqual(parseCollapsedFolders('["テクノロジー","暮らし"]'), ['テクノロジー', '暮らし']);
  for (const raw of [null, '', '{', '{"a":1}', '"x"', '[1,2]']) assert.deepEqual(parseCollapsedFolders(raw), []);
  assert.deepEqual(parseCollapsedFolders('["a",1,"b","a"]'), ['a', 'b']);
});

test('フォルダの開閉を切り替える', () => {
  assert.deepEqual(toggleFolder([], 'a'), ['a']);
  assert.deepEqual(toggleFolder(['a', 'b'], 'a'), ['b']);
});

test('表示のURL：フィードは別タブで開けるURLにし、URLから表示を復元する', () => {
  assert.equal(viewHref('for-you'), '/');
  assert.equal(viewHref('feed:opml-1a2b'), '/?view=feed%3Aopml-1a2b');
  assert.equal(viewHref('all'), '/?view=all');
  for (const view of ['for-you', 'digest', 'stories', 'notebook', 'explore', 'all', 'saved', 'feed:opml-1a2b']) assert.equal(parseViewParam(new URL(`https://folio.example${viewHref(view)}`).searchParams.get('view') ?? 'for-you'), view);
  for (const raw of [null, '', 'unknown', 'feed:', 'feed:' + 'x'.repeat(300)]) assert.equal(parseViewParam(raw), null);
});
