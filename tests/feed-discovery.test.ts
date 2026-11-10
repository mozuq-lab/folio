import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_CANDIDATES, MAX_CANDIDATE_TITLE, NO_FEED_LINK_MESSAGE, findFeedLinks, lookupFeed } from '../lib/feed-discovery.ts';
import { feedLookupPath, isSubscribed, parseFeedAddResponse } from '../lib/feed-add.ts';
import { FeedError, fetchFeed, fetchFeedConditional } from '../lib/feeds.ts';
import { HTML_HEAD_BYTES, headLinks } from '../lib/html-head.ts';
import { GET as routeGET } from '../app/api/feeds/route.ts';
import { runWithUser } from '../lib/auth/context.ts';

const PAGE = 'https://example.com/blog/';
const rss = (title = '開発通信') => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://example.com/</link><item><title>記事</title><link>https://example.com/posts/1</link></item></channel></rss>`;
const page = (head: string, body = '') => `<!doctype html><html><head><meta charset="utf-8"><title>ブログ</title>${head}</head><body>${body}</body></html>`;
const html = (text: string, headers: Record<string, string> = {}) => () => new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const xml = (text = rss()) => () => new Response(text, { headers: { 'content-type': 'application/rss+xml' } });
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
const link = (attributes: string) => `<link ${attributes}>`;

test('findFeedLinks: rel=alternate でRSS / Atomの型のlinkだけを候補にし、titleとURLを返す', () => {
  const head = [
    link('rel="stylesheet" href="/style.css"'),
    link('rel="alternate" type="application/rss+xml" title="ブログ RSS" href="https://example.com/feed.xml"'),
    link('rel="alternate" type="application/atom+xml" title="Atom" href="https://example.com/atom.xml"'),
    link('rel="alternate" type="application/json" href="https://example.com/feed.json"'),
    link('rel="alternate" hreflang="en" href="https://example.com/en/"'),
    link('rel="icon" type="application/rss+xml" href="https://example.com/not-alternate.xml"'),
  ].join('');
  assert.deepEqual(findFeedLinks(page(head), PAGE), [
    { url: 'https://example.com/feed.xml', title: 'ブログ RSS' },
    { url: 'https://example.com/atom.xml', title: 'Atom' },
  ]);
});

test('findFeedLinks: 相対URLは転送後の最終URLを基準に解決し、#以降を落とす', () => {
  const head = link('rel="alternate" type="application/rss+xml" href="feed.xml"') + link('rel="alternate" type="application/atom+xml" href="/atom.xml#top"') + link('rel="alternate" type="application/rss+xml" href="//cdn.example.net/rss"');
  assert.deepEqual(findFeedLinks(page(head), 'https://www.example.com/blog/').map(c => c.url), [
    'https://www.example.com/blog/feed.xml', 'https://www.example.com/atom.xml', 'https://cdn.example.net/rss',
  ]);
});

test('findFeedLinks: 安全でないhrefを捨てる', () => {
  const unsafe = ['http://example.com/feed', 'https://127.0.0.1/feed', 'https://192.168.0.1/feed', 'https://localhost/feed', 'https://intranet.local/rss',
    'javascript:alert(1)', 'data:application/rss+xml,<rss/>', 'https://user:pass@example.com/feed', 'https://example.com:8443/feed', 'file:///etc/passwd', 'https://[::1]/feed', 'https://exa mple.com/feed'];
  const head = unsafe.map(href => link(`rel="alternate" type="application/rss+xml" href="${href}"`)).join('') + link('rel="alternate" type="application/rss+xml" href="https://example.com/ok.xml"');
  assert.deepEqual(findFeedLinks(page(head), PAGE).map(c => c.url), ['https://example.com/ok.xml']);
  // 相対URLでも、基準のページ自身を指すものはフィードではないので捨てる。
  assert.deepEqual(findFeedLinks(page(link('rel="alternate" type="application/rss+xml" href="./"')), PAGE), []);
});

test('findFeedLinks: 文字参照・relの複数の語・大文字小文字・引用符・属性の順の違いを読む', () => {
  const head = [
    link('rel="alternate nofollow" type="application/rss+xml" href="/feed?a=1&amp;b=2" title="A &amp; B &#x3042;&#12354; &lt;b&gt;"'),
    '<LINK HREF=\'/single.xml\' TYPE=\'Application/RSS+XML\' REL=\'Alternate\' TITLE=\'単一引用符\'>',
    link('href=/unquoted.xml type=application/atom+xml rel=alternate'),
    link('type="application/rss+xml; charset=utf-8" title="型に引数" rel="\talternate\n" href="/params.xml" /'),
    link('rel="alternate" type="application/rss+xml" title="同じURL" href="/feed?a=1&b=2"'),
  ].join('\n');
  assert.deepEqual(findFeedLinks(page(head), PAGE), [
    { url: 'https://example.com/feed?a=1&b=2', title: 'A & B ああ <b>' },
    { url: 'https://example.com/single.xml', title: '単一引用符' },
    { url: 'https://example.com/unquoted.xml', title: '' },
    { url: 'https://example.com/params.xml', title: '型に引数' },
  ]);
});

test('findFeedLinks: 候補の数とtitleの長さに上限を付け、titleの制御文字と連続した空白を詰める', () => {
  const head = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => link(`rel="alternate" type="application/rss+xml" title="${i === 0 ? `長い\u0007  タイトル${'あ'.repeat(300)}` : `F${i}`}" href="/f${i}.xml"`)).join('');
  const candidates = findFeedLinks(page(head), PAGE);
  assert.equal(candidates.length, MAX_CANDIDATES);
  assert.equal([...candidates[0].title].length, MAX_CANDIDATE_TITLE);
  assert.ok(candidates[0].title.startsWith('長い タイトルあ'));
});

test('findFeedLinks: コメント・script・title・</head>より後のlinkは読まない', () => {
  const feedLink = (href: string) => link(`rel="alternate" type="application/rss+xml" href="${href}"`);
  const text = `<html><head><!-- ${feedLink('/comment.xml')} --><script>document.write('${feedLink('/script.xml')}')</script><title>${feedLink('/title.xml')}</title>${feedLink('/head.xml')}</head><body>${feedLink('/body.xml')}</body></html>`;
  assert.deepEqual(findFeedLinks(text, PAGE).map(c => c.url), ['https://example.com/head.xml']);
  // 閉じていないコメント・引用符より後はタグとして読まない。
  assert.deepEqual(findFeedLinks(`<head>${feedLink('/a.xml')}<!-- ${feedLink('/b.xml')}`, PAGE).map(c => c.url), ['https://example.com/a.xml']);
  assert.deepEqual(findFeedLinks(`<head>${feedLink('/a.xml')}<link title="閉じない ${feedLink('/b.xml')}`, PAGE).map(c => c.url), ['https://example.com/a.xml']);
});

test('headLinks: 引用符の中の > でタグを閉じず、同じ属性は最初の値を使う', () => {
  const [first] = headLinks('<head><link title="a > b" href="/x" href="/y" rel=icon></head>');
  assert.equal(first.get('title'), 'a > b');
  assert.equal(first.get('href'), '/x');
  assert.equal(first.get('rel'), 'icon');
  // 属性名が __proto__ でも普通の値として扱う。
  assert.equal(headLinks('<link __proto__="x">')[0].get('__proto__'), 'x');
});

test('lookupFeed: フィードのURLならそのまま返し、ページは1回だけ取得する', async () => {
  const { fetcher, calls } = fetcherOf({ 'https://example.com/feed.xml': xml() });
  const result = await lookupFeed('https://example.com/feed.xml', { fetcher });
  assert.ok('feed' in result);
  assert.equal(result.feed.url, 'https://example.com/feed.xml');
  assert.deepEqual(calls, ['https://example.com/feed.xml']);
});

test('lookupFeed: 候補が1つならそのフィードを取得し、購読するURLは見つけたフィードのURLにする', async () => {
  const { fetcher, calls } = fetcherOf({
    [PAGE]: html(page(link('rel="alternate" type="application/rss+xml" title="RSS" href="/blog/feed.xml"'))),
    'https://example.com/blog/feed.xml': xml(rss('見つけたフィード')),
  });
  const result = await lookupFeed(PAGE, { fetcher });
  assert.ok('feed' in result);
  assert.equal(result.feed.url, 'https://example.com/blog/feed.xml');
  assert.equal(result.feed.name, '見つけたフィード');
  assert.equal(result.articles.length, 1);
  assert.deepEqual(calls, [PAGE, 'https://example.com/blog/feed.xml']);
});

test('lookupFeed: 候補が2つ以上なら候補と最終URLを返し、フィードは取得しない', async () => {
  const head = link('rel="alternate" type="application/rss+xml" title="記事" href="/feed.xml"') + link('rel="alternate" type="application/rss+xml" title="コメント" href="/comments/feed.xml"');
  const { fetcher, calls } = fetcherOf({ [PAGE]: html(page(head)) });
  assert.deepEqual(await lookupFeed(PAGE, { fetcher }), {
    page: PAGE,
    candidates: [{ url: 'https://example.com/feed.xml', title: '記事' }, { url: 'https://example.com/comments/feed.xml', title: 'コメント' }],
  });
  assert.deepEqual(calls, [PAGE]);
});

test('lookupFeed: 候補が0なら、指定が無いことと直接入力してほしいことを伝える', async () => {
  const { fetcher } = fetcherOf({ [PAGE]: html(page(link('rel="alternate" type="application/rss+xml" href="http://example.com/feed"'))) });
  const error = await lookupFeed(PAGE, { fetcher }).catch((e: unknown) => e);
  assert.ok(error instanceof FeedError);
  assert.equal(error.message, NO_FEED_LINK_MESSAGE);
  assert.equal(error.status, 422);
  assert.match(NO_FEED_LINK_MESSAGE, /見つかりませんでした。.*直接入力してください。/);
});

test('lookupFeed: 転送の先がHTMLなら、最終URLを基準に候補を解決する（転送のたびに安全か確かめる）', async () => {
  const { fetcher, calls } = fetcherOf({
    'https://example.com/': () => new Response(null, { status: 301, headers: { location: 'https://www.example.com/home/' } }),
    'https://www.example.com/home/': html(page(link('rel="alternate" type="application/atom+xml" href="atom.xml"'))),
    'https://www.example.com/home/atom.xml': xml(),
  });
  const result = await lookupFeed('https://example.com/', { fetcher });
  assert.ok('feed' in result);
  assert.equal(result.feed.url, 'https://www.example.com/home/atom.xml');
  assert.deepEqual(calls, ['https://example.com/', 'https://www.example.com/home/', 'https://www.example.com/home/atom.xml']);
  const unsafe = fetcherOf({ 'https://example.com/': () => new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/' } }) });
  await assert.rejects(lookupFeed('https://example.com/', { fetcher: unsafe.fetcher }), /安全/);
  assert.deepEqual(unsafe.calls, ['https://example.com/']);
});

test('lookupFeed: 読み取り量より大きいHTMLは先頭だけを読み、残りは読まずに止める', async () => {
  const feedLink = link('rel="alternate" type="application/rss+xml" href="/early.xml"');
  const lateLink = link('rel="alternate" type="application/rss+xml" href="/late.xml"');
  const make = (head: string) => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode(`<meta name="filler" content="${'x'.repeat(16 * 1024)}">`);
    const start = new TextEncoder().encode(`<html><head>${head}`);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(pulled++ === 0 ? start : chunk); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    return { response: () => new Response(stream, { headers: { 'content-type': 'text/html' } }), state: () => ({ pulled, cancelled }) };
  };
  const early = make(feedLink);
  const one = fetcherOf({ [PAGE]: early.response, 'https://example.com/early.xml': xml() });
  const result = await lookupFeed(PAGE, { fetcher: one.fetcher });
  assert.ok('feed' in result);
  assert.equal(result.feed.url, 'https://example.com/early.xml');
  assert.equal(early.state().cancelled, true);
  assert.ok(early.state().pulled * 16 * 1024 < HTML_HEAD_BYTES + 64 * 1024, '先頭を読んだら止める');
  // 読み取り量より後ろにあるlinkは見ない。
  const fillerBytes = new TextEncoder().encode('x'.repeat(HTML_HEAD_BYTES)).byteLength;
  const late = fetcherOf({ [PAGE]: html(`<html><head><meta content="${'x'.repeat(fillerBytes)}">${lateLink}</head></html>`) });
  await assert.rejects(lookupFeed(PAGE, { fetcher: late.fetcher }), new RegExp(NO_FEED_LINK_MESSAGE.slice(0, 20)));
});

test('lookupFeed: Content-Typeのcharsetでtitleを読む', async () => {
  // 「日本語」の Shift_JIS
  const title = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
  const encode = (text: string) => new TextEncoder().encode(text);
  const parts = [encode('<html><head><link rel="alternate" type="application/rss+xml" href="/a.xml" title="'), title, encode('"><link rel="alternate" type="application/rss+xml" href="/b.xml"></head>')];
  const body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  const { fetcher } = fetcherOf({ [PAGE]: () => new Response(body, { headers: { 'content-type': 'text/html; charset=Shift_JIS' } }) });
  const result = await lookupFeed(PAGE, { fetcher });
  assert.ok('candidates' in result);
  assert.equal(result.candidates[0].title, '日本語');
});

test('lookupFeed: discover=false（候補から選んだURL）ではページを探さず、HTMLなら失敗にする', async () => {
  const { fetcher, calls } = fetcherOf({ [PAGE]: html(page(link('rel="alternate" type="application/rss+xml" href="/feed.xml"'))) });
  await assert.rejects(lookupFeed(PAGE, { fetcher, discover: false }), /HTMLページではなく/);
  assert.deepEqual(calls, [PAGE]);
});

test('定期取得・更新の経路（fetchFeedConditional / fetchFeed）では、HTMLを返したら今までどおり失敗にする', async () => {
  const { fetcher, calls } = fetcherOf({
    'https://example.com/feed.xml': html(page(link('rel="alternate" type="application/rss+xml" href="/real.xml"'))),
    'https://example.com/real.xml': xml(),
  });
  await assert.rejects(fetchFeedConditional('https://example.com/feed.xml', { fetcher, etag: '"v1"' }), (error: unknown) => error instanceof FeedError && error.message === 'HTMLページではなく、RSS / AtomのURLを入力してください。' && error.status === 422);
  await assert.rejects(fetchFeed('https://example.com/feed.xml', fetcher), /HTMLページではなく/);
  assert.deepEqual(calls, ['https://example.com/feed.xml', 'https://example.com/feed.xml']);
});

const signedIn = { id: 'cloudflare-access:reader', email: 'reader@example.com', displayName: 'Reader' };
const GET = (request: Request) => runWithUser(signedIn, () => routeGET(request));
async function withGlobalFetch<T>(routes: Route, run: (calls: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const { fetcher, calls } = fetcherOf(routes);
  globalThis.fetch = fetcher;
  try { return await run(calls); } finally { globalThis.fetch = original; }
}

test('APIはサイトのURLから候補を返し、discover=0ではページを探さない', async () => {
  const site = 'https://route.example.com/';
  const head = link('rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml"') + link('rel="alternate" type="application/atom+xml" title="Atom" href="/atom.xml"');
  await withGlobalFetch({ [site]: html(page(head)), 'https://route.example.com/rss.xml': xml() }, async calls => {
    const response = await GET(new Request(`https://folio.example${feedLookupPath(site)}`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { page: site, candidates: [{ url: 'https://route.example.com/rss.xml', title: 'RSS' }, { url: 'https://route.example.com/atom.xml', title: 'Atom' }] });
    const chosen = await GET(new Request(`https://folio.example${feedLookupPath('https://route.example.com/rss.xml', false)}`));
    assert.equal(chosen.status, 200);
    assert.equal((await chosen.json() as { feed: { url: string } }).feed.url, 'https://route.example.com/rss.xml');
    const notFeed = await GET(new Request(`https://folio.example${feedLookupPath(site, false)}`));
    assert.equal(notFeed.status, 422);
    assert.match((await notFeed.json() as { error: string }).error, /HTMLページではなく/);
    assert.equal(notFeed.headers.get('cache-control'), 'no-store');
    // 候補もキャッシュし、同じURLで2回は取りに行かない。
    await GET(new Request(`https://folio.example${feedLookupPath(site)}`));
    assert.deepEqual(calls, [site, 'https://route.example.com/rss.xml', site]);
  });
});

test('APIは候補が0のページを422で返す', async () => {
  const site = 'https://nofeed.example.com/';
  await withGlobalFetch({ [site]: html(page('')) }, async () => {
    const response = await GET(new Request(`https://folio.example${feedLookupPath(site)}`));
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: NO_FEED_LINK_MESSAGE });
  });
});

test('parseFeedAddResponse: フィード・候補・エラーを見分け、形が違うものは失敗にする', () => {
  const feed = { id: 'feed-1', name: 'F', url: 'https://example.com/feed.xml', website: 'https://example.com', category: '未分類', color: '#000', initial: 'F' };
  assert.deepEqual(parseFeedAddResponse(true, { feed, articles: [] }), { kind: 'feed', feed });
  assert.deepEqual(parseFeedAddResponse(true, { page: PAGE, candidates: [{ url: 'https://example.com/a.xml', title: 'A' }, { url: 1 }, null] }), { kind: 'candidates', page: PAGE, candidates: [{ url: 'https://example.com/a.xml', title: 'A' }] });
  assert.deepEqual(parseFeedAddResponse(false, { error: '見つかりませんでした。' }), { kind: 'error', message: '見つかりませんでした。' });
  for (const body of [null, 'x', {}, { candidates: [] }, { feed: { id: 1 } }]) assert.equal(parseFeedAddResponse(true, body).kind, 'error');
  assert.equal(parseFeedAddResponse(false, null).kind, 'error');
});

test('isSubscribed と feedLookupPath', () => {
  assert.equal(isSubscribed([{ url: 'https://example.com/feed.xml' }], 'https://example.com/feed.xml'), true);
  assert.equal(isSubscribed([{ url: 'https://example.com/feed.xml' }], 'https://example.com/other.xml'), false);
  assert.equal(feedLookupPath('https://example.com/?a=1&b=2'), '/api/feeds?url=https%3A%2F%2Fexample.com%2F%3Fa%3D1%26b%3D2');
  assert.equal(feedLookupPath('https://example.com/feed.xml', false), '/api/feeds?url=https%3A%2F%2Fexample.com%2Ffeed.xml&discover=0');
});
