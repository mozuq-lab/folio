import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFavicon, type FaviconCache } from '../lib/favicon.ts';
import { faviconSrc } from '../lib/favicon-src.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]);
const req = (site: string) => new Request(`https://folio.example/api/favicon?site=${encodeURIComponent(site)}`);
type Route = Record<string, () => Response>;
function fetcherOf(routes: Route) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return routes[url]?.() ?? new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls };
}
function memoryCache(): FaviconCache & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return { store, async match(key) { return store.get(key.url)?.clone(); }, async put(key, response) { store.set(key.url, response.clone()); } };
}

test('faviconSrc: サイトのURL（無ければフィードのURL）のオリジンで /api/favicon を指す', () => {
  assert.equal(faviconSrc({ website: 'https://example.com/blog/', url: 'https://feeds.example.net/rss' }), '/api/favicon?site=https%3A%2F%2Fexample.com');
  assert.equal(faviconSrc({ website: 'not a url', url: 'https://feeds.example.net/rss' }), '/api/favicon?site=https%3A%2F%2Ffeeds.example.net');
  assert.equal(faviconSrc({ website: 'http://example.com', url: 'http://x.example/feed' }), null);
});

test('/favicon.ico が画像ならそれを返し、型・キャッシュ・安全のヘッダーを付けてCache APIにも保存する', async () => {
  const { fetcher, calls } = fetcherOf({ 'https://example.com/favicon.ico': () => new Response(ICO, { headers: { 'content-type': 'image/x-icon' } }) });
  const cache = memoryCache();
  const res = await handleFavicon(req('https://example.com'), { fetcher, cache });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/x-icon');
  assert.match(res.headers.get('cache-control') ?? '', /private, max-age=604800/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), ICO);
  assert.deepEqual(calls, ['https://example.com/favicon.ico']);
  // 2回目はCache APIから返し、配信元には行かない。
  const again = await handleFavicon(req('https://example.com'), { fetcher, cache });
  assert.equal(again.status, 200);
  assert.equal(calls.length, 1);
});

test('/favicon.ico が無ければ、トップページの <link rel="icon"> を使う（相対URLも解決する）', async () => {
  const html = '<html><head><link rel="stylesheet" href="/a.css"><link href="/static/icon.png" rel="shortcut icon"></head><body></body></html>';
  const { fetcher, calls } = fetcherOf({
    'https://example.com/': () => new Response(html, { headers: { 'content-type': 'text/html' } }),
    'https://example.com/static/icon.png': () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
  });
  const res = await handleFavicon(req('https://example.com'), { fetcher });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(calls, ['https://example.com/favicon.ico', 'https://example.com/', 'https://example.com/static/icon.png']);
});

test('SVG・HTML・大きすぎる画像は使わず、見つからなければ404（短めにキャッシュ）', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const { fetcher } = fetcherOf({
    'https://example.com/favicon.ico': () => new Response(svg, { headers: { 'content-type': 'image/svg+xml' } }),
    'https://example.com/': () => new Response('<link rel="icon" href="https://example.com/big.png">', { headers: { 'content-type': 'text/html' } }),
    'https://example.com/big.png': () => new Response(new Uint8Array([...PNG, ...new Uint8Array(200 * 1024)]), { headers: { 'content-type': 'image/png' } }),
  });
  const res = await handleFavicon(req('https://example.com'), { fetcher });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('cache-control') ?? '', /max-age=86400/);
});

test('公開されたHTTPSのオリジン以外は400で、配信元には行かない', async () => {
  const { fetcher, calls } = fetcherOf({});
  for (const site of ['http://example.com', 'https://localhost', 'https://10.0.0.1', 'https://example.com/path', 'https://example.com?x=1', 'not a url', '']) {
    assert.equal((await handleFavicon(req(site), { fetcher })).status, 400, site);
  }
  assert.equal((await handleFavicon(new Request('https://folio.example/api/favicon'), { fetcher })).status, 400);
  assert.deepEqual(calls, []);
});

test('安全でないURLへの転送やHTML内のリンクは追わない', async () => {
  const { fetcher, calls } = fetcherOf({
    'https://example.com/favicon.ico': () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/favicon.ico' } }),
    'https://example.com/': () => new Response('<link rel="icon" href="http://example.com/i.png">', { headers: { 'content-type': 'text/html' } }),
  });
  assert.equal((await handleFavicon(req('https://example.com'), { fetcher })).status, 404);
  assert.ok(!calls.some(url => url.includes('127.0.0.1') || url.startsWith('http:')));
});

test('一時的な失敗（時間切れ・5xx・接続できない）は「無い」としてキャッシュしない', async () => {
  const cache = memoryCache();
  const failing = (async () => { throw new TypeError('connection reset'); }) as typeof fetch;
  const res = await handleFavicon(req('https://example.com'), { fetcher: failing, cache });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(cache.store.size, 0);
  const { fetcher } = fetcherOf({ 'https://example.com/favicon.ico': () => new Response('busy', { status: 503 }) });
  assert.equal((await handleFavicon(req('https://example.com'), { fetcher, cache })).headers.get('cache-control'), 'no-store');
  assert.equal(cache.store.size, 0);
});

test('トップページが256KBを超えても、先頭の <head> からアイコンを探す', async () => {
  const html = `<html><head><link rel="icon" href="/i.png"></head><body>${'x'.repeat(400 * 1024)}</body></html>`;
  const { fetcher } = fetcherOf({
    'https://example.com/': () => new Response(html, { headers: { 'content-type': 'text/html' } }),
    'https://example.com/i.png': () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
  });
  assert.equal((await handleFavicon(req('https://example.com'), { fetcher })).status, 200);
});
