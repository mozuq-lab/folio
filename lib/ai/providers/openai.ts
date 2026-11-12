import { AIError } from '../../ai.ts';
import { readLimitedText } from '../../http.ts';
import { providerFailure } from '../provider-error.ts';
import { MAX_ERROR_BYTES, invalidOutput, readEnvelope } from './shared.ts';
import type { AIProvider, StructuredRequest, StructuredResult } from '../types.ts';

// The error body is only used to classify the failure; it never reaches the user.
async function classifyFailure(response: Response, model: string): Promise<AIError> {
  const failure = (kind: Parameters<typeof providerFailure>[0]) => providerFailure(kind, 'openai', model);
  if (response.status === 429) { await response.body?.cancel(); return failure('rate_limited'); }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return failure('provider_error'); }
  let error: { code?: unknown; param?: unknown } = {};
  try {
    const parsed = JSON.parse(await readLimitedText(response.body, response.headers.get('content-length'), MAX_ERROR_BYTES));
    if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object') error = parsed.error;
  } catch { await response.body?.cancel().catch(() => {}); }
  if (response.status === 404 || error.code === 'model_not_found') return failure('invalid_model');
  if (response.status === 400) {
    if (error.code === 'context_length_exceeded') return failure('input_too_long');
    if (error.param === 'reasoning.effort' || error.param === 'reasoning') return failure('unsupported_effort');
  }
  return failure('provider_error');
}

export function createOpenAIProvider(options: { apiKey: string; fetcher?: typeof fetch }): AIProvider {
  return {
    id: 'openai',
    async generate(request: StructuredRequest): Promise<StructuredResult> {
      // Workers supports manual/follow only. Reject 3xx below without forwarding credentials.
      const response = await (options.fetcher ?? fetch)('https://api.openai.com/v1/responses', {
        method: 'POST', redirect: 'manual', signal: request.signal,
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model: request.model, store: false, instructions: request.instructions,
          input: [{ role: 'user', content: [{ type: 'input_text', text: request.input }] }],
          ...(request.effort === 'auto' ? {} : { reasoning: { effort: request.effort } }),
          max_output_tokens: request.maxOutputTokens,
          text: { format: { type: 'json_schema', name: request.schemaName, strict: true, schema: request.schema } },
        }),
      });
      if (!response.ok) throw await classifyFailure(response, request.model);
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw invalidOutput('not_json_response'); }
      const envelope = await readEnvelope(response) as { status?: unknown; output?: unknown };
      if (!envelope || envelope.status !== 'completed' || !Array.isArray(envelope.output)) return { kind: 'incomplete' };
      const messages = envelope.output.filter((item: unknown) => !!item && typeof item === 'object' && (item as { type?: unknown }).type === 'message') as { content?: unknown }[];
      const parts = messages.flatMap(message => Array.isArray(message.content) ? message.content : []) as { type?: unknown; text?: unknown }[];
      if (parts.some(part => part.type === 'refusal')) return { kind: 'refused' };
      const output = parts.filter(part => part.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('');
      try { return { kind: 'ok', json: JSON.parse(output) }; } catch { throw invalidOutput('output_not_json'); }
    },
  };
}
