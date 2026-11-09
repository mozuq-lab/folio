import type { Feed } from '../types.ts';
import { MAX_PRIORITY_FEEDS, RETENTION_DAYS } from './constants.ts';

type Db = Pick<D1Database, 'prepare' | 'batch'>;
export type FeedTarget = { userId: string; feedId: string; url: string; etag: string | null; lastModified: string | null; priority: boolean };
export type FeedResult = { ok: true; etag: string | null; lastModified: string | null } | { ok: false; error: 'network' | 'http' | 'format' | 'timeout' };

// D1は1文あたりのバインド数が100まで。1回のbatchに入れる文の数も抑える。
const IDS_PER_STATEMENT = 90;
const FEEDS_PER_STATEMENT = 24; // 1件4バインド + 利用者ID
const STATEMENTS_PER_BATCH = 50;
const TOUCH_INTERVAL_MS = 3600000;

const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

const uniqueFeeds = (feeds: Feed[]) => [...new Map(feeds.map(feed => [feed.id, feed] as const).reverse()).values()].reverse();

// 保存済みの行と同じ内容（id・URL・名前・優先）なら書き込まない。同期文書の保存のたびに全行を書き直さないための比較。
// 読み取りは1回だけで、渡された購読一覧以外は読まない。
export async function syncFeedListIfChanged(db: Db, userId: string, feeds: Feed[]): Promise<boolean> {
  const unique = uniqueFeeds(feeds);
  const { results } = await db.prepare('SELECT feed_id, url, name, priority FROM folio_feeds WHERE user_id = ?').bind(userId).all<{ feed_id: string; url: string; name: string; priority: number }>();
  const stored = new Map(results.map(row => [row.feed_id, row] as const));
  let used = 0;
  const same = stored.size === unique.length && unique.every(feed => {
    const priority = feed.priority && used++ < MAX_PRIORITY_FEEDS ? 1 : 0;
    const row = stored.get(feed.id);
    return row !== undefined && row.url === feed.url && row.name === feed.name && row.priority === priority;
  });
  if (same) return false;
  await syncFeedList(db, userId, feeds);
  return true;
}

// 購読一覧をD1へ写す。優先は購読順の先頭 MAX_PRIORITY_FEEDS 件まで。
// 読み取り1回と、書き込みのbatchを文の数に応じて数回だけ使う（500件でもbatchは1〜2回）。
export async function syncFeedList(db: Db, userId: string, feeds: Feed[]): Promise<void> {
  const unique = uniqueFeeds(feeds);
  const keep = new Set(unique.map(feed => feed.id));
  const { results } = await db.prepare('SELECT feed_id FROM folio_feeds WHERE user_id = ?').bind(userId).all<{ feed_id: string }>();
  const removed = results.map(row => row.feed_id).filter(id => !keep.has(id));
  const statements: D1PreparedStatement[] = [];
  let used = 0;
  for (const group of chunks(unique, FEEDS_PER_STATEMENT)) {
    const binds: (string | number)[] = [userId];
    const values = group.map(feed => {
      const n = binds.length;
      binds.push(feed.id, feed.url, feed.name, feed.priority && used++ < MAX_PRIORITY_FEEDS ? 1 : 0);
      return `(?1, ?${n + 1}, ?${n + 2}, ?${n + 3}, ?${n + 4})`;
    });
    statements.push(db.prepare(
      `INSERT INTO folio_feeds (user_id, feed_id, url, name, priority) VALUES ${values.join(', ')}
       ON CONFLICT(user_id, feed_id) DO UPDATE SET url = excluded.url, name = excluded.name, priority = excluded.priority`,
    ).bind(...binds));
  }
  for (const ids of chunks(removed, IDS_PER_STATEMENT)) for (const table of ['folio_feeds', 'folio_feed_state']) {
    statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id = ?1 AND feed_id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`).bind(userId, ...ids));
  }
  for (const group of chunks(statements, STATEMENTS_PER_BATCH)) await db.batch(group);
}

// 画面を開くたびに書かないよう、last_seen_atの更新は1時間に1回まで。
export async function touchUser(db: Db, userId: string, email: string, now: Date): Promise<void> {
  const threshold = new Date(now.getTime() - TOUCH_INTERVAL_MS).toISOString();
  await db.prepare(
    `INSERT INTO folio_users (user_id, email, last_seen_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, last_seen_at = excluded.last_seen_at
     WHERE folio_users.last_seen_at <= ?4`,
  ).bind(userId, email, now.toISOString(), threshold).run();
}

type TargetRow = { user_id: string; feed_id: string; url: string; etag: string | null; last_modified: string | null; priority: number; last_fetched_at: string | null };
const toTarget = (row: TargetRow): FeedTarget => ({ userId: row.user_id, feedId: row.feed_id, url: row.url, etag: row.etag, lastModified: row.last_modified, priority: row.priority === 1 });
// 未取得（NULL）が先、次に古い順、同値ならfeed_id順。
const order = (a: TargetRow, b: TargetRow) => {
  if ((a.last_fetched_at === null) !== (b.last_fetched_at === null)) return a.last_fetched_at === null ? -1 : 1;
  if (a.last_fetched_at !== b.last_fetched_at) return (a.last_fetched_at ?? '') < (b.last_fetched_at ?? '') ? -1 : 1;
  return a.feed_id < b.feed_id ? -1 : a.feed_id > b.feed_id ? 1 : a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
};

// 同期データは読まない。許可メールの数が多い場合だけ、100バインドの上限に合わせて分けて問い合わせる。
export async function pickFeedsToFetch(db: Db, now: Date, allowedEmails: Set<string>): Promise<FeedTarget[]> {
  const emails = [...new Set([...allowedEmails].map(email => email.trim().toLowerCase()).filter(Boolean))];
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString();
  const groups: [TargetRow[], TargetRow[]] = [[], []];
  for (const group of chunks(emails, IDS_PER_STATEMENT)) {
    const query = (priority: number) => db.prepare(
      `SELECT f.user_id, f.feed_id, f.url, f.priority, s.etag, s.last_modified, s.last_fetched_at
       FROM folio_feeds f
       JOIN folio_users u ON u.user_id = f.user_id
       LEFT JOIN folio_feed_state s ON s.user_id = f.user_id AND s.feed_id = f.feed_id
       WHERE f.priority = ? AND u.last_seen_at >= ? AND lower(u.email) IN (${group.map(() => '?').join(',')})
       ORDER BY s.last_fetched_at IS NOT NULL, s.last_fetched_at, f.feed_id LIMIT 2`,
    ).bind(priority, cutoff, ...group);
    const [normal, priorityRows] = await db.batch([query(0), query(1)]);
    groups[0].push(...(normal.results as TargetRow[]));
    groups[1].push(...(priorityRows.results as TargetRow[]));
  }
  const [normal, priority] = groups.map(rows => rows.sort(order));
  const takeNormal = priority.length === 0 ? 2 : 1;
  const takePriority = normal.length === 0 ? 2 : 1;
  return [...priority.slice(0, takePriority), ...normal.slice(0, takeNormal)].map(toTarget);
}

// 失敗でもlast_fetched_atを進め、同じフィードで取得が詰まらないようにする。
// 購読解除済みのフィードには記録しない。ETag等は受け取ったまま保存する。
export async function recordFeedResult(db: Db, userId: string, feedId: string, now: Date, result: FeedResult): Promise<void> {
  const ok = result.ok;
  await db.prepare(
    `INSERT INTO folio_feed_state (user_id, feed_id, last_fetched_at, etag, last_modified, last_error)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM folio_feeds WHERE user_id = ?1 AND feed_id = ?2)
     ON CONFLICT(user_id, feed_id) DO UPDATE SET
       last_fetched_at = excluded.last_fetched_at, last_error = excluded.last_error,
       etag = CASE WHEN ?7 THEN excluded.etag ELSE folio_feed_state.etag END,
       last_modified = CASE WHEN ?7 THEN excluded.last_modified ELSE folio_feed_state.last_modified END`,
  ).bind(userId, feedId, now.toISOString(), ok ? result.etag : null, ok ? result.lastModified : null, ok ? null : result.error, ok ? 1 : 0).run();
}

export async function listFeedStates(db: Db, userId: string): Promise<{ feedId: string; lastFetchedAt: string | null; lastError: string | null }[]> {
  const { results } = await db.prepare(
    `SELECT f.feed_id, s.last_fetched_at, s.last_error FROM folio_feeds f
     LEFT JOIN folio_feed_state s ON s.user_id = f.user_id AND s.feed_id = f.feed_id
     WHERE f.user_id = ? ORDER BY f.feed_id`,
  ).bind(userId).all<{ feed_id: string; last_fetched_at: string | null; last_error: string | null }>();
  return results.map(row => ({ feedId: row.feed_id, lastFetchedAt: row.last_fetched_at, lastError: row.last_error }));
}

// 即時取得用に、その利用者の購読として登録されているフィード1件だけを引く。
export async function getFeedTarget(db: Db, userId: string, feedId: string): Promise<FeedTarget | null> {
  const row = await db.prepare(
    `SELECT f.user_id, f.feed_id, f.url, f.priority, s.etag, s.last_modified, s.last_fetched_at
     FROM folio_feeds f LEFT JOIN folio_feed_state s ON s.user_id = f.user_id AND s.feed_id = f.feed_id
     WHERE f.user_id = ? AND f.feed_id = ?`,
  ).bind(userId, feedId).first<TargetRow>();
  return row ? toTarget(row) : null;
}
