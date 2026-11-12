import { retainArticle } from './backlog/migration.ts';
import type { Article, ReaderState } from './types.ts';

// 「あとで読む」に入れたことのある記事の記録と、フィードごとの集計。どれも純粋関数。
// 同期データの saved は今保存している記事だけなので、解除した記事も数えられるように記録を別に持つ。

/**
 * 記録の上限。超えた分は古いものから捨てる（同期データを太らせない。3,000件で約180KiB）。
 * 日数では捨てない。取得から90日で消えた記事も、フィードに載り続けていれば同じIDで入り直すので、
 * 「古い記録の記事はもう端末に無い」とは言えない。
 * 同期データの検証（lib/cloud-library.ts）も同じ値を使う。値を下げるときは、検証の上限は下げないこと
 * （すでに保存された文書が読めなくなる）。
 */
export const MAX_EVER_SAVED = 3000;

export type FeedStat = { arrived: number; saved: number };

/**
 * 記事を保存したことを記録する。記事ごとに1件で、すでにあれば同じ reader を返す。
 * at は最初に記録した日時（並びは記録した順で、上限を超えたら先頭から捨てる）。
 */
export function recordEverSaved(reader: ReaderState, articleId: string, now: Date): ReaderState {
  const current = reader.everSaved ?? [];
  if (current.some(entry => entry.id === articleId)) return reader;
  return { ...reader, everSaved: [...current, { id: articleId, at: now.toISOString() }].slice(-MAX_EVER_SAVED) };
}

/**
 * 記事を保存する（save が true）か、保存を解除する（false）。
 * 保存するときは記事の本体を同期データへ写す。保存するときも解除するときも記録を残す
 * （記録が無いころに保存した記事も、解除したときに残せる）。
 */
export function setSaved(reader: ReaderState, article: Article, save: boolean, now: Date): ReaderState {
  const next = save
    ? retainArticle(reader.saved.includes(article.id) ? reader : { ...reader, saved: [...reader.saved, article.id] }, article)
    : { ...reader, saved: reader.saved.filter(id => id !== article.id) };
  return recordEverSaved(next, article.id, now);
}

/**
 * フィードごとに、端末にためている記事の数（arrived）と、そのうち保存したことのある記事の数（saved）を数える。
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
