'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../../hooks/use-theme';
import type { ThemePreference } from '../../lib/theme';
import './theme-switcher.css';

const OPTIONS: { value: ThemePreference; label: string; detail?: string; Icon: typeof Sun }[] = [
  { value: 'system', label: '自動', detail: '端末の設定に合わせる', Icon: Monitor },
  { value: 'light', label: 'ライト', Icon: Sun },
  { value: 'dark', label: 'ダーク', Icon: Moon },
];

/** 配色の切り替え。選んだ値はこの端末にだけ保存する（同期しない）。 */
export function ThemeSwitcher() {
  const [theme, setTheme] = useTheme();
  return <div className="theme-switcher" role="group" aria-labelledby="theme-switcher-label">
    <span className="theme-switcher-label" id="theme-switcher-label">配色</span>
    <div className="theme-options">{OPTIONS.map(({ value, label, detail, Icon }) => <button key={value} type="button" className={theme === value ? 'active' : undefined} aria-pressed={theme === value} title={detail ?? label} onClick={() => setTheme(value)}>
      <Icon size={13} aria-hidden="true"/><span>{label}</span>{detail && <span className="visually-hidden">（{detail}）</span>}
    </button>)}</div>
  </div>;
}
