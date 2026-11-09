import { BodyTooLargeError, NO_STORE_HEADERS, isSameOrigin, readLimitedText } from '../http.ts';
import type { Article } from '../types.ts';
import { articleSchema } from '../cloud-library.ts';
import { MAX_READ_BATCH } from './constants.ts';
import { getFeedTarget, listFeedStates } from './schedule.ts';
import { fetchTarget } from './scheduled.ts';
import { BacklogInputError, importArticles, listChanges, setRead } from './store.ts';

type Db = Pick<D1Database, 'prepare' | 'batch'>;
type Ctx = { db: Db; user: { id: string } };

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_SMALL_BYTES = 256 * 1024;
const respond = (value: unknown, status = 200) => Response.json(value, { status, headers: NO_STORE_HEADERS });
const FORBIDDEN = () => respond({ error: '同じサイトから操作してください。' }, 403);
const BAD_BODY = () => respond({ error: '送信データの形式が正しくありません。' }, 400);

class BadBody extends Error {}
class TooLarge extends Error {}
async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    if (!request.body) throw new BadBody();
    value = JSON.parse(await readLimitedText(request.body, request.headers.get('content-length'), maxBytes));
  } catch (error) {
    throw error instanceof BodyTooLargeError ? new TooLarge() : new BadBody();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadBody();
  return value as Record<string, unknown>;
}
const failure = (error: unknown) => error instanceof TooLarge ? respond({ error: '送信データが大きすぎます。' }, 413)
  : error instanceof BacklogInputError ? respond({ error: error.message }, 400)
  : error instanceof BadBody ? BAD_BODY() : null;
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const isArticles = (value: unknown): value is Article[] => Array.isArray(value) && value.every(item => articleSchema.safeParse(item).success);

export async function handleListChanges(request: Request, { db, user }: Ctx): Promise<Response> {
  try { return respond(await listChanges(db, user.id, new URL(request.url).searchParams.get('after'))); }
  catch (error) {
    if (error instanceof BacklogInputError) return respond({ error: error.message }, 400);
    return respond({ error: '記事を読み込めませんでした。' }, 500);
  }
}

export async function handleSetRead(request: Request, { db, user }: Ctx, now = new Date()): Promise<Response> {
  if (!isSameOrigin(request)) return FORBIDDEN();
  try {
    const body = await readJson(request, MAX_SMALL_BYTES);
    if (!isStrings(body.ids) || typeof body.read !== 'boolean') return BAD_BODY();
    if (body.ids.length > MAX_READ_BATCH) return respond({ error: '一度に既読にできるのは1,000件までです。' }, 400);
    return respond({ updated: await setRead(db, user.id, body.ids, body.read, now) });
  } catch (error) {
    return failure(error) ?? respond({ error: '既読を保存できませんでした。' }, 500);
  }
}

export async function handleImport(request: Request, { db, user }: Ctx, now = new Date()): Promise<Response> {
  if (!isSameOrigin(request)) return FORBIDDEN();
  try {
    const body = await readJson(request, MAX_IMPORT_BYTES);
    if (!isArticles(body.articles) || !isStrings(body.read)) return BAD_BODY();
    return respond(await importArticles(db, user.id, body.articles, body.read, now));
  } catch (error) {
    return failure(error) ?? respond({ error: '記事を取り込めませんでした。' }, 500);
  }
}

// 無料プランのCPU上限のため、1回のリクエストで取得するのは1フィードだけ。同期文書は読まない。
export async function handleRefreshFeed(request: Request, { db, user }: Ctx, options: { now?: Date; fetcher?: typeof fetch } = {}): Promise<Response> {
  if (!isSameOrigin(request)) return FORBIDDEN();
  const feedId = new URL(request.url).searchParams.get('feed');
  try {
    const target = feedId ? await getFeedTarget(db, user.id, feedId) : null;
    if (!target) return respond({ error: 'フィードが見つかりません。' }, 404);
    const { inserted, error } = await fetchTarget(db, target, options.now ?? new Date(), options.fetcher);
    return respond(error ? { inserted, error } : { inserted });
  } catch { return respond({ error: 'フィードを取得できませんでした。' }, 500); }
}

export async function handleFeedStates({ db, user }: Ctx): Promise<Response> {
  try { return respond({ feeds: await listFeedStates(db, user.id) }); }
  catch { return respond({ error: '取得状況を読み込めませんでした。' }, 500); }
}
