import type { AIError } from '../../ai.ts';
import { readLimitedText } from '../../http.ts';
import { providerFailure } from '../provider-error.ts';
import type { AIProvider, StructuredRequest, StructuredResult } from '../types.ts';
import { MAX_ERROR_BYTES, invalidOutput, readEnvelope } from './shared.ts';

// The error body is only used to classify the failure; it never reaches the user.
async function classifyFailure(response: Response, model: string): Promise<AIError> {
  const failure = (kind: Parameters<typeof providerFailure>[0]) => providerFailure(kind, 'openrouter', model);
  if (response.status === 429) { await response.body?.cancel(); return failure('rate_limited'); }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return failure('provider_error'); }
  let message = '';
  try {
    const parsed = JSON.parse(await readLimitedText(response.body, response.headers.get('content-length'), MAX_ERROR_BYTES));
    if (typeof parsed?.error?.message === 'string') message = parsed.error.message.toLowerCase();
  } catch { await response.body?.cancel().catch(() => {}); }
  if (response.status === 400 || response.status === 404) {
    if (message.includes('context length')) return failure('input_too_long');
    if (message.includes('reasoning')) return failure('unsupported_effort');
    if (message.includes('model')) return failure('invalid_model');
  }
  return failure('provider_error');
}

export function createOpenRouterProvider(options: { apiKey: string; fetcher?: typeof fetch }): AIProvider {
  return {
    id: 'openrouter',
    async generate(request: StructuredRequest): Promise<StructuredResult> {
      // Workers supports manual/follow only. Reject 3xx below without forwarding credentials.
      const response = await (options.fetcher ?? fetch)('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', redirect: 'manual', signal: request.signal,
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model: request.model, max_tokens: request.maxOutputTokens,
          messages: [{ role: 'system', content: request.instructions }, { role: 'user', content: request.input }],
          response_format: { type: 'json_schema', json_schema: { name: request.schemaName, strict: true, schema: request.schema } },
          provider: { require_parameters: true },
          ...(request.effort === 'auto' ? {} : { reasoning: { effort: request.effort } }),
        }),
      });
      if (!response.ok) throw await classifyFailure(response, request.model);
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw invalidOutput('not_json_response'); }
      const envelope = await readEnvelope(response) as { choices?: unknown };
      const choice = Array.isArray(envelope?.choices) ? envelope.choices[0] as { finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } } | undefined : undefined;
      if (!choice || typeof choice !== 'object') throw invalidOutput('no_choice');
      if (typeof choice.message?.refusal === 'string') return { kind: 'refused' };
      if (choice.finish_reason === 'length') return { kind: 'incomplete' };
      if (typeof choice.message?.content !== 'string') throw invalidOutput('no_content');
      try { return { kind: 'ok', json: JSON.parse(choice.message.content) }; } catch { throw invalidOutput('output_not_json'); }
    },
  };
}
