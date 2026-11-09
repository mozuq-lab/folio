import type { Article, ReaderState } from '../types.ts';
import type { IntelligenceState } from '../intelligence-types.ts';
import { retainedArticleIds } from '../retention.ts';

/** 未移行で、保持対象外の記事か既読が端末に残っている。 */
export function needsBacklogMigration(reader: ReaderState): boolean {
  if (reader.backlogMigratedAt) return false;
  return reader.articles.length > 0 || reader.read.length > 0;
}

/** バックログへ送る内容。サンプル記事は送らない。1000件ごとの分割は呼び出し側で行う。 */
export function migrationPayload(reader: ReaderState, _intelligence: IntelligenceState): { articles: Article[]; read: string[] } {
  const articles = reader.articles.filter((a) => !a.isSample);
  const ids = new Set(articles.map((a) => a.id));
  return { articles, read: reader.read.filter((id) => ids.has(id)) };
}

/** 保持対象の記事とその既読だけを残す。保持対象でないサンプル記事も落とす。 */
export function trimToRetained(reader: ReaderState, intelligence: IntelligenceState, now: Date): ReaderState {
  const keep = new Set(retainedArticleIds(reader, intelligence));
  const articles = reader.articles.filter((a) => keep.has(a.id));
  const kept = new Set(articles.map((a) => a.id));
  return { ...reader, articles, read: reader.read.filter((id) => kept.has(id)), backlogMigratedAt: now.toISOString() };
}

/** 保持対象にした記事の本体を同期データへ写す。既にあれば同じ状態を返す。 */
export function retainArticle(reader: ReaderState, article: Article): ReaderState {
  if (reader.articles.some((a) => a.id === article.id)) return reader;
  return { ...reader, articles: [...reader.articles, article] };
}
