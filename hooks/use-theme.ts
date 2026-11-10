'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { DEFAULT_THEME, THEME_KEY, currentTheme, themeAttribute, type ThemePreference } from '../lib/theme.ts';

const CHANGE_EVENT = 'folio:theme';
// A choice that could not be written to localStorage (private mode, blocked site data, storage full).
// Kept only while unsaved, so an older stored value never overrides what the screen shows.
let unsaved: ThemePreference | null = null;

function read(): ThemePreference {
  try { return currentTheme(window.localStorage.getItem(THEME_KEY), unsaved); } catch { return unsaved ?? DEFAULT_THEME; }
}

function apply(theme: ThemePreference) {
  const value = themeAttribute(theme);
  if (value) document.documentElement.setAttribute('data-theme', value);
  else document.documentElement.removeAttribute('data-theme');
}

function subscribe(onChange: () => void): () => void {
  // Another tab changed the palette: follow it here too.
  const onStorage = (event: StorageEvent) => { if (event.key === THEME_KEY) { unsaved = null; apply(read()); onChange(); } };
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
    try { window.localStorage.setItem(THEME_KEY, next); unsaved = null; } catch { unsaved = next; /* Kept in memory for this session. */ }
    apply(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [theme, setTheme];
}
