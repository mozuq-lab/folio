import test from 'node:test';
import assert from 'node:assert/strict';
import { COLLAPSED_FOLDERS_KEY, filterFeeds, parseCollapsedFolders, parseViewParam, resolveView, toggleFolder, viewHref } from '../lib/sidebar.ts';

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
  for (const view of ['for-you', 'digest', 'notebook', 'explore', 'all', 'saved', 'feed:opml-1a2b']) assert.equal(parseViewParam(new URL(`https://folio.example${viewHref(view)}`).searchParams.get('view') ?? 'for-you'), view);
  for (const raw of [null, '', 'unknown', 'feed:', 'feed:' + 'x'.repeat(300)]) assert.equal(parseViewParam(raw), null);
});

test('resolveView: 選んだ表示、URLの表示、For You の順。購読していないフィードは読み込み後だけ For You に戻す', () => {
  const feeds = [{ id: 'a' }, { id: 'b' }];
  assert.equal(resolveView(null, null, feeds, true), 'for-you');
  assert.equal(resolveView(null, 'feed:a', feeds, true), 'feed:a');
  assert.equal(resolveView('all', 'feed:a', feeds, true), 'all');
  assert.equal(resolveView(null, 'feed:gone', feeds, true), 'for-you');
  // 読み込み前は購読一覧が空でも、URLのフィードを捨てない。
  assert.equal(resolveView(null, 'feed:a', [], false), 'feed:a');
  assert.equal(resolveView('feed:b', null, feeds, true), 'feed:b');
});

test('filterFeeds: フィード名かURLの一部で、大文字小文字と全角半角を区別せずに絞り込む', () => {
  const feeds = [
    { id: 'a', name: 'JPCERT 注意喚起', url: 'https://www.jpcert.or.jp/rss/jpcert.rdf' },
    { id: 'b', name: 'Zenn', url: 'https://zenn.dev/feed' },
    { id: 'c', name: 'ＧＩＧＡＺＩＮＥ', url: 'https://gigazine.net/news/rss_2.0/' },
  ];
  assert.deepEqual(filterFeeds(feeds, '').map(f => f.id), ['a', 'b', 'c']);
  assert.deepEqual(filterFeeds(feeds, '  ').map(f => f.id), ['a', 'b', 'c']);
  assert.deepEqual(filterFeeds(feeds, 'jpcert').map(f => f.id), ['a']);
  assert.deepEqual(filterFeeds(feeds, '注意').map(f => f.id), ['a']);
  assert.deepEqual(filterFeeds(feeds, 'zenn.dev').map(f => f.id), ['b']);
  assert.deepEqual(filterFeeds(feeds, 'gigazine').map(f => f.id), ['c']);
  assert.deepEqual(filterFeeds(feeds, 'nothing').map(f => f.id), []);
});
