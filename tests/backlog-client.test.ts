import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeReads, applyChanges, emptyBacklog, expireEntries, forOwner, isRead, parseChanges, queueRead, takePendingBatches, type BacklogState } from '../lib/backlog/client-state.ts';
import type { BacklogEntry } from '../lib/backlog/types.ts';

const NOW = new Date('2026-11-09T00:00:00.000Z');
const ago = (days: number, minutes = 0) => new Date(NOW.getTime() - days * 86400000 - minutes * 60000).toISOString();
const entry = (id: string, extra: Partial<BacklogEntry> = {}, title = `title ${id}`): BacklogEntry => ({
  article: { id, title, description: 'd', url: `https://example.com/${id}`, sourceId: 'f1', sourceName: 'Feed', publishedAt: '2026-11-08T00:00:00.000Z', tags: [], readingMinutes: 1 },
  feedId: 'f1', fetchedAt: ago(1), readAt: null, ...extra,
});
const ids = (state: BacklogState) => [...state.entries.keys()].sort();

test('applyChanges adds new entries, overwrites existing ones and stores the cursor', () => {
  const start = applyChanges(emptyBacklog('u1'), [entry('a'), entry('b')], 'c1');
  assert.deepEqual(ids(start), ['a', 'b']);
  assert.equal(start.cursor, 'c1');
  const next = applyChanges(start, [entry('b', { readAt: ago(0) }, 'new title'), entry('c')], 'c2');
  assert.deepEqual(ids(next), ['a', 'b', 'c']);
  assert.equal(next.entries.get('b')?.article.title, 'new title');
  assert.equal(next.entries.get('b')?.readAt, ago(0));
  assert.equal(next.cursor, 'c2');
  // The previous state is not mutated.
  assert.deepEqual(ids(start), ['a', 'b']);
  assert.equal(start.entries.get('b')?.readAt, null);
  assert.equal(start.cursor, 'c1');
});

test('applyChanges keeps the device state for articles with unsent read operations (Review Focus 4)', () => {
  let state = applyChanges(emptyBacklog('u1'), [entry('a'), entry('b', { readAt: ago(2) }), entry('c')], 'c1');
  state = queueRead(state, ['a'], true, NOW);
  state = queueRead(state, ['b'], false, NOW);
  assert.equal(isRead(state, 'a'), true);
  assert.equal(isRead(state, 'b'), false);
  // The server still reports the old read state (the operations have not been sent).
  const next = applyChanges(state, [entry('a', {}, 'renamed'), entry('b', { readAt: ago(2) }), entry('c', { readAt: ago(0) })], 'c2');
  assert.equal(isRead(next, 'a'), true);
  assert.notEqual(next.entries.get('a')?.readAt, null);
  assert.equal(next.entries.get('a')?.article.title, 'renamed');
  assert.equal(isRead(next, 'b'), false);
  assert.equal(next.entries.get('b')?.readAt, null);
  // Articles without unsent operations follow the server.
  assert.equal(isRead(next, 'c'), true);
  assert.deepEqual([...next.pendingReads], [['a', true], ['b', false]]);
});

test('applyChanges keeps an unsent read for an article that arrives for the first time', () => {
  const state = queueRead(emptyBacklog('u1'), ['z'], true, NOW);
  assert.equal(isRead(state, 'z'), true);
  const next = applyChanges(state, [entry('z')], 'c1');
  assert.equal(isRead(next, 'z'), true);
  assert.notEqual(next.entries.get('z')?.readAt, null);
});

test('expireEntries removes entries fetched more than 90 days ago', () => {
  let state = applyChanges(emptyBacklog('u1'), [entry('old', { fetchedAt: ago(90, 1) }), entry('edge', { fetchedAt: ago(90) }), entry('new', { fetchedAt: ago(1) })], 'c1');
  state = queueRead(state, ['old', 'new'], true, NOW);
  const next = expireEntries(state, NOW);
  assert.deepEqual(ids(next), ['edge', 'new']);
  // Unsent operations for expired articles are dropped as well.
  assert.deepEqual([...next.pendingReads.keys()], ['new']);
  assert.equal(next.cursor, 'c1');
  assert.deepEqual(ids(state), ['edge', 'new', 'old']);
});

test('expireEntries returns the same state when nothing expired', () => {
  const state = applyChanges(emptyBacklog('u1'), [entry('a')], 'c1');
  assert.equal(expireEntries(state, NOW), state);
});

test('queueRead records the operation and the latest operation wins', () => {
  let state = applyChanges(emptyBacklog('u1'), [entry('a'), entry('b')], 'c1');
  state = queueRead(state, ['a', 'b'], true, NOW);
  assert.equal(state.entries.get('a')?.readAt, NOW.toISOString());
  state = queueRead(state, ['a'], false, NOW);
  assert.deepEqual([...state.pendingReads], [['a', false], ['b', true]]);
  assert.equal(state.entries.get('a')?.readAt, null);
  assert.equal(isRead(state, 'a'), false);
  assert.equal(isRead(state, 'b'), true);
});

test('takePendingBatches splits 2,500 reads into 1,000, 1,000 and 500', () => {
  const many = Array.from({ length: 2500 }, (_, i) => `a${i}`);
  const state = queueRead(emptyBacklog('u1'), many, true, NOW);
  const batches = takePendingBatches(state);
  assert.deepEqual(batches.map(batch => batch.ids.length), [1000, 1000, 500]);
  assert.ok(batches.every(batch => batch.read === true));
  assert.deepEqual(batches.flatMap(batch => batch.ids), many);
  // Taking batches does not remove them; they stay until acknowledged.
  assert.equal(state.pendingReads.size, 2500);
});

test('takePendingBatches separates read and unread operations', () => {
  let state = queueRead(emptyBacklog('u1'), ['a', 'b', 'c'], true, NOW);
  state = queueRead(state, ['b'], false, NOW);
  assert.deepEqual(takePendingBatches(state, 2), [{ ids: ['a', 'c'], read: true }, { ids: ['b'], read: false }]);
  assert.deepEqual(takePendingBatches(emptyBacklog('u1')), []);
});

test('acknowledgeReads removes only operations that did not change while sending', () => {
  let state = queueRead(emptyBacklog('u1'), ['a', 'b', 'c'], true, NOW);
  const [batch] = takePendingBatches(state);
  state = queueRead(state, ['b'], false, NOW);
  const next = acknowledgeReads(state, batch);
  assert.deepEqual([...next.pendingReads], [['b', false]]);
  assert.equal(state.pendingReads.size, 3);
});

test('forOwner returns an empty state for a different owner (Review Focus 2)', () => {
  let state = applyChanges(emptyBacklog('u1'), [entry('a')], 'c1');
  state = queueRead(state, ['a'], true, NOW);
  assert.equal(forOwner(state, 'u1'), state);
  const other = forOwner(state, 'u2');
  assert.equal(other.ownerId, 'u2');
  assert.equal(other.cursor, null);
  assert.equal(other.entries.size, 0);
  assert.equal(other.pendingReads.size, 0);
  assert.deepEqual(takePendingBatches(other), []);
  const fresh = forOwner(null, 'u3');
  assert.equal(fresh.ownerId, 'u3');
  assert.equal(fresh.entries.size, 0);
});

test('parseChanges accepts the API response and skips malformed entries', () => {
  const good = entry('a');
  const parsed = parseChanges({ entries: [good, { article: { id: 'x' }, feedId: 'f1', fetchedAt: ago(1), readAt: null }, null], next: 'c2', hasMore: true });
  assert.deepEqual(parsed, { entries: [good], next: 'c2', hasMore: true });
  assert.equal(parseChanges(null), null);
  assert.equal(parseChanges({ entries: [], next: 1, hasMore: false }), null);
  assert.equal(parseChanges({ entries: {}, next: 'c', hasMore: false }), null);
  assert.equal(parseChanges({ entries: [], next: 'c' }), null);
});

test('applyChanges keeps reads acknowledged while the page was being fetched', () => {
  let state = applyChanges(emptyBacklog('u1'), [entry('a'), entry('b'), entry('c')], 'c1');
  state = queueRead(state, ['a', 'b'], true, NOW);
  state = acknowledgeReads(state, takePendingBatches(state)[0]);
  state = queueRead(state, ['b'], false, NOW);
  // The page was requested before the acknowledgement, so it still reports a and b as unread and c as read.
  const settled = new Map([['a', true], ['b', true]]);
  const next = applyChanges(state, [entry('a'), entry('b'), entry('c', { readAt: ago(0) })], 'c2', settled);
  assert.equal(isRead(next, 'a'), true);
  assert.notEqual(next.entries.get('a')?.readAt, null);
  // A newer unsent operation wins over the acknowledged one.
  assert.equal(isRead(next, 'b'), false);
  assert.equal(isRead(next, 'c'), true);
  // Settled operations are not turned back into unsent ones.
  assert.deepEqual([...next.pendingReads], [['b', false]]);
});
