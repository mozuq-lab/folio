import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/d1.ts';
import { handleFeedStates, handleImport, handleListChanges, handleRefreshFeed, handleSetRead } from '../lib/backlog/api.ts';
import { getFeedTarget, listFeedStates, syncFeedList, syncFeedListIfChanged } from '../lib/backlog/schedule.ts';
import { insertArticles } from '../lib/backlog/store.ts';
import type { Article, Feed } from '../lib/types.ts';

const NOW = new Date('2026-11-09T01:00:00.000Z');
const ORIGIN = 'https://folio.example';
const U1 = { id: 'u1', email: 'a@example.com' };
const U2 = { id: 'u2', email: 'b@example.com' };
const feed = (id: string, extra: Partial<Feed> = {}): Feed => ({ id, name: `Feed ${id}`, url: `https://example.com/${id}.xml`, website: 'https://example.com', category: 'c', color: '#000', initial: 'F', ...extra });
const article = (id: string, sourceId = 'a'): Article => ({ id, title: id, description: '', url: `https://example.com/p/${id}`, sourceId, sourceName: 'A', publishedAt: '2026-11-09T00:00:00.000Z', tags: [], readingMinutes: 1 });
const rss = (...ids: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https://example.com</link>${ids.map(id => `<item><title>${id}</title><link>https://example.com/p/${id}</link><guid>${id}</guid></item>`).join('')}</channel></rss>`;
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const cross = { origin: 'https://evil.example' };
const setup = async () => {
  const db = createTestD1();
  await syncFeedList(db, 'u1', [feed('a')]);
  await syncFeedList(db, 'u2', [feed('z')]);
  return db;
};

test('handleListChangesは差分を返し、他の利用者の記事は含めない', async () => {
  const db = await setup();
  await insertArticles(db, 'u1', 'a', [article('x'), article('y')], NOW);
  await insertArticles(db, 'u2', 'z', [article('other', 'z')], NOW);
  const res = await handleListChanges(get('/api/articles'), { db, user: U1 });
  assert.equal(res.status, 200);
  const body = await res.json() as { entries: { article: { id: string } }[]; next: string; hasMore: boolean };
  assert.deepEqual(body.entries.map(e => e.article.id), ['x', 'y']);
  assert.equal(body.hasMore, false);
  const again = await (await handleListChanges(get(`/api/articles?after=${encodeURIComponent(body.next)}`), { db, user: U1 })).json() as { entries: unknown[] };
  assert.equal(again.entries.length, 0);
});

test('handleListChangesは不正なカーソルで400', async () => {
  const res = await handleListChanges(get('/api/articles?after=bad'), { db: await setup(), user: U1 });
  assert.equal(res.status, 400);
});

test('handleSetReadは既読にでき、他の利用者の記事は変えない', async () => {
  const db = await setup();
  await insertArticles(db, 'u1', 'a', [article('x')], NOW);
  await insertArticles(db, 'u2', 'z', [article('x', 'z')], NOW);
  const res = await handleSetRead(post('/api/articles/read', { ids: ['x'], read: true }), { db, user: U1 }, NOW);
  assert.equal(res.status, 200);
  const rows = db.sqlite.prepare('SELECT user_id, read_at FROM folio_articles ORDER BY user_id').all() as { user_id: string; read_at: string | null }[];
  assert.ok(rows[0].read_at);
  assert.equal(rows[1].read_at, null);
});

test('handleSetReadは別オリジンで403、1001件で400、不正な本文で400', async () => {
  const db = await setup();
  const forbidden = await handleSetRead(post('/api/articles/read', { ids: ['x'], read: true }, cross), { db, user: U1 }, NOW);
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json() as { error: string }).error, '同じサイトから操作してください。');
  const many = await handleSetRead(post('/api/articles/read', { ids: Array.from({ length: 1001 }, (_, i) => `i${i}`), read: true }), { db, user: U1 }, NOW);
  assert.equal(many.status, 400);
  assert.equal((await many.json() as { error: string }).error, '一度に既読にできるのは1,000件までです。');
  assert.equal((await handleSetRead(post('/api/articles/read', { ids: 'x', read: true }), { db, user: U1 }, NOW)).status, 400);
  assert.equal((await handleSetRead(post('/api/articles/read', { ids: [1], read: true }), { db, user: U1 }, NOW)).status, 400);
});

test('handleImportは記事と既読を取り込む', async () => {
  const db = await setup();
  const res = await handleImport(post('/api/articles/import', { articles: [article('x'), article('y')], read: ['x'] }), { db, user: U1 }, NOW);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { inserted: 2, markedRead: 1 });
});

test('handleImportは別オリジンで403、件数超過・不正な形で400', async () => {
  const db = await setup();
  assert.equal((await handleImport(post('/api/articles/import', { articles: [], read: [] }, cross), { db, user: U1 }, NOW)).status, 403);
  assert.equal((await handleImport(post('/api/articles/import', { articles: Array.from({ length: 1001 }, (_, i) => article(`n${i}`)), read: [] }), { db, user: U1 }, NOW)).status, 400);
  assert.equal((await handleImport(post('/api/articles/import', { articles: [], read: Array.from({ length: 1001 }, (_, i) => `n${i}`) }), { db, user: U1 }, NOW)).status, 400);
  assert.equal((await handleImport(post('/api/articles/import', { articles: [{ id: 1 }], read: [] }), { db, user: U1 }, NOW)).status, 400);
  assert.equal((await handleImport(post('/api/articles/import', { articles: 'x', read: [] }), { db, user: U1 }, NOW)).status, 400);
});

test('handleImportは8MiBを超える本文を413で拒否する', async () => {
  const res = await handleImport(new Request(`${ORIGIN}/api/articles/import`, { method: 'POST', body: 'x'.repeat(8 * 1024 * 1024 + 1) }), { db: await setup(), user: U1 }, NOW);
  assert.equal(res.status, 413);
});

test('handleRefreshFeedは登録済みフィードを取得して記事を入れる', async () => {
  const db = await setup();
  const fetcher = (async () => new Response(rss('p', 'q'), { headers: { etag: '"v1"' } })) as typeof fetch;
  const res = await handleRefreshFeed(post('/api/feeds/refresh?feed=a', {}), { db, user: U1 }, { now: NOW, fetcher });
  assert.deepEqual(await res.json(), { inserted: 2 });
  assert.equal((await getFeedTarget(db, 'u1', 'a'))?.etag, '"v1"');
});

test('handleRefreshFeedは304でETagを保ち、失敗は種類だけを返す', async () => {
  const db = await setup();
  await handleRefreshFeed(post('/api/feeds/refresh?feed=a', {}), { db, user: U1 }, { now: NOW, fetcher: (async () => new Response(rss('p'), { headers: { etag: '"v1"' } })) as typeof fetch });
  const notModified = await handleRefreshFeed(post('/api/feeds/refresh?feed=a', {}), { db, user: U1 }, { now: NOW, fetcher: (async () => new Response(null, { status: 304 })) as typeof fetch });
  assert.deepEqual(await notModified.json(), { inserted: 0 });
  assert.equal((await getFeedTarget(db, 'u1', 'a'))?.etag, '"v1"');
  const failed = await handleRefreshFeed(post('/api/feeds/refresh?feed=a', {}), { db, user: U1 }, { now: NOW, fetcher: (async () => new Response('secret body', { status: 500 })) as typeof fetch });
  assert.equal(failed.status, 200);
  assert.deepEqual(await failed.json(), { inserted: 0, error: 'http' });
});

test('handleRefreshFeedは未登録・他人のフィードで404、別オリジンで403', async () => {
  const db = await setup();
  let called = 0;
  const fetcher = (async () => { called++; return new Response(rss('p')); }) as typeof fetch;
  for (const path of ['/api/feeds/refresh?feed=nope', '/api/feeds/refresh?feed=z', '/api/feeds/refresh']) {
    const res = await handleRefreshFeed(post(path, {}), { db, user: U1 }, { now: NOW, fetcher });
    assert.equal(res.status, 404);
    assert.equal((await res.json() as { error: string }).error, 'フィードが見つかりません。');
  }
  assert.equal((await handleRefreshFeed(post('/api/feeds/refresh?feed=a', {}, cross), { db, user: U1 }, { now: NOW, fetcher })).status, 403);
  assert.equal(called, 0);
});

test('handleFeedStatesは自分のフィードの状態だけを返す', async () => {
  const db = await setup();
  const res = await handleFeedStates({ db, user: U2 });
  assert.deepEqual(await res.json(), { feeds: await listFeedStates(db, 'u2') });
  assert.deepEqual((await (await handleFeedStates({ db, user: U2 })).json() as { feeds: { feedId: string }[] }).feeds.map(f => f.feedId), ['z']);
});

test('syncFeedListIfChangedは差分があるときだけ書く', async () => {
  const db = createTestD1();
  const feeds = [feed('a'), feed('b', { priority: true })];
  assert.equal(await syncFeedListIfChanged(db, 'u1', feeds), true);
  assert.equal(await syncFeedListIfChanged(db, 'u1', feeds), false);
  assert.equal(await syncFeedListIfChanged(db, 'u1', [feed('a'), feed('b', { priority: true, name: 'New' })]), true);
  assert.equal(await syncFeedListIfChanged(db, 'u1', [feed('a')]), true);
  assert.equal(Number(db.sqlite.prepare('SELECT count(*) AS n FROM folio_feeds').get()!.n), 1);
  assert.equal(await syncFeedListIfChanged(db, 'u1', [feed('a'), feed('a')]), false);
});
