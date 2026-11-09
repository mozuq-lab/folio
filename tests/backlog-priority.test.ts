import assert from 'node:assert/strict';
import test from 'node:test';
import { formatFetchState, togglePriority } from '../lib/backlog/priority.ts';
import type { Feed } from '../lib/types.ts';

const feed = (id: string, priority?: boolean) => ({ id, name: id, url: `https://${id}.example/feed`, category: 'x', color: '#000', initial: 'x', ...(priority === undefined ? {} : { priority }) }) as Feed;
const many = (n: number) => Array.from({ length: n }, (_, i) => feed(`f${i}`, true));

test('優先は5件までONにできる', () => {
  const feeds = [...many(4), feed('target')];
  const result = togglePriority(feeds, 'target');
  assert.equal(result.error, null);
  assert.equal(result.feeds.find(f => f.id === 'target')?.priority, true);
  assert.equal(feeds[4].priority, undefined);
});

test('6件目は変更せずエラーを返す', () => {
  const feeds = [...many(5), feed('target')];
  const result = togglePriority(feeds, 'target');
  assert.equal(result.error, '優先して取得できるのは5件までです。');
  assert.equal(result.feeds, feeds);
});

test('OFFにするのは上限でも常にできる', () => {
  const feeds = [...many(5), feed('target')];
  const result = togglePriority(feeds, 'f2');
  assert.equal(result.error, null);
  assert.equal(result.feeds.find(f => f.id === 'f2')?.priority, false);
});

test('存在しないフィードは変更しない', () => {
  const feeds = many(1);
  assert.deepEqual(togglePriority(feeds, 'none'), { feeds, error: null });
});

test('formatFetchState の3パターン', () => {
  const now = new Date(2026, 10, 9, 15, 0);
  assert.equal(formatFetchState(undefined, now), 'まだ取得していません');
  assert.equal(formatFetchState({ lastFetchedAt: null, lastError: null }, now), 'まだ取得していません');
  assert.equal(formatFetchState({ lastFetchedAt: new Date(2026, 10, 9, 14, 5).toISOString(), lastError: null }, now), '最後に取得：11/9 14:05');
  assert.equal(formatFetchState({ lastFetchedAt: new Date(2025, 11, 31, 9, 7).toISOString(), lastError: null }, now), '最後に取得：2025/12/31 9:07');
  assert.equal(formatFetchState({ lastFetchedAt: new Date(2026, 10, 9, 14, 5).toISOString(), lastError: 'http' }, now), '取得に失敗しました');
  assert.equal(formatFetchState({ lastFetchedAt: null, lastError: 'network' }, now), '取得に失敗しました');
});
