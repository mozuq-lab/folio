import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReaderView, chunk, freezeOrder, importRequests, mergeReadIds, mergeViewArticles, routeReadChange, sendReadBatches } from '../lib/backlog/view.ts';
import type { Article, Feed, ReaderState } from '../lib/types.ts';

const art = (id: string, extra: Partial<Article> = {}): Article => ({ id, title: id, description: '', url: `https://e.com/${id}`, sourceId: 'f1', sourceName: 'F1', publishedAt: '2026-11-01T00:00:00Z', tags: [], readingMinutes: 1, ...extra });
const feed = (id: string, name = id.toUpperCase()): Feed => ({ id, name, url: `https://e.com/${id}.xml`, website: 'https://e.com', category: 'テクノロジー', color: '#000', initial: 'F' });
const reader = (over: Partial<ReaderState> = {}): ReaderState => ({ version: 1, articles: [], feeds: [feed('f1', 'F1'), feed('f2', 'F2')], saved: [], read: [], feedback: {}, preferences: { interests: [], mutedTopics: [], topicWeights: {}, sourceWeights: {}, diversity: 0 }, lastUpdated: null, ...over });
const ids = (articles: { id: string }[]) => articles.map(a => a.id);

test('buildReaderView: 保持対象とバックログの和をURLで重複除去し、保持対象を優先する', () => {
  const kept = art('kept', { url: 'https://e.com/same', content: '本文' });
  const view = buildReaderView(reader({ articles: [kept], read: ['kept'] }), {
    articles: [art('dup', { url: 'https://e.com/same' }), art('kept', { url: 'https://e.com/other' }), art('b1'), art('b2', { sourceId: 'f2' })],
    readIds: new Set(['b1']),
  });
  assert.deepEqual(ids(view.articles), ['kept', 'b1', 'b2']);
  assert.equal(view.articles[0], kept);
  assert.deepEqual([...view.read].sort(), ['b1', 'kept']);
});

test('buildReaderView: 購読を解除したフィードのバックログ記事は出さず、保持対象は残す', () => {
  const view = buildReaderView(reader({ feeds: [feed('f1', 'F1')], articles: [art('saved', { sourceId: 'gone' })] }), {
    articles: [art('a'), art('b', { sourceId: 'gone' })],
    readIds: new Set(),
  });
  assert.deepEqual(ids(view.articles), ['saved', 'a']);
});

test('mergeViewArticles: バックログ記事の媒体名は購読中のフィード名にそろえる', () => {
  const original = art('a', { sourceName: 'RSSのタイトル' });
  const same = art('b');
  const merged = mergeViewArticles([], [original, same], [feed('f1', 'F1')]);
  assert.equal(merged[0].sourceName, 'F1');
  assert.equal(original.sourceName, 'RSSのタイトル');
  // 名前が同じなら同じオブジェクトを使う。
  assert.equal(merged[1], same);
});

test('mergeReadIds: 同期データの既読とバックログの既読を合わせる', () => {
  const backlog = new Set(['b']);
  const merged = mergeReadIds(['a', 'b'], backlog);
  assert.deepEqual([...merged].sort(), ['a', 'b']);
  assert.deepEqual([...backlog], ['b']);
});

test('routeReadChange: 同期データにある記事は同期データへ、それ以外はバックログへ送る', () => {
  const library = new Set(['kept']);
  assert.deepEqual(routeReadChange(['kept', 'b1'], true, library, new Set()), { library: ['kept'], backlog: ['b1'] });
  // 未読に戻すとき、バックログ側でも既読なら両方を戻す（既読は両者の和で表示するため）。
  assert.deepEqual(routeReadChange(['kept', 'b1'], false, library, new Set(['kept'])), { library: ['kept'], backlog: ['b1', 'kept'] });
  assert.deepEqual(routeReadChange(['kept'], false, library, new Set()), { library: ['kept'], backlog: [] });
});

test('chunk: 指定の件数ずつに分ける', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 1000), []);
  assert.equal(chunk(Array.from({ length: 2500 }, (_, i) => i), 1000).map(c => c.length).join(','), '1000,1000,500');
  assert.throws(() => chunk([1], 0));
});

test('freezeOrder: refreshToken が同じあいだ順序を保ち、新着は足さずに件数だけ返す', () => {
  const first = freezeOrder(null, [art('a'), art('b'), art('c')], 1);
  assert.deepEqual(first, { ids: ['a', 'b', 'c'], token: 1, newCount: 0 });
  // 並びが変わり、既読になった b が候補から外れ、新着 d・e が届いた。
  const same = freezeOrder(first, [art('e'), art('c'), art('a'), art('d')], 1);
  assert.deepEqual(same.ids, ['a', 'b', 'c']);
  assert.equal(same.ids, first.ids);
  assert.equal(same.newCount, 2);
  // refreshToken が変わったら並び直す。
  const next = freezeOrder(same, [art('e'), art('c'), art('a'), art('d')], 2);
  assert.deepEqual(next, { ids: ['e', 'c', 'a', 'd'], token: 2, newCount: 0 });
});

test('freezeOrder: 空の一覧には、スクロール位置を気にせず届いた記事をそのまま並べる', () => {
  const empty = freezeOrder(null, [], 1);
  const filled = freezeOrder(empty, [art('a'), art('b')], 1);
  assert.deepEqual(filled, { ids: ['a', 'b'], token: 1, newCount: 0 });
});

test('sendReadBatches: 2回目の送信が失敗したら、1回目の1,000件は送信済みとして件数と失敗位置を返す（Review Focus 5）', async () => {
  const all = Array.from({ length: 2500 }, (_, i) => `id-${i}`);
  const batches = chunk(all, 1000);
  const sent: string[][] = [];
  const result = await sendReadBatches(batches, async batch => {
    if (sent.length === 1) return false;
    sent.push(batch);
    return true;
  });
  assert.deepEqual(result, { sent: 1000, failedAt: 1 });
  assert.equal(sent.length, 1);
  // 残りは失敗した位置から再試行できる。
  const remaining = batches.slice(result.failedAt ?? batches.length);
  assert.equal(remaining.flat().length, 1500);
  const retry = await sendReadBatches(remaining, async () => true);
  assert.deepEqual(retry, { sent: 1500, failedAt: null });
});

test('sendReadBatches: 送信が例外を投げても失敗として扱う', async () => {
  const result = await sendReadBatches([['a'], ['b']], async batch => { if (batch[0] === 'a') throw new Error('offline'); return true; });
  assert.deepEqual(result, { sent: 0, failedAt: 0 });
});

test('importRequests: 記事を1,000件ずつに分け、それぞれの既読を添え、本文は送らない', () => {
  const articles = Array.from({ length: 1500 }, (_, i) => art(`a${i}`, i === 0 ? { content: '本文', contentFetchedAt: '2026-11-01T00:00:00Z' } : {}));
  const requests = importRequests({ articles, read: ['a0', 'a1200'] });
  assert.deepEqual(requests.map(r => r.articles.length), [1000, 500]);
  assert.deepEqual(requests.map(r => r.read), [['a0'], ['a1200']]);
  assert.equal('content' in requests[0].articles[0], false);
  assert.equal('contentFetchedAt' in requests[0].articles[0], false);
  assert.deepEqual(importRequests({ articles: [], read: [] }), []);
});
