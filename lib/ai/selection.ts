import { PROVIDERS } from './types.ts';
import type { Effort, ProviderId, ProviderStatus } from './types.ts';

// Pure rules shared by the server and the browser. Import nothing but types here.
const AUTO_ORDER: readonly ProviderId[] = ['anthropic', 'openai', 'openrouter'];

export type Selection = { provider: ProviderId; model: string; effort: Effort; status: ProviderStatus };

export function selectProvider(request: { provider?: ProviderId; model?: string; effort?: Effort }, statuses: ProviderStatus[]): Selection | null {
  // An explicitly chosen provider is never swapped, even when unavailable.
  const status = request.provider
    ? statuses.find(item => item.id === request.provider)
    : AUTO_ORDER.map(id => statuses.find(item => item.id === id)).find(item => item?.available);
  if (!status) return null;
  return { provider: status.id, model: request.model ?? PROVIDERS[status.id].defaultModel, effort: request.effort ?? PROVIDERS[status.id].defaultEffort, status };
}
