import { RETENTION_DAYS } from './backlog/constants.ts';
import type { Article, ReaderState } from './types.ts';

// 「あとで読む」に入れたことのある記事の記録と、フィードごとの集計。どれも純粋関数。
// 同期データの saved は今保存している記事だけなので、解除した記事も数えられるように記録を別に持つ。

/** 記録の上限。超えた分は古いものから捨てる（同期データを太らせない）。 */
export const MAX_EVER_SAVED = 3000;
// 数えるのは端末にためている記事（取得から RETENTION_DAYS 日）だけなので、それより古い記録は使わない。
// 端末の記事が消えるのが少し遅れても数え落とさないよう、余裕を持たせて残す。
const KEEP_DAYS = RETENTION_DAYS + 7;

export type FeedStat = { arrived: number; saved: number };

/**
 * 記事を「あとで読む」に入れたことを記録する。保存するときと解除するときの両方で呼ぶ
 * （この記録が無いころに保存した記事も、解除したときに残せる）。
 * 記事ごとに1件で、すでにあれば同じ reader を返す。足すときに、古い記録と上限を超えた分を捨てる。
 */
export function recordEverSaved(reader: ReaderState, articleId: string, now: Date): ReaderState {
  const current = reader.everSaved ?? [];
  if (current.some(entry => entry.id === articleId)) return reader;
  const cutoff = now.getTime() - KEEP_DAYS * 86400000;
  const kept = current.filter(entry => Date.parse(entry.at) >= cutoff);
  kept.push({ id: articleId, at: now.toISOString() });
  return { ...reader, everSaved: kept.slice(-MAX_EVER_SAVED) };
}

/**
 * フィードごとに、端末にためている記事の数（arrived）と、そのうち「あとで読む」に入れたことのある記事の数（saved）を数える。
 * saved は今保存している記事と記録にある記事の和で、同じ記事は1回だけ数える。
 */
export function feedStats(backlog: readonly Article[], reader: Pick<ReaderState, 'saved' | 'everSaved'>): Map<string, FeedStat> {
  const saved = new Set(reader.saved);
  for (const entry of reader.everSaved ?? []) saved.add(entry.id);
  const seen = new Set<string>();
  const stats = new Map<string, FeedStat>();
  for (const article of backlog) {
    if (seen.has(article.id)) continue;
    seen.add(article.id);
    let stat = stats.get(article.sourceId);
    if (!stat) stats.set(article.sourceId, stat = { arrived: 0, saved: 0 });
    stat.arrived++;
    if (saved.has(article.id)) stat.saved++;
  }
  return stats;
}

/** フィードの管理に出す1行。 */
export function formatFeedStat(stat: FeedStat | undefined): string {
  return `届いた記事 ${stat?.arrived ?? 0}件・うち保存 ${stat?.saved ?? 0}件`;
}
