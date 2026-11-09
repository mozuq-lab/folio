export type ArticleLayout = 'grid' | 'list' | 'compact';

/** Per-device preference stored in localStorage (not synced: phone and desktop often want different layouts). */
export const ARTICLE_LAYOUT_KEY = 'folio.articleLayout';
export const DEFAULT_ARTICLE_LAYOUT: ArticleLayout = 'grid';

export function parseArticleLayout(raw: string | null): ArticleLayout {
  return raw === 'grid' || raw === 'list' || raw === 'compact' ? raw : DEFAULT_ARTICLE_LAYOUT;
}
