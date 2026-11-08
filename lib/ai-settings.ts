import { MODEL_ID_PATTERN, PROVIDERS, effortBudget } from './ai/types.ts';
import type { Effort, ProviderId, ProviderStatus } from './ai/types.ts';
import { selectProvider } from './ai/selection.ts';
import type { AISettings } from './intelligence-types.ts';

// Browser-safe helpers for the AI settings UI. Never import the registry or provider SDKs here.
export type EffectiveSelection = { provider: ProviderId; model: string; effort: Effort; available: boolean; label: string };

export function effectiveSelection(settings: AISettings | undefined, statuses: ProviderStatus[]): EffectiveSelection | null {
  const request = settings ? { provider: settings.provider, model: settings.models[settings.provider], effort: settings.efforts[settings.provider] } : {};
  const selection = selectProvider(request, statuses);
  if (!selection) return null;
  return { provider: selection.provider, model: selection.model, effort: selection.effort, available: selection.status.available, label: selection.status.label };
}

export function clientTimeoutMs(effort: Effort): number {
  return effortBudget(effort).timeoutMs + 10_000;
}

const base = (settings: AISettings | undefined, provider: ProviderId): AISettings => settings ?? { provider, models: {}, efforts: {} };

export function updateProvider(settings: AISettings | undefined, provider: ProviderId): AISettings {
  return { ...base(settings, provider), provider };
}

// A rejected change returns `settings` unchanged (still undefined when nothing was saved).
export function updateModel(settings: AISettings, provider: ProviderId, model: string): AISettings;
export function updateModel(settings: AISettings | undefined, provider: ProviderId, model: string): AISettings | undefined;
export function updateModel(settings: AISettings | undefined, provider: ProviderId, model: string): AISettings | undefined {
  if (!MODEL_ID_PATTERN.test(model)) return settings;
  const current = base(settings, provider);
  return { ...current, models: { ...current.models, [provider]: model } };
}

// The model to commit when the user finishes editing: the trimmed draft if valid, otherwise the saved model.
export function resolveModelDraft(draft: string, saved: string): string {
  const value = draft.trim();
  return MODEL_ID_PATTERN.test(value) ? value : saved;
}

export function updateEffort(settings: AISettings, provider: ProviderId, effort: Effort): AISettings;
export function updateEffort(settings: AISettings | undefined, provider: ProviderId, effort: Effort): AISettings | undefined;
export function updateEffort(settings: AISettings | undefined, provider: ProviderId, effort: Effort): AISettings | undefined {
  if (!PROVIDERS[provider].efforts.includes(effort)) return settings;
  const current = base(settings, provider);
  return { ...current, efforts: { ...current.efforts, [provider]: effort } };
}
