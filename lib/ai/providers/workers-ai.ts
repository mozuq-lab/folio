import { AIError } from '../../ai.ts';
import { providerFailure } from '../provider-error.ts';
import type { AIProvider, StructuredRequest, StructuredResult } from '../types.ts';
import { invalidOutput } from './shared.ts';

export type WorkersAIBinding = { run(model: string, input: unknown, options?: unknown): Promise<unknown> };

// error.message is only used for classification, never shown.
function classify(error: unknown, model: string): AIError {
  if (error instanceof AIError) return error;
  const message = error instanceof Error ? error.message : '';
  if (message.includes("JSON Mode couldn't be met")) return invalidOutput('json_mode');
  if (/no such model|model not found|unknown model|invalid model/i.test(message)) return providerFailure('invalid_model', 'workers-ai', model);
  return providerFailure('provider_error', 'workers-ai', model);
}

// Workers AI returns either { response } (e.g. Llama) or the OpenAI chat-completions shape { choices: [{ message: { content } }] }
// (e.g. DeepSeek). Only the final content is read; reasoning text is ignored.
function contentOf(result: unknown): { content: unknown; truncated: boolean } {
  if (!result || typeof result !== 'object') return { content: undefined, truncated: false };
  const record = result as { response?: unknown; choices?: unknown };
  if (record.response !== undefined) return { content: record.response, truncated: false };
  const choice = Array.isArray(record.choices) ? record.choices[0] as { finish_reason?: unknown; message?: { content?: unknown } } | undefined : undefined;
  return { content: choice?.message?.content, truncated: choice?.finish_reason === 'length' };
}

// The content may be an object, a JSON string, or a string wrapped in a code fence.
function parseResponse(response: unknown): unknown {
  if (response && typeof response === 'object') return response;
  if (typeof response !== 'string') throw invalidOutput('no_content');
  const text = response.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '').trim();
  try { return JSON.parse(text); } catch { throw invalidOutput('output_not_json'); }
}

// The binding takes no AbortSignal, so race the call against the signal to let runAI's timeout take effect.
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = () => signal.reason ?? new DOMException('aborted', 'AbortError');
  if (signal.aborted) { promise.catch(() => {}); return Promise.reject(reason()); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason());
    signal.addEventListener('abort', onAbort, { once: true });
    // A late rejection after abort is swallowed by the already-settled outer promise.
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function createWorkersAIProvider(options: { ai: WorkersAIBinding }): AIProvider {
  return {
    id: 'workers-ai',
    async generate(request: StructuredRequest): Promise<StructuredResult> {
      let result: unknown;
      try {
        result = await raceAbort(options.ai.run(request.model, {
          messages: [{ role: 'system', content: request.instructions }, { role: 'user', content: request.input }],
          response_format: { type: 'json_schema', json_schema: request.schema },
          max_tokens: request.maxOutputTokens,
        }), request.signal);
      } catch (error) {
        // Abort/timeout is owned by runAI; let it surface as-is.
        if (request.signal.aborted) throw error;
        throw classify(error, request.model);
      }
      const { content, truncated } = contentOf(result);
      if (truncated) return { kind: 'incomplete' };
      return { kind: 'ok', json: parseResponse(content) };
    },
  };
}
