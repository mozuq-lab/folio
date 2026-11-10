'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { COLLAPSED_FOLDERS_KEY, parseCollapsedFolders, renameCollapsedFolder, toggleFolder } from '../lib/sidebar.ts';

const CHANGE_EVENT = 'folio:collapsed-folders';
// localStorage が使えないとき（プライベートモードなど）の代わり。
let memory: string | null = null;

function read(): string | null {
  try { return window.localStorage.getItem(COLLAPSED_FOLDERS_KEY) ?? memory; } catch { return memory; }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === COLLAPSED_FOLDERS_KEY) onChange(); };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(CHANGE_EVENT, onChange); };
}

/** サイドバーで閉じているフォルダ。この端末に保存する。サーバー描画ではすべて開いた状態。 */
function update(change: (collapsed: string[]) => string[]): void {
  const next = JSON.stringify(change(parseCollapsedFolders(read())));
  memory = next;
  try { window.localStorage.setItem(COLLAPSED_FOLDERS_KEY, next); } catch { /* プライベートモードでは、この画面を開いている間だけ覚える。 */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** サイドバーで閉じているフォルダ。この端末に保存する。サーバー描画ではすべて開いた状態。 */
export function useCollapsedFolders(): [Set<string>, (folder: string) => void, (from: string, to: string) => void] {
  const raw = useSyncExternalStore(subscribe, read, () => null);
  const collapsed = useMemo(() => new Set(parseCollapsedFolders(raw)), [raw]);
  const toggle = useCallback((folder: string) => update(list => toggleFolder(list, folder)), []);
  const rename = useCallback((from: string, to: string) => update(list => renameCollapsedFolder(list, from, to)), []);
  return [collapsed, toggle, rename];
}
