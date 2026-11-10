import { isSafeFeedUrl } from './feeds.ts';
import { HTML_HEAD_BYTES, headLinks } from './html-head.ts';
import { BodyTooLargeError, readLimitedBytes, readPrefixBytes } from './http.ts';

/** Cache API（caches.default）のうち使う部分。テストでは差し替える。 */
export type FaviconCache = { match(key: Request): Promise<Response | undefined>; put(key: Request, response: Response): Promise<void> };

const MAX_ICON_BYTES = 100 * 1024;
const TIMEOUT_MS = 5000;
const FOUND_SECONDS = 7 * 86400;
const MISSING_SECONDS = 86400;
const SAFE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" };

/** 配信元の一時的な失敗（5xx）。「ファビコンが無い」とは区別し、キャッシュしない。 */
class TransientError extends Error {}

// 先頭のバイトで画像の種類を決める。SVGは中にスクリプトを書けるので扱わない。
function imageType(bytes: Uint8Array): string | null {
  const starts = (...values: number[]) => values.every((value, i) => bytes[i] === value);
  if (starts(0, 0, 1, 0)) return 'image/x-icon';
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

/** 安全な公開HTTPSのURLだけをたどる（転送は3回まで）。たどれなければ null。 */
async function fetchSafe(url: string, fetcher: typeof fetch, signal: AbortSignal): Promise<{ response: Response; url: string } | null> {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isSafeFeedUrl(current)) return null;
    const response = await fetcher(current, { redirect: 'manual', signal, headers: { Accept: 'image/*,text/html;q=0.8,*/*;q=0.1' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) return null;
      try { current = new URL(location, current).href; } catch { return null; }
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); if (response.status >= 500) throw new TransientError(); return null; }
    return { response, url: current };
  }
  return null;
}

async function fetchIcon(url: string, fetcher: typeof fetch, signal: AbortSignal): Promise<{ bytes: Uint8Array; type: string } | null> {
  const fetched = await fetchSafe(url, fetcher, signal);
  if (!fetched) return null;
  try {
    const bytes = await readLimitedBytes(fetched.response.body, fetched.response.headers.get('content-length'), MAX_ICON_BYTES);
    const type = imageType(bytes);
    return type ? { bytes, type } : null;
  } catch (error) {
    if (error instanceof BodyTooLargeError) return null;
    throw error;
  }
}

/** トップページの <head> から <link rel="...icon..." href="..."> を探す。icon と apple-touch-icon を分けて返す。 */
async function iconLinks(site: string, fetcher: typeof fetch, signal: AbortSignal): Promise<{ icons: string[]; touch: string[] }> {
  const fetched = await fetchSafe(`${site}/`, fetcher, signal);
  if (!fetched) return { icons: [], touch: [] };
  const html = new TextDecoder().decode(await readPrefixBytes(fetched.response.body, HTML_HEAD_BYTES));
  const links: { href: string; touch: boolean }[] = [];
  for (const link of headLinks(html)) {
    const rel = link.get('rel')?.toLowerCase() ?? '';
    const value = link.get('href')?.trim();
    if (!value || !/(?:^|\s)(?:icon|shortcut icon|apple-touch-icon)(?:\s|$)/.test(rel) || /\.svg(?:[?#]|$)/i.test(value)) continue;
    try { links.push({ href: new URL(value, fetched.url).href, touch: rel.includes('apple-touch-icon') }); } catch { /* 読めないURLは飛ばす */ }
  }
  return { icons: links.filter(link => !link.touch).map(link => link.href).slice(0, 2), touch: links.filter(link => link.touch).map(link => link.href).slice(0, 1) };
}

const missing = () => new Response(null, { status: 404, headers: { ...SAFE_HEADERS, 'Cache-Control': `private, max-age=${MISSING_SECONDS}` } });
const iconResponse = (bytes: Uint8Array, type: string, cacheControl: string) => new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { ...SAFE_HEADERS, 'Content-Type': type, 'Cache-Control': cacheControl } });

/**
 * GET /api/favicon?site=https://example.com のファビコンを返す。トップページのアイコン指定、/favicon.ico、apple-touch-icon の順に使う。
 * 見つからなければ404。Cache APIには利用者に関係なくサイトごとに保存する（見つからなかったことも1日保存する）。
 * 一時的な失敗は保存しない。Cache APIは workers.dev では効かず、そのときはブラウザーのキャッシュだけになる。
 */
export async function handleFavicon(request: Request, options: { fetcher?: typeof fetch; cache?: FaviconCache } = {}): Promise<Response> {
  const raw = new URL(request.url).searchParams.get('site') ?? '';
  let site: string;
  try {
    const url = new URL(raw);
    if (url.origin !== raw.replace(/\/$/, '') || !isSafeFeedUrl(url.origin)) throw new Error('unsafe');
    site = url.origin;
  } catch {
    return new Response(null, { status: 400, headers: { ...SAFE_HEADERS, 'Cache-Control': 'no-store' } });
  }
  // 探し方を変えたら版を上げ、前の探し方で保存したものを使わないようにする。
  const key = new Request(`https://favicon.folio.invalid/v2/${encodeURIComponent(site)}`);
  const cached = await options.cache?.match(key).catch(() => undefined);
  if (cached) {
    if (cached.status !== 200) { await cached.body?.cancel(); return missing(); }
    return iconResponse(new Uint8Array(await cached.arrayBuffer()), cached.headers.get('content-type') ?? 'image/x-icon', `private, max-age=${FOUND_SECONDS}`);
  }
  const fetcher = options.fetcher ?? fetch;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let icon: { bytes: Uint8Array; type: string } | null = null;
  // 5xxは次の候補を試し続けるが、最後まで見つからなければ「無い」とは決めずに保存しない。
  let transient = false;
  const tolerate = async <T,>(step: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await step(); } catch (error) { if (error instanceof TransientError) { transient = true; return fallback; } throw error; }
  };
  try {
    // ページで指定されたアイコンを先に使う（/favicon.ico は中身が空の小さな画像のサイトがある）。
    const links = await tolerate(() => iconLinks(site, fetcher, signal), { icons: [], touch: [] });
    for (const href of [...links.icons, `${site}/favicon.ico`, ...links.touch]) if ((icon = await tolerate(() => fetchIcon(href, fetcher, signal), null))) break;
    if (!icon && transient) throw new TransientError();
  } catch {
    // 時間切れ・接続できない・5xxは一時的な失敗かもしれないので、「無い」として保存しない。
    return new Response(null, { status: 404, headers: { ...SAFE_HEADERS, 'Cache-Control': 'no-store' } });
  }
  const store = icon ? iconResponse(icon.bytes, icon.type, `public, max-age=${FOUND_SECONDS}`) : new Response(null, { status: 404, headers: { 'Cache-Control': `public, max-age=${MISSING_SECONDS}` } });
  await options.cache?.put(key, store).catch(() => {});
  return icon ? iconResponse(icon.bytes, icon.type, `private, max-age=${FOUND_SECONDS}`) : missing();
}
