import { getCurrentUser } from '../../../lib/auth/context.ts';
import { BodyTooLargeError, NO_STORE_HEADERS, isSameOrigin, readLimitedBytes } from '../../../lib/http.ts';
import { ArticleContentError, fetchArticleContent } from '../../../lib/article-content.ts';

const headers = NO_STORE_HEADERS;
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return Response.json({ error: '同じサイトから記事本文を取得してください。' }, { status: 403, headers });
  }
  if (!getCurrentUser()) return Response.json({ error: '記事本文の取得にはログインが必要です。' }, { status: 401, headers });
  try {
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return Response.json({ error: 'JSON形式で記事URLを送信してください。' }, { status: 415, headers });
    if (!request.body) throw new ArticleContentError('記事URLを入力してください。', 400);
    let text: string;
    try { text = new TextDecoder().decode(await readLimitedBytes(request.body, request.headers.get('content-length'), 8192)); }
    catch (error) { throw error instanceof BodyTooLargeError ? new ArticleContentError('送信内容が大きすぎます。', 413) : error; }
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new ArticleContentError('JSONの形式を確認してください。', 400); }
    if (!payload || typeof payload !== 'object' || !('url' in payload) || typeof payload.url !== 'string' || payload.url.length > 2048) throw new ArticleContentError('記事URLを入力してください。', 400);
    const result = await fetchArticleContent(payload.url);
    return Response.json({ ...result, fetchedAt: new Date().toISOString() }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof ArticleContentError ? error.message : '記事本文を取得できませんでした。もう一度お試しください。' }, { status: error instanceof ArticleContentError ? error.status : 500, headers });
  }
}
