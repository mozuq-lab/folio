import { isSafeFeedUrl } from './feeds.ts';
import { BodyTooLargeError, readLimitedBytes } from './http.ts';

/** Cache API（caches.default）のうち使う部分。テストでは差し替える。 */
export type FaviconCache = { match(key: Request): Promise<Response | undefined>; put(key: Request, response: Response): Promise<void> };

const MAX_ICON_BYTES = 100 * 1024;
const MAX_HTML_BYTES = 256 * 1024;
const TIMEOUT_MS = 5000;
const FOUND_SECONDS = 7 * 86400;
const MISSING_SECONDS = 86400;
const SAFE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" };

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
    if (!response.ok) { await response.body?.cancel(); return null; }
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

/** トップページの <head> から <link rel="...icon..." href="..."> を探す。apple-touch-icon は後回し。 */
async function iconLinks(site: string, fetcher: typeof fetch, signal: AbortSignal): Promise<string[]> {
  const fetched = await fetchSafe(`${site}/`, fetcher, signal);
  if (!fetched) return [];
  let html: string;
  try {
    html = new TextDecoder().decode(await readLimitedBytes(fetched.response.body, null, MAX_HTML_BYTES));
  } catch (error) {
    if (error instanceof BodyTooLargeError) return [];
    throw error;
  }
  const head = html.slice(0, Math.max(0, html.search(/<\/head>/i)) || html.length);
  const links: { href: string; touch: boolean }[] = [];
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1].toLowerCase() ?? '';
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!value || !/(?:^|\s)(?:icon|shortcut icon|apple-touch-icon)(?:\s|$)/.test(rel) || /\.svg(?:[?#]|$)/i.test(value)) continue;
    try { links.push({ href: new URL(value, fetched.url).href, touch: rel.includes('apple-touch-icon') }); } catch { /* 読めないURLは飛ばす */ }
  }
  return [...links.filter(link => !link.touch), ...links.filter(link => link.touch)].map(link => link.href).slice(0, 3);
}

const missing = () => new Response(null, { status: 404, headers: { ...SAFE_HEADERS, 'Cache-Control': `private, max-age=${MISSING_SECONDS}` } });
const iconResponse = (bytes: Uint8Array, type: string, cacheControl: string) => new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { ...SAFE_HEADERS, 'Content-Type': type, 'Cache-Control': cacheControl } });

/**
 * GET /api/favicon?site=https://example.com のファビコンを返す。/favicon.ico、無ければトップページのアイコン指定を使う。
 * 見つからなければ404。Cache APIには利用者に関係なくサイトごとに保存する（見つからなかったことも1日保存する）。
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
  const key = new Request(`https://favicon.folio.invalid/${encodeURIComponent(site)}`);
  const cached = await options.cache?.match(key).catch(() => undefined);
  if (cached) {
    if (cached.status !== 200) { await cached.body?.cancel(); return missing(); }
    return iconResponse(new Uint8Array(await cached.arrayBuffer()), cached.headers.get('content-type') ?? 'image/x-icon', `private, max-age=${FOUND_SECONDS}`);
  }
  const fetcher = options.fetcher ?? fetch;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let icon: { bytes: Uint8Array; type: string } | null = null;
  try {
    icon = await fetchIcon(`${site}/favicon.ico`, fetcher, signal);
    if (!icon) for (const href of await iconLinks(site, fetcher, signal)) if ((icon = await fetchIcon(href, fetcher, signal))) break;
  } catch { icon = null; }
  const store = icon ? iconResponse(icon.bytes, icon.type, `public, max-age=${FOUND_SECONDS}`) : new Response(null, { status: 404, headers: { 'Cache-Control': `public, max-age=${MISSING_SECONDS}` } });
  await options.cache?.put(key, store).catch(() => {});
  return icon ? iconResponse(icon.bytes, icon.type, `private, max-age=${FOUND_SECONDS}`) : missing();
}
