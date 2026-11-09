import type { Article } from '../types.ts';

// サーバーと画面の両方が使う型。D1を使うコードを読み込まないよう、型だけを置く。
export type StoredArticle = Omit<Article, 'content' | 'contentFetchedAt'>;
export type BacklogEntry = { article: StoredArticle; feedId: string; fetchedAt: string; readAt: string | null };
