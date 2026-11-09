import type { Article } from '../types.ts';
import { MAX_CHANGES_PAGE, MAX_READ_BATCH, RETENTION_DAYS } from './constants.ts';

type Db = Pick<D1Database, 'prepare' | 'batch'>;
export type StoredArticle = Omit<Article, 'content' | 'contentFetchedAt'>;
export type BacklogEntry = { article: StoredArticle; feedId: string; fetchedAt: string; readAt: string | null };
export class BacklogInputError extends Error {}

// D1は1文あたりのバインド数が100まで。1回のbatchに入れる文の数も抑える。
const IDS_PER_STATEMENT = 90;
const ROWS_PER_STATEMENT = 18;
const STATEMENTS_PER_BATCH = 50;
const MAX_IMPORT = 1000;
const SEQ = '(SELECT value FROM folio_seq WHERE user_id = ?1)';

const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

// 各batchの先頭で利用者の番号を1つ進め、そのbatchの書き込みは同じ番号を使う。
// 番号は行とは別に持つので、期限切れで行が消えても戻らない。
async function runInBatches(db: Db, userId: string, statements: D1PreparedStatement[]) {
  const bump = () => db.prepare('INSERT INTO folio_seq (user_id, value) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET value = value + 1').bind(userId);
  let total = 0;
  for (const group of chunks(statements, STATEMENTS_PER_BATCH)) {
    const results = await db.batch([bump(), ...group]);
    total += results.slice(1).reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);
  }
  return total;
}

function withoutContent(article: Article): StoredArticle {
  const stored: Article = { ...article };
  delete stored.content;
  delete stored.contentFetchedAt;
  return stored;
}

function insertStatements(db: Db, userId: string, feedOf: (article: Article) => string, articles: Article[], now: Date) {
  const fetchedAt = now.toISOString();
  return chunks(articles, ROWS_PER_STATEMENT).map(group => {
    const values: string[] = [];
    const binds: string[] = [userId, fetchedAt];
    for (const article of group) {
      const stored = withoutContent(article);
      const n = binds.length;
      values.push(`(?1, ?${n + 1}, ?${n + 2}, ?${n + 3}, ?${n + 4}, ?2, NULL, ${SEQ}, ?${n + 5})`);
      binds.push(stored.id, feedOf(article), stored.url, stored.publishedAt, JSON.stringify(stored));
    }
    return db.prepare(`INSERT OR IGNORE INTO folio_articles (user_id, article_id, feed_id, url, published_at, fetched_at, read_at, updated_seq, payload) VALUES ${values.join(', ')}`).bind(...binds);
  });
}

function readStatements(db: Db, userId: string, articleIds: string[], read: boolean, now: Date) {
  const readAt = read ? now.toISOString() : null;
  return chunks([...new Set(articleIds)], IDS_PER_STATEMENT).map(ids => db.prepare(
    `UPDATE folio_articles SET read_at = ?2, updated_seq = ${SEQ}
     WHERE user_id = ?1 AND article_id IN (${ids.map((_, i) => `?${i + 3}`).join(',')}) AND read_at IS ${read ? '' : 'NOT '}NULL`,
  ).bind(userId, readAt, ...ids));
}

export async function insertArticles(db: Db, userId: string, feedId: string, articles: Article[], now: Date) {
  return runInBatches(db, userId, insertStatements(db, userId, () => feedId, articles, now));
}

const encodeCursor = (seq: number, articleId: string) => `${seq}:${encodeURIComponent(articleId)}`;
function decodeCursor(cursor: string | null): [number, string] {
  if (!cursor) return [0, ''];
  const match = /^(\d{1,15}):([\s\S]*)$/.exec(cursor);
  if (!match) throw new BacklogInputError('cursorが正しくありません。');
  try { return [Number(match[1]), decodeURIComponent(match[2])]; } catch { throw new BacklogInputError('cursorが正しくありません。'); }
}

type Row = { article_id: string; feed_id: string; fetched_at: string; read_at: string | null; updated_seq: number; payload: string };

export async function listChanges(db: Db, userId: string, cursor: string | null, limit = MAX_CHANGES_PAGE) {
  const [seq, id] = decodeCursor(cursor);
  const size = Math.min(Math.max(Math.floor(limit) || 1, 1), MAX_CHANGES_PAGE);
  const { results } = await db.prepare(
    `SELECT article_id, feed_id, fetched_at, read_at, updated_seq, payload FROM folio_articles
     WHERE user_id = ? AND (updated_seq > ? OR (updated_seq = ? AND article_id > ?))
     ORDER BY updated_seq, article_id LIMIT ?`,
  ).bind(userId, seq, seq, id, size + 1).all<Row>();
  const page = results.slice(0, size);
  const last = page[page.length - 1];
  return {
    entries: page.map((row): BacklogEntry => ({ article: JSON.parse(row.payload) as StoredArticle, feedId: row.feed_id, fetchedAt: row.fetched_at, readAt: row.read_at })),
    next: last ? encodeCursor(last.updated_seq, last.article_id) : encodeCursor(seq, id),
    hasMore: results.length > size,
  };
}

export async function setRead(db: Db, userId: string, articleIds: string[], read: boolean, now: Date) {
  if (articleIds.length > MAX_READ_BATCH) throw new BacklogInputError(`一度に更新できるのは${MAX_READ_BATCH}件までです。`);
  return runInBatches(db, userId, readStatements(db, userId, articleIds, read, now));
}

export async function importArticles(db: Db, userId: string, articles: Article[], readIds: string[], now: Date) {
  if (articles.length > MAX_IMPORT || readIds.length > MAX_IMPORT) throw new BacklogInputError(`一度に取り込めるのは記事・既読ともに${MAX_IMPORT}件までです。`);
  const inserted = await runInBatches(db, userId, insertStatements(db, userId, article => article.sourceId, articles, now));
  const markedRead = await runInBatches(db, userId, readStatements(db, userId, readIds, true, now));
  return { inserted, markedRead };
}

export async function purgeExpired(db: Db, now: Date, limit = 5000) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString();
  const result = await db.prepare(
    'DELETE FROM folio_articles WHERE rowid IN (SELECT rowid FROM folio_articles WHERE fetched_at < ? LIMIT ?)',
  ).bind(cutoff, limit).run();
  return result.meta.changes;
}
