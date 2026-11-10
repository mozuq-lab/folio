import { ANALYZE_BATCH_SIZE, ANALYZE_MAX_ARTICLES } from './ai/types.ts';
import type { ArticleAnalysis } from './intelligence-types.ts';
import type { Article } from './types.ts';

/** 「AIで選び直す」で保存しておく評価の上限。同期データ（4MiB）を圧迫しないよう抑える。 */
export const MAX_STORED_ANALYSIS = 1000;

/** 見出しだけの記事。概要・本文・画像・URLは送らない（多くの記事を一度に評価するため）。 */
export function headlineOnly(article: Article): Article {
  const { id, title, sourceId, sourceName, publishedAt, tags, readingMinutes } = article;
  return { id, title, description: '', url: '', sourceId, sourceName, publishedAt, tags: [...tags], readingMinutes };
}

/** 評価する記事を、見出しだけにして最大300件・50件ずつに分ける。 */
export function analyzeBatches(articles: Article[]): Article[][] {
  const picked = articles.slice(0, ANALYZE_MAX_ARTICLES).map(headlineOnly);
  return Array.from({ length: Math.ceil(picked.length / ANALYZE_BATCH_SIZE) }, (_, i) => picked.slice(i * ANALYZE_BATCH_SIZE, (i + 1) * ANALYZE_BATCH_SIZE));
}

const compact = (item: ArticleAnalysis): ArticleAnalysis => item.summary.length <= 200 && item.reason.length <= 80 && item.importanceReason.length <= 80 ? item
  : { ...item, summary: item.summary.slice(0, 200), reason: item.reason.slice(0, 80), importanceReason: item.importanceReason.slice(0, 80) };

/**
 * 新しい評価で上書きし、表示中の記事（keepIds）の分だけを上限まで残す。保存は新しい評価が先の順（次の実行でもこの順で読む）。
 * 同期データ（4MiB）を圧迫しないよう、要約は200字・理由は80字までに切り詰める。
 */
export function mergeAnalysis(existing: Record<string, ArticleAnalysis>, incoming: ArticleAnalysis[], keepIds: Set<string>, limit = MAX_STORED_ANALYSIS): Record<string, ArticleAnalysis> {
  const merged = new Map<string, ArticleAnalysis>();
  for (const item of incoming) if (keepIds.has(item.articleId) && !merged.has(item.articleId)) merged.set(item.articleId, compact(item));
  for (const [id, item] of Object.entries(existing)) if (keepIds.has(id) && !merged.has(id)) merged.set(id, compact(item));
  return Object.fromEntries([...merged].slice(0, limit));
}

/** 分けた記事を同時に concurrency 件まで送る。失敗した記事の数と最初のエラー文言を返し、進み具合は終えた記事の数で知らせる。 */
export async function runAnalyzeBatches(
  batches: Article[][],
  send: (batch: Article[]) => Promise<ArticleAnalysis[]>,
  options: { concurrency?: number; onProgress?: (done: number) => void } = {},
): Promise<{ results: ArticleAnalysis[]; failed: number; firstError: string }> {
  const results: ArticleAnalysis[] = [];
  let failed = 0, firstError = '', next = 0, done = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      try { results.push(...await send(batch)); }
      catch (error) { failed += batch.length; firstError ||= error instanceof Error ? error.message : 'AI処理を完了できませんでした。'; }
      done += batch.length;
      options.onProgress?.(done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 2, batches.length) }, worker));
  return { results, failed, firstError };
}
