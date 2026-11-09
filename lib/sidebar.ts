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
