import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/d1.ts';
import { listFeedStates, pickFeedsToFetch, recordFeedResult, syncFeedList, touchUser } from '../lib/backlog/schedule.ts';
import type { Feed } from '../lib/types.ts';

const NOW = new Date('2026-11-09T00:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60000);
const feed = (id: string, extra: Partial<Feed> = {}): Feed => ({ id, name: `Feed ${id}`, url: `https://example.com/${id}.xml`, website: 'https://example.com', category: 'c', color: '#000', initial: 'F', ...extra });
const ALLOWED = new Set(['a@example.com']);
const setup = async (feeds: Feed[], user = 'u1', email = 'a@example.com') => {
  const db = createTestD1();
  await touchUser(db, user, email, NOW);
  await syncFeedList(db, user, feeds);
  return db;
};
const rows = (db: ReturnType<typeof createTestD1>) => db.sqlite.prepare('SELECT feed_id, url, name, priority FROM folio_feeds WHERE user_id = ? ORDER BY feed_id').all('u1').map(r => ({ ...r }));

test('syncFeedListは追加・更新・削除を反映する', async () => {
  const db = await setup([feed('a'), feed('b'), feed('c')]);
  await recordFeedResult(db, 'u1', 'c', NOW, { ok: true, etag: 'x', lastModified: null });
  await syncFeedList(db, 'u1', [feed('b', { name: 'B2', url: 'https://example.com/new.xml', priority: true }), feed('d')]);
  assert.deepEqual(rows(db), [
    { feed_id: 'b', url: 'https://example.com/new.xml', name: 'B2', priority: 1 },
    { feed_id: 'd', url: 'https://example.com/d.xml', name: 'Feed d', priority: 0 },
  ]);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM folio_feed_state WHERE feed_id = 'c'").get()!.n, 0);
});

test('syncFeedListは別の利用者の行に触れない', async () => {
  const db = await setup([feed('a')]);
  await syncFeedList(db, 'u2', [feed('z')]);
  await syncFeedList(db, 'u2', []);
  assert.equal(rows(db).length, 1);
});

test('優先は購読順の先頭5件だけ1になる', async () => {
  const db = await setup(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => feed(id, { priority: true })));
  assert.deepEqual(rows(db).map(r => r.priority), [1, 1, 1, 1, 1, 0, 0]);
  await syncFeedList(db, 'u1', [feed('g', { priority: true }), feed('f'), feed('a', { priority: true })]);
  assert.deepEqual(rows(db).map(r => [r.feed_id, r.priority]), [['a', 1], ['f', 0], ['g', 1]]);
});

test('500件の購読も少ない回数のbatchで写せる', async () => {
  const db = createTestD1();
  let batches = 0;
  const counting = { prepare: db.prepare.bind(db), batch: (s: never) => { batches++; return db.batch(s); } };
  const feeds = Array.from({ length: 500 }, (_, i) => feed(`f${String(i).padStart(3, '0')}`));
  await syncFeedList(counting as never, 'u1', feeds);
  assert.equal(rows(db).length, 500);
  assert.ok(batches <= 3, `batches=${batches}`);
  batches = 0;
  await syncFeedList(counting as never, 'u1', feeds.slice(0, 10));
  assert.equal(rows(db).length, 10);
  assert.ok(batches <= 3, `batches=${batches}`);
});

test('touchUserは1時間未満なら書かず、1時間以上なら書く', async () => {
  const db = createTestD1();
  const seen = () => db.sqlite.prepare('SELECT email, last_seen_at FROM folio_users WHERE user_id = ?').get('u1');
  await touchUser(db, 'u1', 'a@example.com', NOW);
  await touchUser(db, 'u1', 'b@example.com', at(59));
  assert.deepEqual({ ...seen() }, { email: 'a@example.com', last_seen_at: NOW.toISOString() });
  await touchUser(db, 'u1', 'b@example.com', at(61));
  assert.deepEqual({ ...seen() }, { email: 'b@example.com', last_seen_at: at(61).toISOString() });
});

test('pickFeedsToFetchは未取得を先に、次に古い順に選ぶ', async () => {
  const db = await setup(['a', 'b', 'c'].map(id => feed(id)));
  await recordFeedResult(db, 'u1', 'a', at(-10), { ok: true, etag: null, lastModified: null });
  await recordFeedResult(db, 'u1', 'b', at(-20), { ok: true, etag: null, lastModified: null });
  assert.deepEqual((await pickFeedsToFetch(db, NOW, ALLOWED)).map(t => t.feedId), ['c', 'b']);
});

test('優先と通常から1件ずつ選ぶ', async () => {
  const db = createTestD1();
  await touchUser(db, 'u1', 'a@example.com', NOW);
  await syncFeedList(db, 'u1', [...['p1', 'p2'].map(id => feed(id, { priority: true })), ...['n1', 'n2', 'n3', 'n4', 'n5'].map(id => feed(id))]);
  await recordFeedResult(db, 'u1', 'p1', at(-5), { ok: true, etag: null, lastModified: null });
  const picked = await pickFeedsToFetch(db, NOW, ALLOWED);
  assert.deepEqual(picked.map(t => [t.feedId, t.priority]), [['p2', true], ['n1', false]]);
});

test('優先が0件なら通常2件、通常が0件なら優先2件', async () => {
  const none = await setup(['a', 'b', 'c'].map(id => feed(id)));
  assert.deepEqual((await pickFeedsToFetch(none, NOW, ALLOWED)).map(t => t.feedId), ['a', 'b']);
  const only = await setup(['a', 'b', 'c'].map(id => feed(id, { priority: true })));
  assert.deepEqual((await pickFeedsToFetch(only, NOW, ALLOWED)).map(t => t.feedId), ['a', 'b']);
  assert.deepEqual(await pickFeedsToFetch(createTestD1(), NOW, ALLOWED), []);
});

test('90日を超えて来ていない利用者と許可外のメールは対象外', async () => {
  const db = createTestD1();
  await touchUser(db, 'old', 'a@example.com', new Date(NOW.getTime() - 91 * 86400000));
  await touchUser(db, 'other', 'x@example.com', NOW);
  await touchUser(db, 'edge', 'a@example.com', new Date(NOW.getTime() - 89 * 86400000));
  for (const user of ['old', 'other', 'edge']) await syncFeedList(db, user, [feed(`${user}-feed`)]);
  assert.deepEqual((await pickFeedsToFetch(db, NOW, ALLOWED)).map(t => t.userId), ['edge']);
  assert.deepEqual(await pickFeedsToFetch(db, NOW, new Set()), []);
});

test('購読を解除したフィードは選ばれない', async () => {
  const db = await setup([feed('a'), feed('b')]);
  await syncFeedList(db, 'u1', [feed('b')]);
  assert.deepEqual((await pickFeedsToFetch(db, NOW, ALLOWED)).map(t => t.feedId), ['b']);
  await recordFeedResult(db, 'u1', 'a', NOW, { ok: false, error: 'http' });
  assert.deepEqual(await listFeedStates(db, 'u1'), [{ feedId: 'b', lastFetchedAt: null, lastError: null }]);
});

test('許可メールが多くても全員を対象にできる', async () => {
  const db = createTestD1();
  const emails = Array.from({ length: 250 }, (_, i) => `u${i}@example.com`);
  await touchUser(db, 'u249', emails[249], NOW);
  await syncFeedList(db, 'u249', [feed('only')]);
  assert.deepEqual((await pickFeedsToFetch(db, NOW, new Set(emails))).map(t => t.feedId), ['only']);
});

test('recordFeedResultはETagをそのまま保存し、失敗でも取得時刻を進める', async () => {
  const db = await setup([feed('a'), feed('b')]);
  await recordFeedResult(db, 'u1', 'a', at(-60), { ok: true, etag: 'W/"abc"', lastModified: 'Mon, 09 Nov 2026 00:00:00 GMT' });
  await recordFeedResult(db, 'u1', 'a', at(-30), { ok: false, error: 'timeout' });
  assert.deepEqual(await listFeedStates(db, 'u1'), [
    { feedId: 'a', lastFetchedAt: at(-30).toISOString(), lastError: 'timeout' },
    { feedId: 'b', lastFetchedAt: null, lastError: null },
  ]);
  const [target] = await pickFeedsToFetch(db, NOW, ALLOWED);
  assert.equal(target.feedId, 'b');
  assert.deepEqual((await pickFeedsToFetch(db, NOW, ALLOWED)).find(t => t.feedId === 'a'), { userId: 'u1', feedId: 'a', url: 'https://example.com/a.xml', etag: 'W/"abc"', lastModified: 'Mon, 09 Nov 2026 00:00:00 GMT', priority: false });
  await recordFeedResult(db, 'u1', 'a', at(-1), { ok: true, etag: null, lastModified: null });
  assert.equal((await listFeedStates(db, 'u1'))[0].lastError, null);
});
