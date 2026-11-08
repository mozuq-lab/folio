'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { ARTICLE_LAYOUT_KEY, DEFAULT_ARTICLE_LAYOUT, parseArticleLayout, type ArticleLayout } from '../lib/article-layout.ts';

const CHANGE_EVENT = 'folio:article-layout';
// Fallback when localStorage is unavailable (private mode, blocked site data).
let memory: ArticleLayout | null = null;

function read(): ArticleLayout {
  try {
    const raw = window.localStorage.getItem(ARTICLE_LAYOUT_KEY);
    return raw === null && memory ? memory : parseArticleLayout(raw);
  } catch { return memory ?? DEFAULT_ARTICLE_LAYOUT; }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === ARTICLE_LAYOUT_KEY) onChange(); };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(CHANGE_EVENT, onChange); };
}

/** The article list layout, remembered on this device. Server render uses the default. */
export function useArticleLayout(): [ArticleLayout, (layout: ArticleLayout) => void] {
  const layout = useSyncExternalStore(subscribe, read, () => DEFAULT_ARTICLE_LAYOUT);
  const setLayout = useCallback((next: ArticleLayout) => {
    memory = next;
    try { window.localStorage.setItem(ARTICLE_LAYOUT_KEY, next); } catch { /* Private mode: the in-memory fallback keeps it for this session. */ }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [layout, setLayout];
}
