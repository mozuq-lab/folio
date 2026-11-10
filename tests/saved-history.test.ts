import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EVER_SAVED, feedStats, formatFeedStat, recordEverSaved } from '../lib/saved-history.ts';
import { validateSyncDocument } from '../lib/cloud-library.ts';
import { decodeCache } from '../lib/client-library.ts';
import { parseLibraryBackup } from '../lib/library-backup.ts';
import { decodeState } from '../lib/storage.ts';
import { DEFAULT_INTELLIGENCE } from '../lib/intelligence-types.ts';
import type { Article, ReaderState } from '../lib/types.ts';

const reader = (extra: Record<string, unknown> = {}) => ({ version: 1, articles: [], feeds: [], saved: [], read: [], feedback: {}, preferences: { interests: [], mutedTopics: [], topicWeights: {}, sourceWeights: {}, diversity: 50 }, lastUpdated: null, ...extra }) as unknown as ReaderState;
const article = (id: string, sourceId: string) => ({ id, title: id, description: '', url: `https://example.com/${id}`, sourceId, sourceName: sourceId, publishedAt: '2026-11-01T00:00:00.000Z', tags: [], readingMinutes: 1 }) as Article;
const now = new Date('2026-11-10T00:00:00.000Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();

test('recordEverSaved: 記事ごとに1件だけ記録し、すでにあれば同じ reader を返す', () => {
  const first = recordEverSaved(reader(), 'a', now);
  assert.deepEqual(first.everSaved, [{ id: 'a', at: now.toISOString() }]);
  // 保存→解除→もう一度保存しても増えず、最初の日時のまま。
  const later = new Date('2026-11-11T00:00:00.000Z');
  assert.equal(recordEverSaved(first, 'a', later), first);
  assert.deepEqual(recordEverSaved(first, 'b', later).everSaved, [{ id: 'a', at: now.toISOString() }, { id: 'b', at: later.toISOString() }]);
});

test('recordEverSaved: 足すときに、ためている期間より古い記録・日時が読めない記録・上限を超えた分を捨てる', () => {
  const old = reader({ everSaved: [{ id: 'old', at: daysAgo(98) }, { id: 'broken', at: 'x' }, { id: 'edge', at: daysAgo(96) }, { id: 'recent', at: daysAgo(1) }] });
  assert.deepEqual(recordEverSaved(old, 'new', now).everSaved?.map(entry => entry.id), ['edge', 'recent', 'new']);
  // すでにある記事なら、古い記録が混じっていても reader を作り直さない（同期を増やさない）。
  assert.equal(recordEverSaved(old, 'recent', now), old);
  const full = reader({ everSaved: Array.from({ length: MAX_EVER_SAVED }, (_, i) => ({ id: `a${i}`, at: daysAgo(1) })) });
  const next = recordEverSaved(full, 'new', now).everSaved ?? [];
  assert.equal(next.length, MAX_EVER_SAVED);
  assert.equal(next[0].id, 'a1');
  assert.equal(next.at(-1)?.id, 'new');
  assert.equal(validateSyncDocument({ version: 2, reader: reader({ everSaved: next }), intelligence: DEFAULT_INTELLIGENCE, updatedAt: 't' }), true);
});

test('feedStats: フィードごとに、届いた記事と、保存したことのある記事を数える', () => {
  const backlog = [article('a1', 'a'), article('a2', 'a'), article('a3', 'a'), article('b1', 'b'), article('c1', 'c')];
  const stats = feedStats(backlog, { saved: ['a1', 'gone'], everSaved: [{ id: 'a2', at: daysAgo(3) }, { id: 'b1', at: daysAgo(2) }, { id: 'gone2', at: daysAgo(2) }] });
  // a1 は保存中、a2 と b1 は解除済み。ためている記事に無い gone・gone2 は数えない。
  assert.deepEqual(stats.get('a'), { arrived: 3, saved: 2 });
  assert.deepEqual(stats.get('b'), { arrived: 1, saved: 1 });
  assert.deepEqual(stats.get('c'), { arrived: 1, saved: 0 });
  assert.equal(stats.get('none'), undefined);
});

test('feedStats: 同じ記事は1回だけ数える（保存中で記録もある記事・一覧に2回出てくる記事）', () => {
  const backlog = [article('a1', 'a'), article('a1', 'a'), article('a2', 'a')];
  const stats = feedStats(backlog, { saved: ['a1'], everSaved: [{ id: 'a1', at: daysAgo(1) }] });
  assert.deepEqual(stats.get('a'), { arrived: 2, saved: 1 });
  // 記録が無い（この項目ができる前の）同期データでも、保存中の記事は数える。
  assert.deepEqual(feedStats(backlog, { saved: ['a2'] }).get('a'), { arrived: 2, saved: 1 });
});

test('保存→解除→保存を繰り返しても、保存したことのある記事は1件のまま', () => {
  let state = reader();
  for (let i = 0; i < 3; i++) {
    state = recordEverSaved({ ...state, saved: [...state.saved, 'a1'] }, 'a1', now);
    state = recordEverSaved({ ...state, saved: state.saved.filter(id => id !== 'a1') }, 'a1', now);
  }
  assert.deepEqual(state.saved, []);
  assert.equal(state.everSaved?.length, 1);
  assert.deepEqual(feedStats([article('a1', 'a'), article('a2', 'a')], state).get('a'), { arrived: 2, saved: 1 });
});

test('formatFeedStat: 記事がまだ無いフィードは0件と表示する', () => {
  assert.equal(formatFeedStat({ arrived: 120, saved: 3 }), '届いた記事 120件・うち保存 3件');
  assert.equal(formatFeedStat(undefined), '届いた記事 0件・うち保存 0件');
});

test('同期データ：everSaved は任意項目。無い文書・ある文書を読み込み、形の違うものは拒否する', () => {
  const doc = (r: ReaderState) => ({ version: 2, reader: r, intelligence: DEFAULT_INTELLIGENCE, updatedAt: 't' });
  const entries = [{ id: 'a1', at: daysAgo(1) }];
  assert.equal(validateSyncDocument(doc(reader())), true);
  assert.equal(validateSyncDocument(doc(reader({ everSaved: [] }))), true);
  assert.equal(validateSyncDocument(doc(reader({ everSaved: entries }))), true);
  const tooMany = Array.from({ length: MAX_EVER_SAVED + 1 }, (_, i) => ({ id: `a${i}`, at: 't' }));
  for (const bad of [{ everSaved: 'x' }, { everSaved: ['a1'] }, { everSaved: [{ id: 'a1' }] }, { everSaved: [{ id: 1, at: 't' }] }, { everSaved: [{ id: 'a1', at: 't', extra: 1 }] }, { everSaved: tooMany }]) {
    assert.equal(validateSyncDocument(doc(reader(bad))), false);
  }
});

test('JSONバックアップとブラウザーのキャッシュ：everSaved が無いものも、あるものも読み込む', () => {
  const entries = [{ id: 'a1', at: daysAgo(1) }];
  const doc = (r: ReaderState) => ({ version: 2, reader: r, intelligence: DEFAULT_INTELLIGENCE, updatedAt: 't' });
  // JSONバックアップ
  assert.equal(parseLibraryBackup(JSON.stringify(doc(reader()))).reader.everSaved, undefined);
  assert.deepEqual(parseLibraryBackup(JSON.stringify(doc(reader({ everSaved: entries })))).reader.everSaved, entries);
  // ブラウザーのキャッシュ（今の形式）
  const cache = (r: ReaderState) => JSON.stringify({ document: doc(r), revision: 3, pending: false });
  const fallback = reader({ lastUpdated: 'fallback' });
  for (const stored of [reader(), reader({ everSaved: entries })]) {
    const result = decodeCache(cache(stored), fallback);
    assert.equal(result.storageWarning, false);
    assert.deepEqual(result.cache.document.reader.everSaved, stored.everSaved);
  }
  // ブラウザーのキャッシュ（古い形式）
  assert.equal(decodeState(JSON.stringify(reader()), fallback).everSaved, undefined);
  assert.deepEqual(decodeState(JSON.stringify(reader({ everSaved: entries })), fallback).everSaved, entries);
  assert.equal(decodeState(JSON.stringify(reader({ everSaved: [{ id: 'a1' }] })), fallback), fallback);
});
