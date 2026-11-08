import { AIError } from '../ai.ts';
import type { AIRequest } from '../intelligence-types.ts';
import { createAnthropicProvider } from './providers/anthropic.ts';
import { createOpenAIProvider } from './providers/openai.ts';
import { createOpenRouterProvider } from './providers/openrouter.ts';
import { createWorkersAIProvider } from './providers/workers-ai.ts';
import type { WorkersAIBinding } from './providers/workers-ai.ts';
import { selectProvider } from './selection.ts';
import type { Selection } from './selection.ts';
import { PROVIDERS } from './types.ts';
import type { AIProvider, ProviderId, ProviderStatus } from './types.ts';

export type AIEnv = { OPENAI_API_KEY?: string; ANTHROPIC_API_KEY?: string; OPENROUTER_API_KEY?: string; AI?: WorkersAIBinding };
const KEYS = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' } as const;

export function providerStatuses(env: AIEnv, options: { dev: boolean }): ProviderStatus[] {
  return (Object.keys(PROVIDERS) as ProviderId[]).map(id => {
    const info = PROVIDERS[id];
    const usable = id === 'workers-ai' ? Boolean(env.AI) && !options.dev : Boolean(env[KEYS[id]]?.trim());
    const status: ProviderStatus = { id, label: info.label, available: usable, defaultModel: info.defaultModel, efforts: [...info.efforts], defaultEffort: info.defaultEffort };
    if (!usable) status.reason = id === 'workers-ai' ? 'この環境では使えません' : 'キー未設定';
    return status;
  });
}

export function resolveSelection(request: Pick<AIRequest, 'provider' | 'model' | 'effort'>, statuses: ProviderStatus[]): Selection {
  const selection = selectProvider(request, statuses);
  if (!selection) throw new AIError(503, 'not_configured', 'AIは未接続です。設定画面で提供元を選び、APIキーを登録してください。');
  if (!PROVIDERS[selection.provider].efforts.includes(selection.effort)) throw new AIError(400, 'invalid_effort', '選んだ提供元では、この推論の深さを指定できません。');
  return selection;
}

export function createProvider(id: ProviderId, env: AIEnv): AIProvider {
  if (id === 'workers-ai') {
    if (!env.AI) throw new AIError(503, 'not_configured', 'AIは未接続です。設定画面で提供元を選び、APIキーを登録してください。');
    return createWorkersAIProvider({ ai: env.AI });
  }
  const apiKey = env[KEYS[id]]?.trim();
  if (!apiKey) throw new AIError(503, 'not_configured', 'AIは未接続です。設定画面で提供元を選び、APIキーを登録してください。');
  return id === 'openai' ? createOpenAIProvider({ apiKey }) : id === 'anthropic' ? createAnthropicProvider({ apiKey }) : createOpenRouterProvider({ apiKey });
}
