import type { Article, Feed, ReaderState } from '../types.ts';
import { toArticle } from '../personalization.ts';
import { MAX_READ_BATCH } from './constants.ts';

// 画面に渡す「表示用のreader」と、一覧・既読まわりの判断。どれも純粋関数。

export type BacklogView = { articles: Article[]; readIds: ReadonlySet<string> };
export type FrozenOrder = { ids: string[]; token: number; newCount: number };
export type ImportRequest = { articles: Article[]; read: string[] };

/**
 * 同期データの記事（保持対象）とバックログの記事を合わせる。URLとIDで重複を除き、保持対象を優先する。
 * バックログの記事は購読中のフィードのものだけを出し、記事のフィード名は購読時の名前にそろえる。
 */
export function mergeViewArticles(retained: Article[], backlog: Article[], feeds: Feed[]): Article[] {
  const names = new Map(feeds.map(feed => [feed.id, feed.name]));
  const ids = new Set(retained.map(article => article.id));
  const urls = new Set(retained.map(article => article.url));
  const result = [...retained];
  for (const article of backlog) {
    const name = names.get(article.sourceId);
    if (name === undefined || ids.has(article.id) || urls.has(article.url)) continue;
    ids.add(article.id);
    urls.add(article.url);
    result.push(name === article.sourceName ? article : { ...article, sourceName: name });
  }
  return result;
}

/** 同期データの既読（保持対象の記事）とバックログの既読を合わせる。 */
export function mergeReadIds(read: string[], readIds: ReadonlySet<string>): Set<string> {
  const merged = new Set(readIds);
  for (const id of read) merged.add(id);
  return merged;
}

/** 既存の画面にそのまま渡せる reader を作る。articles は保持対象とバックログの和、read は両者の既読の和。 */
export function buildReaderView(state: ReaderState, backlog: BacklogView): ReaderState {
  return { ...state, articles: mergeViewArticles(state.articles, backlog.articles, state.feeds), read: [...mergeReadIds(state.read, backlog.readIds)] };
}

/**
 * 既読・未読の変更の送り先を決める。同期データに本体がある記事は同期データの read、それ以外はバックログ。
 * 表示は両者の和なので、未読に戻すときはバックログ側で既読になっている同期データの記事もバックログへ送る。
 */
export function routeReadChange(ids: string[], read: boolean, libraryIds: ReadonlySet<string>, backlogRead: ReadonlySet<string>): { library: string[]; backlog: string[] } {
  const library: string[] = [];
  const backlog: string[] = [];
  const both: string[] = [];
  for (const id of ids) {
    if (!libraryIds.has(id)) backlog.push(id);
    else {
      library.push(id);
      if (!read && backlogRead.has(id)) both.push(id);
    }
  }
  return { library, backlog: [...backlog, ...both] };
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer');
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * For You の並びを refreshToken が変わるまで固定する。固定中に届いた記事は並びに足さず、件数（newCount）だけを返す。
 * 並びが空なら崩れるスクロール位置が無いので、届いた記事をそのまま並べる。
 * 並びが変わらないときは previous.ids と同じ配列を返す（呼び出し側は参照の比較で保存の要否を判断できる）。
 */
export function freezeOrder(previous: { ids: string[]; token: number } | null, ranked: Article[], refreshToken: number): FrozenOrder {
  if (!previous || previous.token !== refreshToken || (!previous.ids.length && ranked.length)) {
    return { ids: ranked.map(article => article.id), token: refreshToken, newCount: 0 };
  }
  const shown = new Set(previous.ids);
  let newCount = 0;
  for (const article of ranked) if (!shown.has(article.id)) newCount++;
  return { ids: previous.ids, token: refreshToken, newCount };
}

/**
 * 既読をまとめて送る。1回でも失敗したらそこで止め、それまでに送れた件数と失敗した位置を返す。
 * 失敗した位置から後ろの束を渡せば再試行できる。send は成功なら true を返す（例外も失敗として扱う）。
 */
export async function sendReadBatches(batches: string[][], send: (batch: string[]) => Promise<boolean>): Promise<{ sent: number; failedAt: number | null }> {
  let sent = 0;
  for (let i = 0; i < batches.length; i++) {
    let ok = false;
    try { ok = await send(batches[i]); } catch { ok = false; }
    if (!ok) return { sent, failedAt: i };
    sent += batches[i].length;
  }
  return { sent, failedAt: null };
}

// 1回の取り込みの記事数。サーバーの上限（1,000件）より小さくし、1回の処理時間を抑える。
export const IMPORT_CHUNK = 250;

// 既知の項目だけにし、本文は外す。古い文書の未知の項目で取り込みが400になり続けないようにする。
const importArticle = (article: Article): Article => {
  const copy = toArticle(article);
  delete copy.content;
  delete copy.contentFetchedAt;
  return copy;
};

/**
 * 移行で送る POST /api/articles/import の本文。記事を size 件ずつに分け、それぞれの記事の既読を添える。本文は送らない。
 * 本体の無い既読IDは、記事の無い取り込みとして1,000件ずつ後ろに足す。
 */
export function importRequests(payload: { articles: Article[]; read: string[] }, size = IMPORT_CHUNK): ImportRequest[] {
  const read = new Set(payload.read);
  const articleIds = new Set(payload.articles.map(article => article.id));
  const withArticles = chunk(payload.articles, size).map(articles => ({
    articles: articles.map(importArticle),
    read: articles.filter(article => read.has(article.id)).map(article => article.id),
  }));
  const orphans = [...read].filter(id => !articleIds.has(id));
  return [...withArticles, ...chunk(orphans, MAX_READ_BATCH).map(ids => ({ articles: [], read: ids }))];
}
