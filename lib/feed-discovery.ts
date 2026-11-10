import { FeedError, fetchFeed, fetchFeedOrPage, isSafeFeedUrl } from './feeds.ts';
import { headLinks } from './html-head.ts';
import type { FeedCandidate } from './feed-add.ts';

type ParsedFeed = Awaited<ReturnType<typeof fetchFeed>>;
/** GET /api/feeds の応答の本文。フィードが決まれば今までどおりの形、候補が2つ以上なら候補の一覧。 */
export type FeedLookup = ParsedFeed | { page: string; candidates: FeedCandidate[] };

export const MAX_CANDIDATES = 10;
export const MAX_CANDIDATE_TITLE = 120;
const FEED_TYPES = new Set(['application/rss+xml', 'application/atom+xml']);
export const NO_FEED_LINK_MESSAGE = 'このページにはRSS / Atomフィードの指定が見つかりませんでした。RSS / AtomのURLを直接入力してください。';

/**
 * ページの <link rel="alternate" type="application/rss+xml|application/atom+xml" href="..."> を候補にする。
 * href は pageUrl（転送後の最終URL）を基準に解決し、公開HTTPSでないものと、ページ自身を指すものは捨てる。
 */
export function findFeedLinks(html: string, pageUrl: string): FeedCandidate[] {
  const candidates: FeedCandidate[] = [];
  const page = new URL(pageUrl);
  page.hash = '';
  const seen = new Set<string>([page.href]);
  for (const link of headLinks(html)) {
    const rel = (link.get('rel') ?? '').toLowerCase().split(/[\t\n\f\r ]+/);
    const type = (link.get('type') ?? '').split(';')[0].trim().toLowerCase();
    const href = link.get('href')?.trim();
    if (!rel.includes('alternate') || !FEED_TYPES.has(type) || !href) continue;
    let url: string;
    try {
      const resolved = new URL(href, pageUrl);
      resolved.hash = '';
      url = resolved.href;
    } catch { continue; }
    if (seen.has(url) || !isSafeFeedUrl(url)) continue;
    seen.add(url);
    const title = Array.from((link.get('title') ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, MAX_CANDIDATE_TITLE).join('');
    candidates.push({ url, title });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}

/**
 * フィードの追加で入力されたURLを調べる。フィードならそのまま返す。HTMLページなら、同じ応答の先頭からフィードの指定を探す。
 * 候補が1つならそのフィードを取得して返し（購読するURLは見つけたフィードのURL）、2つ以上なら候補を返す。0なら失敗にする。
 * discover が false のとき（候補から選んだURL）はページを探さず、HTMLなら今までどおり失敗にする。
 */
export async function lookupFeed(url: string, options: { discover?: boolean; fetcher?: typeof fetch } = {}): Promise<FeedLookup> {
  const fetcher = options.fetcher ?? fetch;
  if (options.discover === false) return fetchFeed(url, fetcher);
  const result = await fetchFeedOrPage(url, fetcher);
  if (result.status === 'ok') return result.feed;
  const candidates = findFeedLinks(result.html, result.url);
  if (!candidates.length) throw new FeedError(NO_FEED_LINK_MESSAGE);
  if (candidates.length === 1) return fetchFeed(candidates[0].url, fetcher);
  return { page: result.url, candidates };
}
