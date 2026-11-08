import assert from 'node:assert/strict';
import test from 'node:test';
import { extractArticleContent, fetchArticleContent } from '../lib/article-content.ts';

const paragraph = '公開記事の本文です。新しい研究では、地域の交通と暮らしに関する具体的な調査結果が示されました。調査方法と限界も公開されています。';
const html = `<html><head><title>公開記事</title></head><body><nav>メニュー</nav><article><h1>公開記事</h1>${Array.from({ length: 7 }, () => `<p>${paragraph}</p>`).join('')}<script>secret()</script><iframe src="https://localhost/"></iframe></article><footer>フッター</footer></body></html>`;

test('公開HTMLから本文を抽出し、scriptとiframeの内容を実行・混入させない', () => {
  const result = extractArticleContent(html, 'https://example.com/article');
  assert.equal(result.title, '公開記事');
  assert.ok(result.content.includes(paragraph));
  assert.ok(!result.content.includes('secret()'));
  assert.ok(!result.content.includes('<iframe'));
  assert.ok(!result.content.includes('フッター'));
});

test('本文のないログイン・paywallページと巨大HTMLを拒否する', () => {
  for (const value of ['', '<html><body><h1>ログインしてください</h1><form><input type="password"></form></body></html>', '<html><body>Subscribe to continue reading</body></html>']) {
    assert.throws(() => extractArticleContent(value, 'https://example.com/article'), /本文|取得|空/);
  }
  assert.throws(() => extractArticleContent('a'.repeat(2 * 1024 * 1024 + 1), 'https://example.com/article'), /2MB|大き/);
});

test('本文fetchは公開HTTPSに限定しprivate redirectを辿らない', async () => {
  const fetcher = (async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } })) as typeof fetch;
  await assert.rejects(fetchArticleContent('https://example.com/article', fetcher), /公開|安全|URL/);
  await assert.rejects(fetchArticleContent('http://example.com/article', fetcher), /公開|HTTPS/);
});

test('安全な相対redirectからHTMLを抽出し、redirect loopを制限する', async () => {
  const fetcher = (async (input: RequestInfo | URL) => String(input).endsWith('/article')
    ? new Response(null, { status: 301, headers: { location: '/story' } })
    : new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })) as typeof fetch;
  assert.ok((await fetchArticleContent('https://example.com/article', fetcher)).content.includes(paragraph));
  const loop = (async () => new Response(null, { status: 302, headers: { location: '/article' } })) as typeof fetch;
  await assert.rejects(fetchArticleContent('https://example.com/article', loop), /リダイレクト/);
});

test('HTML以外と配信元の失敗を扱い、content-lengthなしでも2MBで停止する', async () => {
  await assert.rejects(fetchArticleContent('https://example.com/article', (async () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })) as typeof fetch), /HTML/);
  await assert.rejects(fetchArticleContent('https://example.com/article', (async () => new Response('error', { status: 403 })) as typeof fetch), /403|取得/);
  await assert.rejects(fetchArticleContent('https://example.com/article', (async () => new Response('a'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/html' } })) as typeof fetch), /2MB|大き/);
});

test('巨大なcontent-lengthのstreamをcancelし、timeoutを日本語で返す', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(fetchArticleContent('https://example.com/article', (async () => new Response(stream, { headers: { 'content-type': 'text/html', 'content-length': '3000000' } })) as typeof fetch), /2MB|大き/);
  assert.equal(cancelled, true);
  await assert.rejects(fetchArticleContent('https://example.com/article', (async () => { throw new DOMException('Aborted', 'AbortError'); }) as typeof fetch), /タイムアウト/);
});
