'use client';
import { useId, useState } from 'react';
import { Cpu } from 'lucide-react';
import { MODEL_ID_PATTERN, PROVIDER_IDS, PROVIDERS } from '@/lib/ai/types';
import type { Effort, ProviderId, ProviderStatus } from '@/lib/ai/types';
import { effectiveSelection, updateEffort, resolveModelDraft, updateModel, updateProvider } from '@/lib/ai-settings';
import type { AISettings } from '@/lib/intelligence-types';

const effortLabel = (effort: Effort): string => effort === 'auto' ? 'モデルに任せる' : effort;

export function AISettingsEditor({ statuses, settings, onChange }: { statuses: ProviderStatus[]; settings: AISettings | undefined; onChange: (settings: AISettings) => void }) {
  const id = useId();
  const [draft, setDraft] = useState<{ provider: ProviderId; value: string } | null>(null);
  // Statuses may still be loading (or failed); fall back to the saved choice so it stays editable.
  const selection = effectiveSelection(settings, statuses);
  const provider = selection?.provider ?? settings?.provider;
  const model = selection?.model ?? (provider ? settings?.models[provider] ?? PROVIDERS[provider].defaultModel : '');
  const effort = selection?.effort ?? (provider ? settings?.efforts[provider] ?? PROVIDERS[provider].defaultEffort : 'auto');
  const apply = (next: AISettings | undefined) => { if (next && next !== settings) onChange(next); };
  // Commit only on blur, Enter or datalist selection; an invalid draft reverts to the saved model.
  const commit = (target: ProviderId, value: string) => { const next = resolveModelDraft(value, model); if (next !== model) apply(updateModel(settings, target, next)); setDraft(null); };
  const modelValue = provider && draft?.provider === provider ? draft.value : model;
  return <section className="ai-settings" aria-labelledby={`${id}-title`}>
    <div className="natural-title"><Cpu size={16}/><h3 id={`${id}-title`}>AIの提供元とモデル</h3></div>
    <div className="ai-provider-options" role="radiogroup" aria-label="AIの提供元">{PROVIDER_IDS.map(item => {
      const status = statuses.find(s => s.id === item);
      const unavailable = status && !status.available;
      return <button key={item} type="button" role="radio" aria-checked={provider === item} className={provider === item ? 'chosen' : ''} onClick={() => { setDraft(null); apply(updateProvider(settings, item)); }}>
        <span>{PROVIDERS[item].label}</span>{unavailable && <small>{status.reason ?? (item === 'workers-ai' ? 'この環境では使えません' : 'キー未設定')}</small>}
      </button>;
    })}</div>
    {provider && <div className="ai-settings-fields">
      <label className="ai-settings-field"><span>モデル</span><input list={`${id}-models`} value={modelValue} maxLength={200} spellCheck={false} autoComplete="off" aria-invalid={!MODEL_ID_PATTERN.test(modelValue.trim())} onChange={e => { const value = e.target.value; setDraft({ provider, value }); if (value === PROVIDERS[provider].defaultModel) commit(provider, value); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(provider, modelValue); } }} onBlur={() => commit(provider, modelValue)}/>
        <datalist id={`${id}-models`}><option value={PROVIDERS[provider].defaultModel}/></datalist></label>
      {provider !== 'workers-ai' && <label className="ai-settings-field"><span>推論の深さ</span><div className="ai-effort-row"><select value={effort} onChange={e => apply(updateEffort(settings, provider, e.target.value as Effort))}>{PROVIDERS[provider].efforts.map(value => <option key={value} value={value}>{effortLabel(value)}</option>)}</select><small>深いほど時間と費用がかかります</small></div></label>}
    </div>}
  </section>;
}
