import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { isSafeFeedUrl } from './feeds.ts';
import { BodyTooLargeError, readLimitedBytes } from './http.ts';

const MAX_BYTES = 2 * 1024 * 1024;
export class ArticleContentError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = 'ArticleContentError';
    this.status = status;
  }
}

export function extractArticleContent(html: string, url: string): { title: string; content: string } {
  if (!isSafeFeedUrl(url)) throw new ArticleContentError('公開されたHTTPSの記事URLを入力してください。', 400);
  if (!html.trim()) throw new ArticleContentError('記事の本文が空です。');
  if (new TextEncoder().encode(html).byteLength > MAX_BYTES) throw new ArticleContentError('HTMLが大きすぎます。2MB以下の記事を指定してください。', 413);
  // linkedom parses without executing scripts or loading subresources.
  const { document } = parseHTML(html);
  Object.defineProperty(document, 'documentURI', { value: url, configurable: true });
  for (const node of document.querySelectorAll('script,style,iframe,object,embed,form,template,noscript')) node.remove();
  const base = document.createElement('base');
  base.setAttribute('href', url);
  document.head.insertBefore(base, document.head.firstChild);
  const article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
  const content = (article?.textContent ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  // Short login/subscribe screens are not presented as an article body.
  if (content.length < 160) throw new ArticleContentError('公開された記事本文を取得できませんでした。ログインや購読が必要な記事はRSS概要をご利用ください。');
  return { title: (article?.title ?? document.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 300), content: content.slice(0, 120_000) };
}

async function readHTML(response: Response): Promise<string> {
  if (!response.body) {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new ArticleContentError('HTMLが大きすぎます。2MB以下の記事を指定してください。', 413);
    throw new ArticleContentError('記事の本文が空です。');
  }
  try { return new TextDecoder().decode(await readLimitedBytes(response.body, response.headers.get('content-length'), MAX_BYTES)); }
  catch (error) { throw error instanceof BodyTooLargeError ? new ArticleContentError('HTMLが大きすぎます。2MB以下の記事を指定してください。', 413) : error; }
}

export async function fetchArticleContent(url: string, fetcher: typeof fetch = fetch): Promise<{ title: string; content: string }> {
  if (!isSafeFeedUrl(url)) throw new ArticleContentError('公開されたHTTPSの記事URLを入力してください。', 400);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let current = new URL(url).href;
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!isSafeFeedUrl(current)) throw new ArticleContentError('安全な公開HTTPS URLへのリダイレクトのみ取得できます。', 400);
      const response = await fetcher(current, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'text/html, application/xhtml+xml;q=0.9' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3) throw new ArticleContentError('リダイレクト回数が多すぎるか、転送先が不正です。', 502);
        try { current = new URL(location, current).href; } catch { throw new ArticleContentError('リダイレクト先のURLが不正です。', 502); }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ArticleContentError(`配信元から記事を取得できませんでした（HTTP ${response.status}）。`, 502);
      }
      if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        throw new ArticleContentError('HTML形式の記事ページを指定してください。');
      }
      return extractArticleContent(await readHTML(response), current);
    }
    throw new ArticleContentError('リダイレクト先を取得できませんでした。', 502);
  } catch (error) {
    if (error instanceof ArticleContentError) throw error;
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new ArticleContentError('記事の取得がタイムアウトしました。', 504);
    throw new ArticleContentError('配信元に接続できませんでした。時間をおいてお試しください。', 502);
  } finally { clearTimeout(timer); }
}
