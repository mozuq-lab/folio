import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBatches, headlineOnly, mergeAnalysis } from '../lib/ai-analyze.ts';
import { ANALYZE_BATCH_SIZE, ANALYZE_MAX_ARTICLES } from '../lib/ai/types.ts';
import type { Article } from '../lib/types.ts';
import type { ArticleAnalysis } from '../lib/intelligence-types.ts';

const art = (id: string): Article => ({ id, title: `見出し${id}`, description: '長い概要'.repeat(100), content: '本文', url: `https://e.com/${id}`, image: 'https://e.com/i.png', sourceId: 's', sourceName: '媒体', publishedAt: '2026-11-09T00:00:00Z', tags: ['AI'], readingMinutes: 3 });
const item = (id: string): ArticleAnalysis => ({ articleId: id, interest: 1, importance: 1, summary: '', reason: '', importanceReason: '' });

test('headlineOnly: 見出し・媒体・日時・タグだけを残し、概要・本文・画像・URLは送らない', () => {
  assert.deepEqual(headlineOnly(art('a')), { id: 'a', title: '見出しa', description: '', url: '', sourceId: 's', sourceName: '媒体', publishedAt: '2026-11-09T00:00:00Z', tags: ['AI'], readingMinutes: 3 });
});

test('analyzeBatches: 最大300件を50件ずつに分ける', () => {
  assert.equal(ANALYZE_MAX_ARTICLES, 300);
  assert.equal(ANALYZE_BATCH_SIZE, 50);
  const batches = analyzeBatches(Array.from({ length: 320 }, (_, i) => art(`a${i}`)));
  assert.deepEqual(batches.map(b => b.length), [50, 50, 50, 50, 50, 50]);
  assert.equal(batches[0][0].description, '');
  assert.deepEqual(analyzeBatches([]), []);
  assert.deepEqual(analyzeBatches([art('x')]).map(b => b.length), [1]);
});

test('mergeAnalysis: 新しい結果で上書きし、表示中の記事の分だけを新しい順に上限まで残す', () => {
  const existing = { gone: item('gone'), a: { ...item('a'), interest: 5 }, b: item('b') };
  const merged = mergeAnalysis(existing, [{ ...item('a'), interest: 9 }, item('c')], new Set(['a', 'b', 'c']), 2);
  assert.deepEqual(Object.keys(merged).sort(), ['a', 'c']);
  assert.equal(merged.a.interest, 9);
  assert.deepEqual(Object.keys(mergeAnalysis(existing, [], new Set(['a', 'b', 'c']))).sort(), ['a', 'b']);
});
