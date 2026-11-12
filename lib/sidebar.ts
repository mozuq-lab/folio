/** 閉じているフォルダ（カテゴリ名）。端末ごとにlocalStorageへ保存する（同期しない）。 */
export const COLLAPSED_FOLDERS_KEY = 'folio.collapsedFolders';

export function parseCollapsedFolders(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '');
    return Array.isArray(value) && value.length <= 1000 ? [...new Set(value.filter((item): item is string => typeof item === 'string'))] : [];
  } catch { return []; }
}

/** 分類の名前を変えたときに、閉じた状態を新しい名前へ引き継ぐ。 */
export function renameCollapsedFolder(collapsed: string[], from: string, to: string): string[] {
  return collapsed.map(name => name === from ? to : name);
}

export function toggleFolder(collapsed: string[], folder: string): string[] {
  return collapsed.includes(folder) ? collapsed.filter(name => name !== folder) : [...collapsed, folder];
}

const VIEWS = new Set(['for-you', 'digest', 'notebook', 'explore', 'all', 'saved']);

/** 表示を開くURL。中クリックやコンテキストメニューから別タブで開けるように、リンクの href に使う。 */
export function viewHref(view: string): string {
  return view === 'for-you' ? '/' : `/?view=${encodeURIComponent(view)}`;
}

const FOLDER_PREFIX = 'folder:';

/** 分類（「未分類」を含む）の記事を並べる表示。 */
export function folderView(name: string): string {
  return FOLDER_PREFIX + name;
}

/** 分類の表示なら分類名、それ以外は null。 */
export function folderOfView(view: string): string | null {
  return view.startsWith(FOLDER_PREFIX) ? view.slice(FOLDER_PREFIX.length) : null;
}

/** 分類の名前を変えたとき、その分類を表示していれば新しい名前の表示にする。 */
export function renameFolderView(view: string, from: string, to: string): string {
  return view === folderView(from) ? folderView(to) : view;
}

/** URLの ?view= を表示に戻す。知らない値は null。フィードIDや分類の存在はここでは確かめない。 */
export function parseViewParam(raw: string | null): string | null {
  if (!raw) return null;
  if (VIEWS.has(raw)) return raw;
  if (/^feed:[^\s]{1,200}$/.test(raw)) return raw;
  return /^folder:[^\r\n]{1,200}$/.test(raw) ? raw : null;
}

/**
 * 表示する画面。選んだ表示、URLの表示、For You の順に使う。
 * 購読していないフィードと、無い分類（folders はサイドバーに出す分類の名前）は For You に戻す。
 * ただし購読一覧を読み込むまでは、URLのフィードや分類を捨てない。
 */
export function resolveView(chosen: string | null, fromUrl: string | null, feeds: { id: string }[], ready: boolean, folders: string[] = []): string {
  const requested = chosen ?? fromUrl ?? 'for-you';
  if (!ready) return requested;
  if (requested.startsWith('feed:') && !feeds.some(feed => `feed:${feed.id}` === requested)) return 'for-you';
  const folder = folderOfView(requested);
  return folder !== null && !folders.includes(folder) ? 'for-you' : requested;
}

const searchable = (value: string) => value.normalize('NFKC').toLowerCase();

/** フィードの管理の検索。フィード名かURLの一部で絞り込む（大文字小文字・全角半角を区別しない）。空なら全部。 */
export function filterFeeds<T extends { name: string; url: string }>(feeds: T[], query: string): T[] {
  const term = searchable(query.trim());
  return term ? feeds.filter(feed => searchable(feed.name).includes(term) || searchable(feed.url).includes(term)) : feeds;
}
