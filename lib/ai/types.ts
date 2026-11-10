import type { Schema } from './schema.ts';

export const PROVIDER_IDS = ['openai', 'anthropic', 'openrouter', 'workers-ai'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];
export const EFFORTS = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORTS[number];

export const PROVIDERS: Record<ProviderId, { label: string; defaultModel: string; efforts: readonly Effort[]; defaultEffort: Effort }> = {
  openai: { label: 'OpenAI', defaultModel: 'gpt-6-luna', efforts: ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  anthropic: { label: 'Claude', defaultModel: 'claude-haiku-5-5', efforts: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  openrouter: { label: 'OpenRouter', defaultModel: 'openai/gpt-6-luna', efforts: ['auto', 'none', 'low', 'medium', 'high'], defaultEffort: 'medium' },
  'workers-ai': { label: 'Workers AI', defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', efforts: ['auto'], defaultEffort: 'auto' },
};

export type ProviderStatus = { id: ProviderId; label: string; available: boolean; defaultModel: string; efforts: Effort[]; defaultEffort: Effort; reason?: string };

export const MODEL_ID_PATTERN = /^[A-Za-z0-9@/._:-]{1,200}$/;

/** 「AIで選び直す」で評価する未読記事の上限と、1回のリクエストで送る数。見出しだけを送る（lib/ai-analyze.ts）。 */
export const ANALYZE_MAX_ARTICLES = 300;
export const ANALYZE_BATCH_SIZE = 50;
/** analyze以外で1回に送れる記事の数。 */
export const MAX_REQUEST_ARTICLES = 30;

export function effortBudget(effort: Effort): { timeoutMs: number; maxOutputTokens: number } {
  if (effort === 'auto' || effort === 'none' || effort === 'low') return { timeoutMs: 90_000, maxOutputTokens: 16_000 };
  if (effort === 'medium') return { timeoutMs: 180_000, maxOutputTokens: 16_000 };
  return { timeoutMs: 240_000, maxOutputTokens: 32_000 };
}

export type StructuredRequest = { model: string; effort: Effort; instructions: string; input: string; schemaName: string; schema: Schema; maxOutputTokens: number; signal: AbortSignal };
export type StructuredResult = { kind: 'ok'; json: unknown } | { kind: 'refused' } | { kind: 'incomplete' };
export interface AIProvider { id: ProviderId; generate(request: StructuredRequest): Promise<StructuredResult>; }
