import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/d1.ts';
import { parseAllowedEmails, runScheduledFetch } from '../lib/backlog/scheduled.ts';
import { syncFeedList, touchUser } from '../lib/backlog/schedule.ts';
import { insertArticles } from '../lib/backlog/store.ts';
import type { Article, Feed } from '../lib/types.ts';

const NOW = new Date('2026-11-09T01:00:00.000Z');
const ALLOWED = new Set(['a@example.com']);
const feed = (id: string, extra: Partial<Feed> = {}): Feed => ({ id, name: `Feed ${id}`, url: `https://example.com/${id}.xml`, website: 'https://example.com', category: 'c', color: '#000', initial: 'F', ...extra });
const rss = (...ids: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https://example.com</link>${ids.map(id => `<item><title>${id}</title><link>https://example.com/p/${id}</link><guid>${id}</guid><pubDate>Mon, 09 Nov 2026 00:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
const setup = async (feeds: Feed[]) => {
  const db = createTestD1();
  await touchUser(db, 'u1', 'a@example.com', NOW);
  await syncFeedList(db, 'u1', feeds);
  return db;
};
const state = (db: ReturnType<typeof createTestD1>, id: string) => ({ ...db.sqlite.prepare('SELECT * FROM folio_feed_state WHERE feed_id = ?').get(id) } as Record<string, string | null>);
const count = (db: ReturnType<typeof createTestD1>) => Number(db.sqlite.prepare('SELECT count(*) AS n FROM folio_articles').get()!.n);

test('parseAllowedEmailsは小文字化し空要素を除く', () => {
  assert.deepEqual([...parseAllowedEmails(' A@Example.com, ,b@example.com,')], ['a@example.com', 'b@example.com']);
  assert.equal(parseAllowedEmails(undefined).size, 0);
});

test('新規記事が入り、last_fetched_atとETagが記録される', async () => {
  const db = await setup([feed('a')]);
  const fetcher = (async () => new Response(rss('x', 'y'), { headers: { etag: '"v1"', 'content-type': 'application/rss+xml' } })) as typeof fetch;
  const result = await runScheduledFetch({ db, now: NOW, allowedEmails: ALLOWED, fetcher });
  assert.deepEqual(result, { fetched: 1, inserted: 2, failed: 0, purged: 0 });
  assert.equal(count(db), 2);
  assert.equal(state(db, 'a').last_fetched_at, NOW.toISOString());
  assert.equal(state(db, 'a').etag, '"v1"');
});

test('304ではETagを保ったまま記事を解析しない', async () => {
  const db = await setup([feed('a')]);
  await runScheduledFetch({ db, now: NOW, allowedEmails: ALLOWED, fetcher: (async () => new Response(rss('x'), { headers: { etag: '"v1"', 'last-modified': 'Mon, 09 Nov 2026 00:00:00 GMT' } })) as typeof fetch });
  const later = new Date(NOW.getTime() + 600000);
  let seen: Headers | undefined;
  const fetcher = (async (_url: string, init?: RequestInit) => { seen = new Headers(init?.headers); return new Response(null, { status: 304 }); }) as typeof fetch;
  const result = await runScheduledFetch({ db, now: later, allowedEmails: ALLOWED, fetcher });
  assert.equal(seen?.get('if-none-match'), '"v1"');
  assert.deepEqual(result, { fetched: 1, inserted: 0, failed: 0, purged: 0 });
  assert.equal(state(db, 'a').etag, '"v1"');
  assert.equal(state(db, 'a').last_modified, 'Mon, 09 Nov 2026 00:00:00 GMT');
  assert.equal(state(db, 'a').last_fetched_at, later.toISOString());
});

test('1件目が失敗しても2件目を処理し、失敗の種類だけを記録する', async () => {
  const db = await setup([feed('a'), feed('b')]);
  const fetcher = (async (url: string) => url.endsWith('/a.xml') ? new Response('secret body', { status: 500 }) : new Response(rss('z'))) as typeof fetch;
  const result = await runScheduledFetch({ db, now: NOW, allowedEmails: ALLOWED, fetcher });
  assert.deepEqual(result, { fetched: 1, inserted: 1, failed: 1, purged: 0 });
  assert.equal(state(db, 'a').last_error, 'http');
  assert.equal(state(db, 'b').last_error, null);
  assert.equal(count(db), 1);
});

test('フィードのURLがHTMLを返したら、ページのフィードの指定を探さずに失敗として記録する', async () => {
  const db = await setup([feed('a')]);
  const calls: string[] = [];
  const page = '<html><head><link rel="alternate" type="application/rss+xml" href="https://example.com/real.xml"></head></html>';
  const fetcher = (async (url: string) => { calls.push(url); return url.endsWith('/a.xml') ? new Response(page, { headers: { 'content-type': 'text/html' } }) : new Response(rss('z')); }) as typeof fetch;
  const result = await runScheduledFetch({ db, now: NOW, allowedEmails: ALLOWED, fetcher });
  assert.deepEqual(result, { fetched: 0, inserted: 0, failed: 1, purged: 0 });
  assert.equal(state(db, 'a').last_error, 'format');
  assert.deepEqual(calls, ['https://example.com/a.xml']);
  assert.equal(count(db), 0);
});

test('取得中の例外はnetworkとして記録される', async () => {
  const db = await setup([feed('a')]);
  const fetcher = (async () => { throw new TypeError('boom'); }) as typeof fetch;
  const result = await runScheduledFetch({ db, now: NOW, allowedEmails: ALLOWED, fetcher });
  assert.equal(result.failed, 1);
  assert.equal(state(db, 'a').last_error, 'network');
});

test('UTC 03:00〜03:04だけ期限切れを削除する', async () => {
  const old = '2026-07-01T00:00:00.000Z';
  const prepare = async () => {
    const db = await setup([]);
    await insertArticles(db, 'u1', 'f1', [{ id: 'old', title: 't', description: '', url: 'https://example.com/old', sourceId: 'f1', sourceName: 'F', publishedAt: old, tags: [], readingMinutes: 1 } as Article], new Date(old));
    return db;
  };
  const noFetch = (async () => new Response(rss())) as typeof fetch;
  const db1 = await prepare();
  const r1 = await runScheduledFetch({ db: db1, now: new Date('2026-11-09T03:02:00.000Z'), allowedEmails: ALLOWED, fetcher: noFetch });
  assert.equal(r1.purged, 1);
  assert.equal(count(db1), 0);
  const db2 = await prepare();
  const r2 = await runScheduledFetch({ db: db2, now: new Date('2026-11-09T04:00:00.000Z'), allowedEmails: ALLOWED, fetcher: noFetch });
  assert.equal(r2.purged, 0);
  assert.equal(count(db2), 1);
  const db3 = await prepare();
  assert.equal((await runScheduledFetch({ db: db3, now: new Date('2026-11-09T03:05:00.000Z'), allowedEmails: ALLOWED, fetcher: noFetch })).purged, 0);
});

test('記録に失敗しても挿入済みの件数は数える', async () => {
  const db = await setup([feed('a')]);
  const original = db.prepare.bind(db);
  (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => { if (sql.includes('INTO folio_feed_state')) throw new Error('boom'); return original(sql); }) as typeof db.prepare;
  const result = await runScheduledFetch({ db, now: NOW, allowedEmails: ALLOWED, fetcher: (async () => new Response(rss('x', 'y'))) as typeof fetch });
  assert.deepEqual(result, { fetched: 0, inserted: 2, failed: 1, purged: 0 });
});

test('期限切れ削除が失敗しても投げず、失敗として数える', async () => {
  const db = await setup([]);
  const original = db.prepare.bind(db);
  (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => { if (sql.startsWith('DELETE FROM folio_articles')) throw new Error('boom'); return original(sql); }) as typeof db.prepare;
  const result = await runScheduledFetch({ db, now: new Date('2026-11-09T03:02:00.000Z'), allowedEmails: ALLOWED, fetcher: (async () => new Response(rss())) as typeof fetch });
  assert.deepEqual(result, { fetched: 0, inserted: 0, failed: 1, purged: 0 });
});

test('期限切れで消した記事は、フィードに載り続けていても次の定期取得で入り直さない', async () => {
  const db = await setup([feed('a')]);
  const fetcher = (async () => new Response(rss('x', 'y'), { headers: { 'content-type': 'application/rss+xml' } })) as typeof fetch;
  const first = new Date('2026-08-01T01:00:00.000Z');
  assert.equal((await runScheduledFetch({ db, now: first, allowedEmails: ALLOWED, fetcher })).inserted, 2);
  // 91日後の削除の時間帯：取得のあとに2件とも消える。
  const purgeTime = new Date('2026-10-31T03:01:00.000Z');
  const purged = await runScheduledFetch({ db, now: purgeTime, allowedEmails: ALLOWED, fetcher });
  assert.equal(purged.purged, 2);
  assert.equal(count(db), 0);
  // フィードには同じ2件が載り続けている。新しい記事 z だけが入る。
  const next = await runScheduledFetch({ db, now: new Date('2026-10-31T05:00:00.000Z'), allowedEmails: ALLOWED, fetcher: (async () => new Response(rss('x', 'y', 'z'), { headers: { 'content-type': 'application/rss+xml' } })) as typeof fetch });
  assert.equal(next.inserted, 1);
  assert.equal(count(db), 1);
  assert.deepEqual(db.sqlite.prepare('SELECT payload FROM folio_articles').all().map(row => (JSON.parse(String(row.payload)) as Article).title), ['z']);
});
