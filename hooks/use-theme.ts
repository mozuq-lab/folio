'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { DEFAULT_THEME, THEME_KEY, parseTheme, themeAttribute, type ThemePreference } from '../lib/theme.ts';

const CHANGE_EVENT = 'folio:theme';
// Fallback when localStorage is unavailable (private mode, blocked site data).
let memory: ThemePreference | null = null;

function read(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    return raw === null && memory ? memory : parseTheme(raw);
  } catch { return memory ?? DEFAULT_THEME; }
}

function apply(theme: ThemePreference) {
  const value = themeAttribute(theme);
  if (value) document.documentElement.setAttribute('data-theme', value);
  else document.documentElement.removeAttribute('data-theme');
}

function subscribe(onChange: () => void): () => void {
  // Another tab changed the palette: follow it here too.
  const onStorage = (event: StorageEvent) => { if (event.key === THEME_KEY) { apply(read()); onChange(); } };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(CHANGE_EVENT, onChange); };
}

/**
 * The palette, remembered on this device. Server render uses the default.
 * The attribute on <html> is set before the first paint by the script in app/layout.tsx;
 * this hook only changes it when the choice changes, so hydration never resets it.
 */
export function useTheme(): [ThemePreference, (theme: ThemePreference) => void] {
  const theme = useSyncExternalStore(subscribe, read, () => DEFAULT_THEME);
  const setTheme = useCallback((next: ThemePreference) => {
    memory = next;
    try { window.localStorage.setItem(THEME_KEY, next); } catch { /* Private mode: the in-memory fallback keeps it for this session. */ }
    apply(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [theme, setTheme];
}
