/** 閉じているフォルダ（カテゴリ名）。端末ごとにlocalStorageへ保存する（同期しない）。 */
export const COLLAPSED_FOLDERS_KEY = 'folio.collapsedFolders';

export function parseCollapsedFolders(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '');
    return Array.isArray(value) && value.length <= 1000 ? [...new Set(value.filter((item): item is string => typeof item === 'string'))] : [];
  } catch { return []; }
}

export function toggleFolder(collapsed: string[], folder: string): string[] {
  return collapsed.includes(folder) ? collapsed.filter(name => name !== folder) : [...collapsed, folder];
}

const VIEWS = new Set(['for-you', 'digest', 'stories', 'notebook', 'explore', 'all', 'saved']);

/** 表示を開くURL。中クリックやコンテキストメニューから別タブで開けるように、リンクの href に使う。 */
export function viewHref(view: string): string {
  return view === 'for-you' ? '/' : `/?view=${encodeURIComponent(view)}`;
}

/** URLの ?view= を表示に戻す。知らない値は null。フィードIDの存在はここでは確かめない。 */
export function parseViewParam(raw: string | null): string | null {
  if (!raw) return null;
  if (VIEWS.has(raw)) return raw;
  return /^feed:[^\s]{1,200}$/.test(raw) ? raw : null;
}

/**
 * 表示する画面。選んだ表示、URLの表示、For You の順に使う。
 * 購読していないフィードは For You に戻す。ただし購読一覧を読み込むまでは、URLのフィードを捨てない。
 */
export function resolveView(chosen: string | null, fromUrl: string | null, feeds: { id: string }[], ready: boolean): string {
  const requested = chosen ?? fromUrl ?? 'for-you';
  return ready && requested.startsWith('feed:') && !feeds.some(feed => `feed:${feed.id}` === requested) ? 'for-you' : requested;
}

const searchable = (value: string) => value.normalize('NFKC').toLowerCase();

/** フィードの管理の検索。フィード名かURLの一部で絞り込む（大文字小文字・全角半角を区別しない）。空なら全部。 */
export function filterFeeds<T extends { name: string; url: string }>(feeds: T[], query: string): T[] {
  const term = searchable(query.trim());
  return term ? feeds.filter(feed => searchable(feed.name).includes(term) || searchable(feed.url).includes(term)) : feeds;
}
