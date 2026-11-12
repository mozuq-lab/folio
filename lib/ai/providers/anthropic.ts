import Anthropic from '@anthropic-ai/sdk';
import { AIError } from '../../ai.ts';
import { providerFailure } from '../provider-error.ts';
import { stripUnsupportedForClaude } from '../schema.ts';
import type { AIProvider, StructuredRequest, StructuredResult } from '../types.ts';
import { invalidOutput } from './shared.ts';

// error.message carries the upstream body: it is only used for classification, never shown.
function classify(error: unknown, model: string): AIError {
  const failure = (kind: Parameters<typeof providerFailure>[0]) => providerFailure(kind, 'anthropic', model);
  if (error instanceof AIError) return error;
  if (error instanceof Anthropic.NotFoundError) return failure('invalid_model');
  if (error instanceof Anthropic.RateLimitError) return failure('rate_limited');
  if (error instanceof Anthropic.BadRequestError) {
    const message = String(error.message).toLowerCase();
    if (message.includes('prompt is too long')) return failure('input_too_long');
    if (message.includes('effort')) return failure('unsupported_effort');
  }
  return failure('provider_error');
}

export function createAnthropicProvider(options: { apiKey: string; fetch?: typeof fetch }): AIProvider {
  const client = new Anthropic({ apiKey: options.apiKey, fetch: options.fetch, maxRetries: 0 });
  return {
    id: 'anthropic',
    async generate(request: StructuredRequest): Promise<StructuredResult> {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: request.model, max_tokens: request.maxOutputTokens, system: request.instructions,
          messages: [{ role: 'user', content: request.input }],
          output_config: {
            format: { type: 'json_schema', schema: stripUnsupportedForClaude(request.schema) },
            ...(request.effort === 'auto' || request.effort === 'none' ? {} : { effort: request.effort }),
          },
        }, { signal: request.signal });
      } catch (error) {
        // Abort/timeout is owned by runAI; let it surface as-is.
        if (request.signal.aborted) throw error;
        throw classify(error, request.model);
      }
      if (message.stop_reason === 'refusal') return { kind: 'refused' };
      if (message.stop_reason === 'max_tokens') return { kind: 'incomplete' };
      const output = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
      try { return { kind: 'ok', json: JSON.parse(output) }; } catch { throw invalidOutput('output_not_json'); }
    },
  };
}
