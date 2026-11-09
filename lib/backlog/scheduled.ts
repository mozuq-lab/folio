import { fetchFeedConditional, feedErrorKind, type FeedErrorKind } from '../feeds.ts';
import { pickFeedsToFetch, recordFeedResult, type FeedTarget } from './schedule.ts';
import { insertArticles, purgeExpired } from './store.ts';

type Db = Pick<D1Database, 'prepare' | 'batch'>;
export type ScheduledSummary = { fetched: number; inserted: number; failed: number; purged: number };

export function parseAllowedEmails(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean));
}

// 期限切れ削除は1日1回、UTC 03:00〜03:04の実行（5分間隔のうち1回）だけで行う。
const isPurgeWindow = (now: Date) => now.getUTCHours() === 3 && now.getUTCMinutes() < 5;

// 1フィードを取得して結果を記録する。304ではETag等をそのまま保つ。失敗は種類だけを返し、記録できなくても投げない。
export async function fetchTarget(db: Db, target: FeedTarget, now: Date, fetcher?: typeof fetch): Promise<{ inserted: number; error?: FeedErrorKind }> {
  let inserted = 0;
  try {
    const result = await fetchFeedConditional(target.url, { etag: target.etag, lastModified: target.lastModified, fetcher });
    if (result.status === 'ok') {
      inserted = await insertArticles(db, target.userId, target.feedId, result.feed.articles, now);
      await recordFeedResult(db, target.userId, target.feedId, now, { ok: true, etag: result.etag, lastModified: result.lastModified });
    } else {
      await recordFeedResult(db, target.userId, target.feedId, now, { ok: true, etag: target.etag, lastModified: target.lastModified });
    }
    return { inserted };
  } catch (error) {
    const kind = feedErrorKind(error);
    try { await recordFeedResult(db, target.userId, target.feedId, now, { ok: false, error: kind }); } catch { /* 呼び出し側は続ける */ }
    return { inserted: 0, error: kind };
  }
}

// 選ばれた1〜2件を順に処理する。同期文書は読まない（無料プランのCPU上限のため）。
export async function runScheduledFetch(deps: { db: Db; now: Date; allowedEmails: Set<string>; fetcher?: typeof fetch }): Promise<ScheduledSummary> {
  const { db, now, allowedEmails, fetcher } = deps;
  const summary: ScheduledSummary = { fetched: 0, inserted: 0, failed: 0, purged: 0 };
  for (const target of await pickFeedsToFetch(db, now, allowedEmails)) {
    const outcome = await fetchTarget(db, target, now, fetcher);
    if (outcome.error) summary.failed++;
    else { summary.fetched++; summary.inserted += outcome.inserted; }
  }
  if (isPurgeWindow(now)) summary.purged = await purgeExpired(db, now);
  return summary;
}
