import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/d1.ts';
import { BacklogInputError, importArticles, insertArticles, listChanges, purgeExpired, setRead } from '../lib/backlog/store.ts';
import type { Article } from '../lib/types.ts';

const NOW = new Date('2026-11-09T00:00:00.000Z');
const article = (id: string, extra: Partial<Article> = {}): Article => ({
  id, title: `title ${id}`, description: 'd', url: `https://example.com/${id}`, sourceId: 'f1', sourceName: 'Feed',
  publishedAt: '2026-11-08T00:00:00.000Z', tags: [], readingMinutes: 1, ...extra,
});
const many = (count: number, prefix = 'a') => Array.from({ length: count }, (_, i) => article(`${prefix}${String(i).padStart(5, '0')}`));
const ago = (days: number, minutes = 0) => new Date(NOW.getTime() - days * 86400000 - minutes * 60000);
const drain = async (db: ReturnType<typeof createTestD1>, user: string, limit: number) => {
  const ids: string[] = []; let cursor: string | null = null; let pages = 0;
  for (;;) {
    const page = await listChanges(db, user, cursor, limit); pages++;
    ids.push(...page.entries.map(e => e.article.id)); cursor = page.next;
    if (!page.hasMore) return { ids, pages, cursor };
  }
};

test('新しい記事だけが入り、戻り値は追加件数になる', async () => {
  const db = createTestD1();
  assert.equal(await insertArticles(db, 'u1', 'f1', [article('a'), article('b')], NOW), 2);
  assert.equal(await insertArticles(db, 'u1', 'f1', [article('b'), article('c')], NOW), 1);
  assert.equal(await insertArticles(db, 'u1', 'f1', [], NOW), 0);
  assert.deepEqual((await drain(db, 'u1', 10)).ids, ['a', 'b', 'c']);
});

test('同じURLで別IDの記事は無視され、既読が保たれる', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', [article('a', { url: 'https://example.com/same' })], NOW);
  await setRead(db, 'u1', ['a'], true, NOW);
  assert.equal(await insertArticles(db, 'u1', 'f2', [article('b', { url: 'https://example.com/same' })], NOW), 0);
  const { entries } = await listChanges(db, 'u1', null);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].article.id, 'a');
  assert.equal(entries[0].feedId, 'f1');
  assert.notEqual(entries[0].readAt, null);
});

test('既読の行は再取得しても未読に戻らない', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', [article('a')], NOW);
  await setRead(db, 'u1', ['a'], true, NOW);
  await insertArticles(db, 'u1', 'f1', [article('a')], new Date(NOW.getTime() + 1000));
  assert.equal((await listChanges(db, 'u1', null)).entries[0].readAt, NOW.toISOString());
});

test('contentとcontentFetchedAtはpayloadに入らない', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', [article('a', { content: 'BODY', contentFetchedAt: 'x' })], NOW);
  const row = db.sqlite.prepare('SELECT payload, fetched_at FROM folio_articles').get() as { payload: string; fetched_at: string };
  assert.ok(!row.payload.includes('BODY'));
  assert.ok(!('content' in JSON.parse(row.payload)) && !('contentFetchedAt' in JSON.parse(row.payload)));
  assert.equal(row.fetched_at, NOW.toISOString());
  const { entries } = await listChanges(db, 'u1', null);
  assert.equal(entries[0].article.title, 'title a');
  assert.equal(entries[0].fetchedAt, NOW.toISOString());
  assert.equal(entries[0].readAt, null);
});

test('差分は利用者ごとに分かれる', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', [article('a')], NOW);
  await insertArticles(db, 'u2', 'f1', [article('b')], NOW);
  assert.deepEqual((await drain(db, 'u1', 10)).ids, ['a']);
  assert.deepEqual((await drain(db, 'u2', 10)).ids, ['b']);
});

test('1500件を1000件ずつ2ページで漏れも重複もなく取れる', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', many(1500), NOW);
  const first = await listChanges(db, 'u1', null, 1000);
  assert.equal(first.entries.length, 1000); assert.equal(first.hasMore, true);
  const second = await listChanges(db, 'u1', first.next, 1000);
  assert.equal(second.entries.length, 500); assert.equal(second.hasMore, false);
  const ids = [...first.entries, ...second.entries].map(e => e.article.id);
  assert.equal(new Set(ids).size, 1500);
  assert.deepEqual(ids, many(1500).map(a => a.id));
});

test('同じupdated_seqの行がページ境界をまたいでも漏れも重複もない', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', many(10), NOW);
  const ids = many(10).map(a => a.id);
  await setRead(db, 'u1', ids, true, NOW); // 10件が同じseqになる
  const seqs = db.sqlite.prepare('SELECT DISTINCT updated_seq FROM folio_articles').all();
  assert.equal(seqs.length, 1);
  const result = await drain(db, 'u1', 3);
  assert.deepEqual(result.ids, ids);
  assert.equal(result.pages, 4);
});

test('既読の変更は取得済みのカーソルより後に現れる', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', [article('a'), article('b')], NOW);
  const first = await listChanges(db, 'u1', null);
  assert.equal(first.hasMore, false);
  assert.equal((await listChanges(db, 'u1', first.next)).entries.length, 0);
  await setRead(db, 'u1', ['a'], true, NOW);
  const next = await listChanges(db, 'u1', first.next);
  assert.deepEqual(next.entries.map(e => [e.article.id, e.readAt]), [['a', NOW.toISOString()]]);
  await setRead(db, 'u1', ['a'], false, NOW);
  assert.equal((await listChanges(db, 'u1', next.next)).entries[0].readAt, null);
});

test('不正なカーソルはBacklogInputErrorになる', async () => {
  const db = createTestD1();
  for (const cursor of ['abc', 'x:y', '-1:a', '1.5:a', '1:%E0%A4%A']) await assert.rejects(listChanges(db, 'u1', cursor), BacklogInputError);
});

test('既読の更新は1000件までで、1001件はエラーになる', async () => {
  const db = createTestD1();
  const ids = many(1001).map(a => a.id);
  await assert.rejects(setRead(db, 'u1', ids, true, NOW), BacklogInputError);
  await insertArticles(db, 'u1', 'f1', many(1000), NOW);
  assert.equal(await setRead(db, 'u1', ids.slice(0, 1000), true, NOW), 1000);
  assert.equal(await setRead(db, 'u1', ids.slice(0, 1000), true, NOW), 0);
});

test('他の利用者の行は既読にならない', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', [article('a')], NOW);
  await insertArticles(db, 'u2', 'f1', [article('a', { url: 'https://example.com/other' })], NOW);
  assert.equal(await setRead(db, 'u1', ['a'], true, NOW), 1);
  assert.equal((await listChanges(db, 'u2', null)).entries[0].readAt, null);
});

test('取り込みは2回実行しても件数も既読も変わらない', async () => {
  const db = createTestD1();
  const articles = many(250);
  const readIds = articles.slice(0, 120).map(a => a.id);
  assert.deepEqual(await importArticles(db, 'u1', articles, readIds, NOW), { inserted: 250, markedRead: 120 });
  assert.deepEqual(await importArticles(db, 'u1', articles, readIds, NOW), { inserted: 0, markedRead: 0 });
  const rows = db.sqlite.prepare('SELECT COUNT(*) AS n, COUNT(read_at) AS r FROM folio_articles').get() as { n: number; r: number };
  assert.deepEqual({ n: rows.n, r: rows.r }, { n: 250, r: 120 });
});

test('期限切れは90日と1分前より古い行だけ消える', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', [article('old')], ago(90, 1));
  await insertArticles(db, 'u1', 'f1', [article('edge')], ago(90));
  await insertArticles(db, 'u1', 'f1', [article('keep')], ago(89));
  assert.equal(await purgeExpired(db, NOW), 1);
  assert.deepEqual((await drain(db, 'u1', 10)).ids.sort(), ['edge', 'keep']);
});

test('期限切れ削除はlimitを守る', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', many(10), ago(100));
  assert.equal(await purgeExpired(db, NOW, 4), 4);
  assert.equal(await purgeExpired(db, NOW), 6);
  assert.equal(await purgeExpired(db, NOW), 0);
});

test('期限切れ削除のあとでも番号が戻らず、古いカーソルで新しい行を取れる', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', [article('a')], ago(100));
  await setRead(db, 'u1', ['a'], true, ago(100));
  const { next } = await listChanges(db, 'u1', null);
  assert.equal(await purgeExpired(db, NOW), 1);
  await insertArticles(db, 'u1', 'f1', [article('b')], NOW);
  const page = await listChanges(db, 'u1', next);
  assert.deepEqual(page.entries.map(e => e.article.id), ['b']);
});

test('他の利用者の書き込みは番号を進めない', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', [article('a')], NOW);
  const before = db.sqlite.prepare("SELECT value FROM folio_seq WHERE user_id = 'u1'").get();
  await insertArticles(db, 'u2', 'f1', many(3), NOW);
  await setRead(db, 'u2', ['a00000'], true, NOW);
  assert.deepEqual(db.sqlite.prepare("SELECT value FROM folio_seq WHERE user_id = 'u1'").get(), before);
});

test('取り込みは記事も既読も1000件までで、超えるとエラーになる', async () => {
  const db = createTestD1();
  await assert.rejects(importArticles(db, 'u1', many(1001), [], NOW), BacklogInputError);
  await assert.rejects(importArticles(db, 'u1', [], many(1001).map(a => a.id), NOW), BacklogInputError);
  assert.deepEqual(await importArticles(db, 'u1', many(1000), [], NOW), { inserted: 1000, markedRead: 0 });
});

test('取り込みの既読は、URLが同じで別IDのサーバーの行にも付く', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', [article('server', { url: 'https://example.com/same' })], NOW);
  const local = article('local', { url: 'https://example.com/same' });
  assert.deepEqual(await importArticles(db, 'u1', [local], ['local'], NOW), { inserted: 0, markedRead: 1 });
  const { entries } = await listChanges(db, 'u1', null);
  assert.deepEqual(entries.map(e => [e.article.id, e.readAt]), [['server', NOW.toISOString()]]);
  assert.deepEqual(await importArticles(db, 'u1', [local], ['local'], NOW), { inserted: 0, markedRead: 0 });
});

test('取り込みの既読は、記事の無い既読IDでもサーバーの行に付き、他の利用者の同じURLは変えない', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', many(100), NOW);
  await insertArticles(db, 'u2', 'f1', [article('local00000', { url: 'https://example.com/a00000' })], NOW);
  const locals = many(100, 'local').map((a, i) => ({ ...a, url: `https://example.com/a${String(i).padStart(5, '0')}` }));
  const result = await importArticles(db, 'u1', locals, [...locals.map(a => a.id), 'orphan'], NOW);
  assert.deepEqual(result, { inserted: 0, markedRead: 100 });
  assert.equal((await listChanges(db, 'u2', null)).entries[0].readAt, null);
});

const marks = (db: ReturnType<typeof createTestD1>) => db.sqlite.prepare('SELECT user_id, article_id, url, expired_at FROM folio_expired ORDER BY user_id, article_id').all() as { user_id: string; article_id: string; url: string; expired_at: string }[];

test('期限切れで消した記事は、フィードに載り続けていても未読として取り込み直さない', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', [article('a'), article('b')], ago(100));
  await setRead(db, 'u1', ['a'], true, ago(99));
  assert.equal(await purgeExpired(db, NOW), 2);
  assert.deepEqual(marks(db).map(m => [m.article_id, m.url, m.expired_at]), [['a', 'https://example.com/a', NOW.toISOString()], ['b', 'https://example.com/b', NOW.toISOString()]]);
  const { cursor } = await drain(db, 'u1', 10);
  // 次の取得で同じ記事（IDが同じもの・IDが変わってもURLが同じもの）が届いても入らない。新しい記事だけが入る。
  assert.equal(await insertArticles(db, 'u1', 'f1', [article('a'), article('b2', { url: 'https://example.com/b' }), article('c')], NOW), 1);
  const page = await listChanges(db, 'u1', cursor);
  assert.deepEqual(page.entries.map(e => e.article.id), ['c']);
  // 古いバックアップの取り込みでも入れ直さない。
  assert.deepEqual(await importArticles(db, 'u1', [article('a')], ['a'], NOW), { inserted: 0, markedRead: 0 });
});

test('期限切れの印は利用者ごとで、ほかの利用者の同じ記事は取り込める', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', [article('a')], ago(100));
  await purgeExpired(db, NOW);
  assert.equal(await insertArticles(db, 'u2', 'f1', [article('a')], NOW), 1);
});

test('期限切れの印は365日で消え、消えたあとは取り込める', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', [article('a')], ago(460));
  await insertArticles(db, 'u1', 'f1', [article('b')], ago(456));
  assert.equal(await purgeExpired(db, ago(366)), 1);
  assert.equal(await purgeExpired(db, ago(364)), 1);
  assert.equal(await insertArticles(db, 'u1', 'f1', [article('a'), article('b')], ago(300)), 0);
  // 今日の削除で、365日を過ぎた a の印だけが消える。
  await purgeExpired(db, NOW);
  assert.deepEqual(marks(db).map(m => m.article_id), ['b']);
  assert.equal(await insertArticles(db, 'u1', 'f1', [article('a'), article('b')], NOW), 1);
});

test('期限切れの印は、limitで消さなかった記事には付けない', async () => {
  const db = createTestD1();
  await insertArticles(db, 'u1', 'f1', many(10), ago(100));
  assert.equal(await purgeExpired(db, NOW, 4), 4);
  const marked = marks(db).map(m => m.article_id);
  const left = (db.sqlite.prepare('SELECT article_id FROM folio_articles').all() as { article_id: string }[]).map(r => r.article_id);
  assert.equal(marked.length, 4);
  assert.equal(left.length, 6);
  assert.ok(!left.some(id => marked.includes(id)));
});

test('取り込み直した記事がもう一度期限切れになっても、印を書き直せる', async () => {
  const db = createTestD1();
  // 印より後に入った行（印が書かれる前から取り込みが進んでいた場合など）がもう一度消えても、batchが失敗しない。
  await insertArticles(db, 'u1', 'f1', [article('a')], ago(100));
  db.sqlite.prepare("INSERT INTO folio_expired (user_id, article_id, url, expired_at) VALUES ('u1', 'a', 'https://example.com/old-url', ?)").run(ago(200).toISOString());
  assert.equal(await purgeExpired(db, NOW), 1);
  assert.deepEqual(marks(db).map(m => [m.article_id, m.url, m.expired_at]), [['a', 'https://example.com/a', NOW.toISOString()]]);
});
