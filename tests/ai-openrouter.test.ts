import assert from 'node:assert/strict';
import test from 'node:test';
import { AIError } from '../lib/ai.ts';
import { createOpenRouterProvider } from '../lib/ai/providers/openrouter.ts';
import { resultSchema } from '../lib/ai/schema.ts';
import type { StructuredRequest } from '../lib/ai/types.ts';

const base = (over: Partial<StructuredRequest> = {}): StructuredRequest => ({ model: 'openai/test', effort: 'medium', instructions: '指示', input: '{"a":1}', schemaName: 'folio_ask', schema: resultSchema('ask'), maxOutputTokens: 16000, signal: new AbortController().signal, ...over });
const completion = (message: Record<string, unknown>, finish = 'stop') => Response.json({ choices: [{ finish_reason: finish, message: { role: 'assistant', ...message } }] });
const provider = (fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => createOpenRouterProvider({ apiKey: 'sk-key', fetcher: fetcher as typeof fetch });
const fails = (p: ReturnType<typeof provider>, code: string, status: number, request = base()) => assert.rejects(p.generate(request), (e: unknown) => e instanceof AIError && e.code === code && e.status === status && !e.message.includes('sk-secret') && !e.message.includes('sk-key'));
const errorResponse = (status: number, message: string) => async () => new Response(JSON.stringify({ error: { message, code: status } }), { status, headers: { 'content-type': 'application/json' } });

test('chat completionsへ送る本文とヘッダー', async () => {
  let calls = 0;
  const p = provider(async (input, init) => {
    calls++;
    assert.equal(String(input), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer sk-key');
    assert.equal(init?.redirect, 'manual'); assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'openai/test'); assert.equal(body.max_tokens, 16000);
    assert.deepEqual(body.messages, [{ role: 'system', content: '指示' }, { role: 'user', content: '{"a":1}' }]);
    assert.equal(body.response_format.type, 'json_schema'); assert.equal(body.response_format.json_schema.name, 'folio_ask');
    assert.equal(body.response_format.json_schema.strict, true); assert.deepEqual(body.response_format.json_schema.schema, resultSchema('ask'));
    assert.deepEqual(body.provider, { require_parameters: true }); assert.deepEqual(body.reasoning, { effort: 'medium' });
    return completion({ content: '{"kind":"ask"}' });
  });
  assert.deepEqual(await p.generate(base()), { kind: 'ok', json: { kind: 'ask' } });
  assert.equal(calls, 1);
});
test('effort autoではreasoningを送らない', async () => {
  await provider(async (_i, init) => { assert.ok(!('reasoning' in JSON.parse(String(init?.body)))); return completion({ content: '{}' }); }).generate(base({ effort: 'auto' }));
});
test('length・refusalを区別する', async () => {
  assert.deepEqual(await provider(async () => completion({ content: '{"a' }, 'length')).generate(base()), { kind: 'incomplete' });
  assert.deepEqual(await provider(async () => completion({ content: null, refusal: 'No' })).generate(base()), { kind: 'refused' });
});
test('エラー応答を分類する', async () => {
  await fails(provider(errorResponse(400, 'maximum context length is 8192 sk-secret')), 'input_too_long', 413);
  await fails(provider(errorResponse(400, 'x is not a valid model ID sk-secret')), 'invalid_model', 400);
  await fails(provider(errorResponse(404, 'model not found sk-secret')), 'invalid_model', 400);
  await fails(provider(errorResponse(400, 'Unsupported value for reasoning.effort sk-secret')), 'unsupported_effort', 400);
  await fails(provider(errorResponse(429, 'sk-secret')), 'rate_limited', 429);
  await fails(provider(errorResponse(500, 'model sk-secret')), 'provider_error', 502);
  await fails(provider(errorResponse(400, 'other sk-secret')), 'provider_error', 502);
  await fails(provider(async () => new Response('not json sk-secret', { status: 400 })), 'provider_error', 502);
});
test('メッセージに提供元とモデルを含み、応答本文は含まない', async () => {
  await assert.rejects(provider(errorResponse(404, 'model sk-secret')).generate(base()), (e: unknown) => e instanceof AIError && e.message === '選んだモデルを確認してください（提供元：OpenRouter、モデル：openai/test）');
});
test('redirectには追従しない', async () => {
  let calls = 0;
  await fails(provider(async () => { calls++; return new Response(null, { status: 307, headers: { location: 'https://example.com/x' } }); }), 'provider_error', 502);
  assert.equal(calls, 1);
});
test('不正な応答はAIError、2MiB超も', async () => {
  for (const fetcher of [async () => new Response('not json', { headers: { 'content-type': 'application/json' } }), async () => new Response('{}', { headers: { 'content-type': 'text/html' } }), async () => Response.json({ choices: [] }), async () => completion({ content: 'not json' })])
    await assert.rejects(provider(fetcher).generate(base()), AIError);
  await assert.rejects(provider(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })).generate(base()), (e: unknown) => e instanceof AIError && e.status === 502);
});
test('abortは分類せず再throwする', async () => {
  const abort = new DOMException('aborted', 'AbortError');
  await assert.rejects(provider(async () => { throw abort; }).generate(base()), (e: unknown) => e === abort);
});
test('出力を読めなかった理由をreasonで区別する（応答本文は含めない）', async () => {
  const reason = (fetcher: () => Promise<Response>, expected: string) => assert.rejects(provider(fetcher).generate(base()), (e: unknown) => e instanceof AIError && e.code === 'invalid_output' && e.reason === expected);
  await reason(async () => completion({ content: 'not json sk-secret' }), 'output_not_json');
  await reason(async () => completion({ content: null }), 'no_content');
  await reason(async () => Response.json({ choices: [] }), 'no_choice');
});
