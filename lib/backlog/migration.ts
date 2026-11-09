import type { Article, ReaderState } from '../types.ts';

/** 未移行で、保持対象外の記事か既読が端末に残っている。 */
export function needsBacklogMigration(reader: ReaderState): boolean {
  if (reader.backlogMigratedAt) return false;
  return reader.articles.length > 0 || reader.read.length > 0;
}

/**
 * バックログへ送る内容。サンプル記事とその既読は送らない。分割は呼び出し側で行う。
 * 本体の無い既読ID（記事を消した後の既読など）も送り、サーバーに同じIDの行があれば既読にする。
 */
export function migrationPayload(reader: ReaderState): { articles: Article[]; read: string[] } {
  const articles = reader.articles.filter((a) => !a.isSample);
  const samples = new Set(reader.articles.filter((a) => a.isSample).map((a) => a.id));
  return { articles, read: reader.read.filter((id) => !samples.has(id)) };
}

/** 同期データの記事に本文が無ければ、端末に保存した本文を入れる。入れるものが無ければ同じ状態を返す。 */
export function attachContent(reader: ReaderState, articleId: string, stored: { content: string; fetchedAt: string }): ReaderState {
  const index = reader.articles.findIndex((a) => a.id === articleId);
  if (index < 0 || reader.articles[index].content) return reader;
  const articles = [...reader.articles];
  articles[index] = { ...articles[index], content: stored.content, contentFetchedAt: stored.fetchedAt };
  return { ...reader, articles };
}

/** 保持対象にした記事の本体を同期データへ写す。既にあれば同じ状態を返す。 */
export function retainArticle(reader: ReaderState, article: Article): ReaderState {
  if (reader.articles.some((a) => a.id === article.id)) return reader;
  return { ...reader, articles: [...reader.articles, article] };
}
