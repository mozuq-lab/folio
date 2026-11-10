import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedError, MAX_ARTICLES, feedErrorKind, fetchFeed, fetchFeedConditional, isSafeFeedUrl, parseFeed } from '../lib/feeds.ts';
import { GET as routeGET } from '../app/api/feeds/route.ts';
import { runWithUser } from '../lib/auth/context.ts';

const signedIn = { id: 'cloudflare-access:reader', email: 'reader@example.com', displayName: 'Reader' };
const GET = (request: Request) => runWithUser(signedIn, () => routeGET(request));

const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
  <title><![CDATA[デザイン &amp; AI]]></title><link>https://example.com/</link>
  <item><guid>article-1</guid><title><![CDATA[<b>機械学習</b>の現在]]></title>
    <link>https://example.com/posts/1</link><pubDate>Thu, 05 Nov 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[<script>alert(1)</script><p>生成AI &amp; デザインのニュース</p>]]></description>
    <media:thumbnail url="https://example.com/image.jpg" />
  </item></channel></rss>`;

test('RSSを正規化し、HTMLを取り除いて記事と媒体を結び付ける', () => {
  const { feed, articles } = parseFeed(rss, 'https://example.com/feed.xml');
  assert.equal(feed.name, 'デザイン & AI');
  assert.equal(feed.website, 'https://example.com/');
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, '機械学習の現在');
  assert.equal(articles[0].description, '生成AI & デザインのニュース');
  assert.equal(articles[0].image, 'https://example.com/image.jpg');
  assert.equal(articles[0].publishedAt, '2026-11-05T10:00:00.000Z');
  assert.equal(articles[0].sourceId, feed.id);
  assert.equal(articles[0].sourceName, feed.name);
  assert.ok(articles[0].tags.includes('AI・機械学習'));
  assert.ok(articles[0].tags.includes('デザイン'));
  assert.ok(articles[0].readingMinutes >= 1);
  assert.equal(parseFeed(rss, feed.url).articles[0].id, articles[0].id);
});

test('Atomの複数linkからalternateを選び、相対URLとXHTMLを処理する', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>開発通信</title>
    <link rel="self" href="https://example.com/atom.xml" /><link rel="alternate" href="/" />
    <entry><id>urn:article:2</id><title>TypeScript最新情報</title>
      <link rel="self" href="/atom/2" /><link rel="alternate" href="/posts/2" />
      <link rel="enclosure" type="image/png" href="https://example.com/atom.png" />
      <updated>2026-11-04T09:30:00+09:00</updated>
      <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>開発者向けの更新</p></div></content>
    </entry></feed>`;
  const result = parseFeed(xml, 'https://example.com/atom.xml');
  assert.equal(result.feed.website, 'https://example.com/');
  assert.equal(result.articles[0].url, 'https://example.com/posts/2');
  assert.equal(result.articles[0].description, '開発者向けの更新');
  assert.equal(result.articles[0].image, 'https://example.com/atom.png');
  assert.equal(result.articles[0].publishedAt, '2026-11-04T00:30:00.000Z');
  assert.ok(result.articles[0].tags.includes('開発'));
});

test('RSS enclosure、media:contentとcontent内の画像を取得する', () => {
  for (const imageMarkup of [
    '<enclosure type="image/jpeg" url="https://example.com/photo.jpg" />',
    '<media:content medium="image" url="https://example.com/photo.jpg" />',
    '<content:encoded><![CDATA[<p>本文</p><img src="https://example.com/photo.jpg">]]></content:encoded>',
  ]) {
    const xml = `<rss xmlns:media="urn:media" xmlns:content="urn:content"><channel><title>写真</title><item><title>写真記事</title><link>https://example.com/photo</link>${imageMarkup}</item></channel></rss>`;
    assert.equal(parseFeed(xml, 'https://example.com/feed').articles[0].image, 'https://example.com/photo.jpg');
  }
});

test('記事のjavascriptリンクとHTTPS以外の画像を除外する', () => {
  const xml = `<rss><channel><title>安全な通信</title>
    <item><title>危険</title><link>javascript:alert(1)</link></item>
    <item><title>通常記事</title><link>http://example.com/article</link><enclosure type="image/png" url="http://example.com/insecure.png" /></item>
  </channel></rss>`;
  const { articles } = parseFeed(xml, 'https://example.com/feed');
  assert.equal(articles.length, 1);
  assert.equal(articles[0].url, 'http://example.com/article');
  assert.equal(articles[0].image, undefined);
  // どのトピックにも当てはまらない記事にはタグを付けない。
  assert.deepEqual(articles[0].tags, []);
});

test('linkなしの記事では絶対URLのpermalink GUIDだけを採用する', () => {
  const xml = `<rss><channel><title>通信</title>
    <item><title>opaque ID</title><guid isPermaLink="false">article-123</guid></item>
    <item><title>non-permalink URL</title><guid isPermaLink="false">https://example.com/id</guid></item>
    <item><title>relative ID</title><guid>article-456</guid></item>
    <item><title>permalink</title><guid>https://example.com/article</guid></item>
  </channel></rss>`;
  const { articles } = parseFeed(xml, 'https://example.com/feed');
  assert.equal(articles.length, 1);
  assert.equal(articles[0].url, 'https://example.com/article');
});

test('記事がMAX_ARTICLES（200件）を超えるfeedと重複記事を制限する', () => {
  assert.equal(MAX_ARTICLES, 200);
  const items = Array.from({ length: 205 }, (_, i) => `<item><title>記事${i}</title><link>https://example.com/${i}</link></item>`).join('');
  const { articles } = parseFeed(`<rss><channel><title>通信</title>${items}</channel></rss>`, 'https://example.com/feed');
  assert.equal(articles.length, 200);
  const duplicate = '<item><title>同じ記事</title><link>https://example.com/one</link></item>';
  assert.equal(parseFeed(`<rss><channel><title>通信</title>${duplicate}${duplicate}</channel></rss>`, 'https://example.com/feed').articles.length, 1);
});

test('空の有効なfeedを許可し、HTML・壊れたXML・feed以外を拒否する', () => {
  assert.equal(parseFeed('<rss><channel><title>空の通信</title></channel></rss>', 'https://example.com/feed').articles.length, 0);
  for (const xml of ['', '<html><body>hello</body></html>', '<rss><channel></rss>', '<response><title>not a feed</title></response>', '<rss><wrong /></rss>']) {
    assert.throws(() => parseFeed(xml, 'https://example.com/feed'));
  }
});

test('DOCTYPEと外部entity宣言を解析前に拒否する', () => {
  for (const xml of [
    '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel><title>&xxe;</title></channel></rss>',
    '<!DOCTYPE rss SYSTEM "https://example.com/dtd"><rss><channel><title>通信</title></channel></rss>',
  ]) assert.throws(() => parseFeed(xml, 'https://example.com/feed'));
});

test('公開HTTP(S) URLを許可し、ローカル宛先・credentials・独自portを拒否する', () => {
  assert.equal(isSafeFeedUrl('https://example.com/feed.xml'), true);
  assert.equal(isSafeFeedUrl('http://example.com/feed'), true);
  assert.equal(isSafeFeedUrl('http://example.com:80/feed'), true);
  assert.equal(isSafeFeedUrl('https://news.example.co.jp/rss?format=xml'), true);
  for (const url of [
    'not-a-url', 'ftp://example.com/feed', 'file:///etc/passwd', 'http://localhost/feed', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://example.com:8080/feed',
    'https://localhost/feed', 'https://LOCALHOST./feed', 'https://api.localhost/feed',
    'https://metadata.google.internal/', 'https://printer.local/', 'https://nas.lan/', 'https://intranet/feed',
    'https://router.home.arpa/', 'https://intranet.corp/',
    'https://127.0.0.1/', 'https://127.1/', 'https://2130706433/', 'https://0x7f000001/',
    'https://10.0.0.1/', 'https://172.16.0.1/', 'https://192.168.1.1/',
    'https://169.254.169.254/', 'https://100.64.0.1/', 'https://0.0.0.0/',
    'https://[::1]/', 'https://[fc00::1]/', 'https://[fe80::1]/', 'https://[::ffff:127.0.0.1]/',
    'https://user:pass@example.com/feed', 'https://example.com:8443/feed',
  ]) assert.equal(isSafeFeedUrl(url), false, url);
});

test('fetchはredirect先も検証してprivate URLへのアクセスを止める', async () => {
  const fetcher = async (input: string | URL | Request) => {
    if (String(input) === 'https://example.com/feed') return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
    throw new Error('private URLにアクセスした');
  };
  await assert.rejects(fetchFeed('https://example.com/feed', fetcher as typeof fetch), /URL|公開|安全/);
});

test('安全な相対redirectを辿り、redirect loopを制限する', async () => {
  const fetcher = async (input: string | URL | Request) => String(input) === 'https://example.com/feed'
    ? new Response(null, { status: 301, headers: { location: '/rss.xml' } })
    : new Response(rss, { headers: { 'content-type': 'application/rss+xml' } });
  assert.equal((await fetchFeed('https://example.com/feed', fetcher as typeof fetch)).articles.length, 1);
  const loop = async () => new Response(null, { status: 302, headers: { location: '/feed' } });
  await assert.rejects(fetchFeed('https://example.com/feed', loop as typeof fetch), /redirect|リダイレクト/);
});

test('Content-Lengthがないstreamでも2MBを超える応答を拒否する', async () => {
  const fetcher = async () => new Response('a'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(fetchFeed('https://example.com/feed', fetcher as typeof fetch), /2MB|大き/);
  const htmlFetcher = async () => new Response('<html>エラー</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchFeed('https://example.com/feed', htmlFetcher as typeof fetch), /RSS|Atom|HTML/);
});

test('Content-Lengthで上限超過を検知した場合も応答streamを閉じる', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const fetcher = async () => new Response(stream, { headers: { 'content-length': '3000000' } });
  await assert.rejects(fetchFeed('https://example.com/feed', fetcher as typeof fetch), /2MB|大き/);
  assert.equal(cancelled, true);
});

test('APIは未ログインを401で拒否し、偽装ヘッダーを利用者として扱わない', async () => {
  const response = await routeGET(new Request('https://folio.example/api/feeds?url=https://example.com/feed', {
    headers: { 'oai-authenticated-user-id': 'attacker', 'oai-authenticated-user-email': 'attacker@example.com' },
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'RSSの取得にはログインが必要です。' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await routeGET(new Request('https://folio.example/api/feeds?url=https://example.com/feed', { headers: { 'sec-fetch-site': 'cross-site' } }))).status, 403);
});

test('APIは不正URLと別originを拒否する', async () => {
  assert.equal((await GET(new Request('https://folio.example/api/feeds'))).status, 400);
  assert.equal((await GET(new Request('https://folio.example/api/feeds?url=https://localhost/feed'))).status, 400);
  assert.equal((await GET(new Request('https://folio.example/api/feeds?url=https://example.com/feed', { headers: { origin: 'https://other.example' } }))).status, 403);
});

test('APIはfeedをJSONで返し、5分以内の同一feedをcacheする', async () => {
  const originalFetch = globalThis.fetch;
  let remainingResponses = 1;
  globalThis.fetch = (async () => {
    if (remainingResponses-- <= 0) throw new Error('cacheされていない');
    return new Response(rss, { headers: { 'content-type': 'application/rss+xml' } });
  }) as typeof fetch;
  try {
    const request = () => new Request('https://folio.example/api/feeds?url=https://cache.example.com/feed');
    const response = await GET(request());
    assert.equal(response.status, 200);
    const body = await response.json() as Awaited<ReturnType<typeof fetchFeed>>;
    assert.equal(body.feed.name, 'デザイン & AI');
    assert.equal(body.articles.length, 1);
    assert.equal((await GET(request())).status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('APIは配信元のHTTP失敗を扱えるJSONエラーに変換する', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('upstream unavailable', { status: 503 })) as typeof fetch;
  try {
    const response = await GET(new Request('https://folio.example/api/feeds?url=https://failed.example.com/feed'));
    assert.equal(response.status, 502);
    const body = await response.json() as { error: unknown };
    assert.equal(typeof body.error, 'string');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('条件付き取得はetagとlastModifiedを要求ヘッダーに載せる', async () => {
  let headers: Headers | undefined;
  const fetcher = async (_url: string, init?: RequestInit) => {
    headers = new Headers(init?.headers);
    return new Response(rss, { headers: { 'content-type': 'application/xml', ETag: '"v2"', 'Last-Modified': 'Thu, 05 Nov 2026 10:00:00 GMT' } });
  };
  const result = await fetchFeedConditional('https://example.com/feed', { etag: '"v1"', lastModified: 'Wed, 04 Nov 2026 10:00:00 GMT', fetcher: fetcher as typeof fetch });
  assert.equal(headers?.get('If-None-Match'), '"v1"');
  assert.equal(headers?.get('If-Modified-Since'), 'Wed, 04 Nov 2026 10:00:00 GMT');
  assert.ok(result.status === 'ok');
  assert.equal(result.etag, '"v2"');
  assert.equal(result.lastModified, 'Thu, 05 Nov 2026 10:00:00 GMT');
  assert.equal(result.feed.articles.length, 1);
});

test('条件を渡さないときは条件付きヘッダーを付けず、応答に無い値はnullにする', async () => {
  let headers: Headers | undefined;
  const fetcher = async (_url: string, init?: RequestInit) => { headers = new Headers(init?.headers); return new Response(rss); };
  const result = await fetchFeedConditional('https://example.com/feed', { fetcher: fetcher as typeof fetch });
  assert.equal(headers?.has('If-None-Match'), false);
  assert.equal(headers?.has('If-Modified-Since'), false);
  assert.ok(result.status === 'ok');
  assert.equal(result.etag, null);
  assert.equal(result.lastModified, null);
});

test('304はnot-modifiedを返し、本文を読まずに取り消す', async () => {
  let cancelled = false;
  // The Response constructor rejects a body on 304, so use a minimal stand-in.
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const fetcher = async () => ({ status: 304, ok: false, headers: new Headers(), body });
  const result = await fetchFeedConditional('https://example.com/feed', { etag: '"v1"', fetcher: fetcher as unknown as typeof fetch });
  assert.deepEqual(result, { status: 'not-modified' });
  assert.equal(cancelled, true);
});

test('条件付き取得でも危険なリダイレクト先は拒否する', async () => {
  const fetcher = async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/feed' } });
  await assert.rejects(fetchFeedConditional('https://example.com/feed', { fetcher: fetcher as typeof fetch }), /安全|公開|URL/);
});

test('feedErrorKindは失敗を種類に分ける', async () => {
  assert.equal(feedErrorKind(new FeedError('x', 504)), 'timeout');
  assert.equal(feedErrorKind(new FeedError('x', 422)), 'format');
  assert.equal(feedErrorKind(new FeedError('x', 413)), 'format');
  assert.equal(feedErrorKind(new Error('x')), 'format');
  assert.equal(feedErrorKind('x'), 'format');
  const networkFetcher = async () => { throw new TypeError('boom'); };
  const network = await fetchFeedConditional('https://example.com/feed', { fetcher: networkFetcher as typeof fetch }).catch((error: unknown) => error);
  assert.equal((network as FeedError).status, 502);
  assert.equal(feedErrorKind(network), 'network');
  const httpFetcher = async () => new Response('secret', { status: 500 });
  const http = await fetchFeedConditional('https://example.com/feed', { fetcher: httpFetcher as typeof fetch }).catch((error: unknown) => error);
  assert.equal((http as FeedError).status, 502);
  assert.equal(feedErrorKind(http), 'http');
  assert.doesNotMatch((http as FeedError).message, /secret/);
});

test('フィードの分類はトピックに当てはまらなければ「未分類」にする', () => {
  const xml = '<rss><channel><title>今日の天気</title><item><title>晴れ</title><link>https://example.com/a</link></item></channel></rss>';
  assert.equal(parseFeed(xml, 'https://example.com/feed').feed.category, '未分類');
});
