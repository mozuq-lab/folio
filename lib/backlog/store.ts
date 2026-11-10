import type { Article } from '../types.ts';
import { EXPIRED_MARK_DAYS, MAX_CHANGES_PAGE, MAX_READ_BATCH, RETENTION_DAYS } from './constants.ts';
import type { BacklogEntry, StoredArticle } from './types.ts';
export type { BacklogEntry, StoredArticle } from './types.ts';

type Db = Pick<D1Database, 'prepare' | 'batch'>;
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
      values.push(`(?${n + 1}, ?${n + 2}, ?${n + 3}, ?${n + 4}, ?${n + 5})`);
      binds.push(stored.id, feedOf(article), stored.url, stored.publishedAt, JSON.stringify(stored));
    }
    // 期限切れで消した記事（folio_expired に印がある記事。IDかURLが同じもの）は入れ直さない。
    // VALUES の列は column1（記事ID）〜 column5（payload）。
    return db.prepare(
      `INSERT OR IGNORE INTO folio_articles (user_id, article_id, feed_id, url, published_at, fetched_at, read_at, updated_seq, payload)
       SELECT ?1, v.column1, v.column2, v.column3, v.column4, ?2, NULL, ${SEQ}, v.column5 FROM (VALUES ${values.join(', ')}) AS v
       WHERE NOT EXISTS (SELECT 1 FROM folio_expired e WHERE e.user_id = ?1 AND e.article_id = v.column1)
         AND NOT EXISTS (SELECT 1 FROM folio_expired e WHERE e.user_id = ?1 AND e.url = v.column3)`,
    ).bind(...binds);
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

/** 差分の1ページ。payload は保存したJSON文字列のまま返す（応答に埋め込めば解析せずに済む）。 */
export async function listChangeRows(db: Db, userId: string, cursor: string | null, limit = MAX_CHANGES_PAGE) {
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
    rows: page.map(row => ({ payload: row.payload, feedId: row.feed_id, fetchedAt: row.fetched_at, readAt: row.read_at })),
    next: last ? encodeCursor(last.updated_seq, last.article_id) : encodeCursor(seq, id),
    hasMore: results.length > size,
  };
}

export async function listChanges(db: Db, userId: string, cursor: string | null, limit = MAX_CHANGES_PAGE) {
  const { rows, next, hasMore } = await listChangeRows(db, userId, cursor, limit);
  return { entries: rows.map(({ payload, ...rest }): BacklogEntry => ({ article: JSON.parse(payload) as StoredArticle, ...rest })), next, hasMore };
}

export async function setRead(db: Db, userId: string, articleIds: string[], read: boolean, now: Date) {
  if (articleIds.length > MAX_READ_BATCH) throw new BacklogInputError(`一度に更新できるのは${MAX_READ_BATCH}件までです。`);
  return runInBatches(db, userId, readStatements(db, userId, articleIds, read, now));
}

// 取り込みの既読。同じURLの記事が別IDで既にあれば（定期取得が先に入れた行など）その行も既読にする。
// 1文にIDとURLを合わせて90個まで（＋利用者・時刻）。
function importReadStatements(db: Db, userId: string, articles: Article[], readIds: string[], now: Date) {
  const urlOf = new Map(articles.map(article => [article.id, article.url]));
  return chunks([...new Set(readIds)], IDS_PER_STATEMENT / 2).map(ids => {
    const urls = [...new Set(ids.flatMap(id => urlOf.has(id) ? [urlOf.get(id)!] : []))];
    const idList = ids.map((_, i) => `?${i + 3}`).join(',');
    const urlList = urls.map((_, i) => `?${i + 3 + ids.length}`).join(',');
    return db.prepare(
      `UPDATE folio_articles SET read_at = ?2, updated_seq = ${SEQ}
       WHERE user_id = ?1 AND (article_id IN (${idList})${urls.length ? ` OR url IN (${urlList})` : ''}) AND read_at IS NULL`,
    ).bind(userId, now.toISOString(), ...ids, ...urls);
  });
}

export async function importArticles(db: Db, userId: string, articles: Article[], readIds: string[], now: Date) {
  if (articles.length > MAX_IMPORT || readIds.length > MAX_IMPORT) throw new BacklogInputError(`一度に取り込めるのは記事・既読ともに${MAX_IMPORT}件までです。`);
  const inserted = await runInBatches(db, userId, insertStatements(db, userId, article => article.sourceId, articles, now));
  const markedRead = await runInBatches(db, userId, importReadStatements(db, userId, articles, readIds, now));
  return { inserted, markedRead };
}

/**
 * 取得から RETENTION_DAYS 日を過ぎた記事を消す。消す記事のIDとURLは folio_expired に印として残し、
 * フィードに載り続けていても取り込み直さない（未読に戻って一覧に再び出るのを防ぐ）。
 * 印は EXPIRED_MARK_DAYS 日で消す。印を書くことと記事を消すことは1つのbatch（トランザクション）で行う。
 */
export async function purgeExpired(db: Db, now: Date, limit = 5000) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString();
  const markCutoff = new Date(now.getTime() - EXPIRED_MARK_DAYS * 86400000).toISOString();
  // 印を書く行と消す行が同じになるよう、どちらも rowid の順で同じ件数を選ぶ。
  const expiring = 'SELECT rowid FROM folio_articles WHERE fetched_at < ?1 ORDER BY rowid LIMIT ?2';
  const [, deleted] = await db.batch([
    db.prepare(
      `INSERT INTO folio_expired (user_id, article_id, url, expired_at)
       SELECT user_id, article_id, url, ?3 FROM folio_articles WHERE rowid IN (${expiring})
       ON CONFLICT (user_id, article_id) DO UPDATE SET url = excluded.url, expired_at = excluded.expired_at`,
    ).bind(cutoff, limit, now.toISOString()),
    db.prepare(`DELETE FROM folio_articles WHERE rowid IN (${expiring})`).bind(cutoff, limit),
    db.prepare('DELETE FROM folio_expired WHERE rowid IN (SELECT rowid FROM folio_expired WHERE expired_at < ?1 LIMIT ?2)').bind(markCutoff, limit),
  ]);
  return deleted.meta?.changes ?? 0;
}
