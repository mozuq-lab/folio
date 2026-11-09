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

/** 新しい評価で上書きし、表示中の記事（keepIds）の分だけを、新しい評価から順に上限まで残す。 */
export function mergeAnalysis(existing: Record<string, ArticleAnalysis>, incoming: ArticleAnalysis[], keepIds: Set<string>, limit = MAX_STORED_ANALYSIS): Record<string, ArticleAnalysis> {
  const merged = new Map<string, ArticleAnalysis>();
  for (const item of incoming) if (keepIds.has(item.articleId) && !merged.has(item.articleId)) merged.set(item.articleId, item);
  for (const [id, item] of Object.entries(existing).reverse()) if (keepIds.has(id) && !merged.has(id)) merged.set(id, item);
  return Object.fromEntries([...merged].slice(0, limit));
}
