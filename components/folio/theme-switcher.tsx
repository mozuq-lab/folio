'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../../hooks/use-theme';
import type { ThemePreference } from '../../lib/theme';
import './theme-switcher.css';

const OPTIONS: { value: ThemePreference; label: string; detail: string; Icon: typeof Sun }[] = [
  { value: 'system', label: '自動', detail: '端末の設定に合わせる', Icon: Monitor },
  { value: 'light', label: 'ライト', detail: '明るい配色', Icon: Sun },
  { value: 'dark', label: 'ダーク', detail: '暗い配色', Icon: Moon },
];

/** 配色の切り替え（設定画面の「配色」）。選んだ値はこの端末にだけ保存する（同期しない）。 */
export function ThemeSwitcher() {
  const [theme, setTheme] = useTheme();
  return <section className="theme-switcher" aria-labelledby="theme-switcher-label">
    <h3 className="field-heading" id="theme-switcher-label">配色</h3>
    <p className="theme-switcher-note">選んだ配色はこの端末にだけ保存し、同期しません。</p>
    {/* 選択中の見た目は data-theme-value と <html data-theme> の組み合わせでCSSが決める（theme-switcher.css）。 */}
    <div className="theme-options" role="group" aria-labelledby="theme-switcher-label">{OPTIONS.map(({ value, label, detail, Icon }) => <button key={value} type="button" data-theme-value={value} aria-pressed={theme === value} onClick={() => setTheme(value)}>
      <Icon size={18} aria-hidden="true"/><strong>{label}</strong><small>{detail}</small>
    </button>)}</div>
  </section>;
}
