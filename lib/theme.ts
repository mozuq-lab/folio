export type ThemePreference = 'system' | 'light' | 'dark';

/** Per-device preference stored in localStorage (not synced: each device has its own screen and surroundings). */
export const THEME_KEY = 'folio.theme';
export const DEFAULT_THEME: ThemePreference = 'system';
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

export function parseTheme(raw: string | null): ThemePreference {
  return raw === 'system' || raw === 'light' || raw === 'dark' ? raw : DEFAULT_THEME;
}

/** The value of `data-theme` on <html>. `null` leaves the choice to the CSS `prefers-color-scheme` query. */
export function themeAttribute(theme: ThemePreference): 'light' | 'dark' | null {
  return theme === 'system' ? null : theme;
}

/**
 * Runs in <head> before the first paint so a manual choice never flashes the other palette.
 * The default (follow the device) needs no script: the CSS media query handles it.
 */
export function themeInitScript(): string {
  return `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
}
