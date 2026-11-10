'use client';

import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Download, Palette, SlidersHorizontal } from 'lucide-react';
import './settings-tabs.css';

export type SettingsTab = 'preferences' | 'appearance' | 'backup';

const TABS: { value: SettingsTab; label: string; Icon: typeof Palette }[] = [
  { value: 'preferences', label: '好み', Icon: SlidersHorizontal },
  { value: 'appearance', label: '配色', Icon: Palette },
  { value: 'backup', label: '移行・バックアップ', Icon: Download },
];

export const SETTINGS_PANEL_ID = 'settings-panel';
export const settingsTabId = (tab: SettingsTab) => `settings-tab-${tab}`;

/** 設定画面の上に並べる項目の切り替え。矢印キー・Home・Endでも移れる。 */
export function SettingsTabs({ tab, onChange }: { tab: SettingsTab; onChange: (tab: SettingsTab) => void }) {
  const refs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex(item => item.value === tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    const value = TABS[next].value;
    onChange(value);
    refs.current[value]?.focus();
  };
  return <div className="settings-tabs" role="tablist" aria-label="設定の項目" onKeyDown={move}>
    {TABS.map(({ value, label, Icon }) => <button key={value} ref={el => { refs.current[value] = el; }} type="button" role="tab" id={settingsTabId(value)} aria-selected={tab === value} aria-controls={SETTINGS_PANEL_ID} tabIndex={tab === value ? 0 : -1} onClick={() => onChange(value)}>
      <Icon size={14} aria-hidden="true"/><span>{label}</span>
    </button>)}
  </div>;
}
