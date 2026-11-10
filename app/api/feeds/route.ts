import { getCurrentUser } from '../../../lib/auth/context.ts';
import { FeedError, isSafeFeedUrl } from '../../../lib/feeds.ts';
import { lookupFeed, type FeedLookup } from '../../../lib/feed-discovery.ts';
import { NO_STORE_HEADERS, isSameOrigin } from '../../../lib/http.ts';

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; result: FeedLookup }>();

/**
 * GET /api/feeds?url=… はフィードを返す。discover=1 が付いていて url がサイトのページなら、ページに書かれたフィードを探す（lib/feed-discovery.ts）。
 * 候補が2つ以上なら { page, candidates } を返す。候補から選んだURLは discover を付けずに送り、ページとしては探さない。
 */
export async function GET(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return Response.json({ error: '同じサイトからRSSを追加してください。' }, { status: 403, headers: NO_STORE_HEADERS });
  }
  if (!getCurrentUser()) return Response.json({ error: 'RSSの取得にはログインが必要です。' }, { status: 401, headers: NO_STORE_HEADERS });
  const requestUrl = new URL(request.url);
  const rawUrl = requestUrl.searchParams.get('url')?.trim() ?? '';
  if (!isSafeFeedUrl(rawUrl)) return Response.json({ error: '公開されたURL（http:// または https://）を入力してください。' }, { status: 400 });
  // ページを探すのは discover=1 を付けたときだけ。付けない要求（候補から選んだURLと、配置の前から開いている古い画面）には今までどおりの形で返す。
  const discover = requestUrl.searchParams.get('discover') === '1';
  const url = new URL(rawUrl);
  url.hash = '';
  const cacheKey = `${discover ? 'discover' : 'feed'} ${url.href}`;
  const cached = cache.get(cacheKey);
  const headers = { 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' };
  if (cached && cached.expiresAt > Date.now()) return Response.json(cached.result, { headers });
  try {
    const result = await lookupFeed(url.href, { discover });
    // Bound memory in long-lived development and edge processes.
    for (const [key, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(key);
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL, result });
    return Response.json(result, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof FeedError ? error.message : 'RSSを取得できませんでした。もう一度お試しください。' }, {
      status: error instanceof FeedError ? error.status : 500,
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }
}
