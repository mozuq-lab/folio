import type { Feed } from './types.ts';

/** ページに書かれていたフィードの候補。title は文字として表示するだけで、HTMLとしては扱わない。 */
export type FeedCandidate = { url: string; title: string };

/** 画面で扱う GET /api/feeds の結果。 */
export type FeedAddResult =
  | { kind: 'feed'; feed: Feed }
  | { kind: 'candidates'; page: string; candidates: FeedCandidate[] }
  | { kind: 'error'; message: string };

const FALLBACK_ERROR = 'フィードを追加できませんでした。';

/** 追加の問い合わせ先。候補から選んだURLは discover=0 を付け、サーバーがページとして探し直さないようにする。 */
export function feedLookupPath(url: string, discover = true): string {
  return `/api/feeds?url=${encodeURIComponent(url)}${discover ? '' : '&discover=0'}`;
}

/** 今の追加処理と同じく、URLが完全に一致するフィードを購読済みとみなす。 */
export function isSubscribed(feeds: readonly Pick<Feed, 'url'>[], url: string): boolean {
  return feeds.some(feed => feed.url === url);
}

/** GET /api/feeds の応答を画面で使う形に直す。形が違うものは失敗として扱う。 */
export function parseFeedAddResponse(ok: boolean, body: unknown): FeedAddResult {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (!ok) return { kind: 'error', message: typeof value.error === 'string' && value.error ? value.error : FALLBACK_ERROR };
  if (Array.isArray(value.candidates)) {
    const candidates = value.candidates.flatMap(item => {
      const candidate = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return typeof candidate.url === 'string' && typeof candidate.title === 'string' ? [{ url: candidate.url, title: candidate.title }] : [];
    });
    return candidates.length ? { kind: 'candidates', page: typeof value.page === 'string' ? value.page : '', candidates } : { kind: 'error', message: FALLBACK_ERROR };
  }
  const feed = value.feed && typeof value.feed === 'object' ? value.feed as Feed : null;
  return feed && typeof feed.id === 'string' && typeof feed.url === 'string' && typeof feed.name === 'string' ? { kind: 'feed', feed } : { kind: 'error', message: FALLBACK_ERROR };
}
