import assert from 'node:assert/strict';
import test from 'node:test';
import { AIError } from '../lib/ai.ts';
import { createOpenAIProvider } from '../lib/ai/providers/openai.ts';
import { resultSchema } from '../lib/ai/schema.ts';
import type { StructuredRequest } from '../lib/ai/types.ts';

const base = (over: Partial<StructuredRequest> = {}): StructuredRequest => ({ model: 'gpt-test', effort: 'medium', instructions: '指示', input: '{"a":1}', schemaName: 'folio_ask', schema: resultSchema('ask'), maxOutputTokens: 16000, signal: new AbortController().signal, ...over });
const completed = (text: string) => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const provider = (fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => createOpenAIProvider({ apiKey: 'sk-key', fetcher: fetcher as typeof fetch });
const fails = (p: ReturnType<typeof provider>, code: string, status: number, request = base()) => assert.rejects(p.generate(request), (e: unknown) => e instanceof AIError && e.code === code && e.status === status && !e.message.includes('sk-secret') && !e.message.includes('sk-key'));

test('Responses APIへserver輸送し、非保存・strict schema・requestのモデルを指定する', async () => {
  let calls = 0;
  const p = provider(async (input, init) => {
    calls++;
    assert.equal(String(input), 'https://api.openai.com/v1/responses');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer sk-key');
    assert.equal(init?.redirect, 'manual');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false); assert.equal(body.model, 'gpt-test'); assert.equal(body.text.format.strict, true); assert.equal(body.text.format.name, 'folio_ask');
    assert.equal(body.instructions, '指示'); assert.equal(body.input[0].content[0].text, '{"a":1}');
    assert.deepEqual(body.reasoning, { effort: 'medium' }); assert.equal(body.max_output_tokens, 16000); assert.ok(init?.signal);
    return completed('{"kind":"ask"}');
  });
  assert.deepEqual(await p.generate(base()), { kind: 'ok', json: { kind: 'ask' } });
  assert.equal(calls, 1);
});
test('effort autoではreasoningを送らず、max_output_tokensはrequestの値', async () => {
  const p = provider(async (_i, init) => {
    const body = JSON.parse(String(init?.body));
    assert.ok(!('reasoning' in body)); assert.equal(body.max_output_tokens, 32000);
    return completed('{}');
  });
  await p.generate(base({ effort: 'auto', maxOutputTokens: 32000 }));
});
const errorResponse = (status: number, body: unknown) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
test('エラー応答を分類する', async () => {
  await fails(provider(errorResponse(400, { error: { code: 'context_length_exceeded', message: 'sk-secret' } })), 'input_too_long', 413);
  await fails(provider(errorResponse(400, { error: { param: 'reasoning.effort', message: 'sk-secret' } })), 'unsupported_effort', 400);
  await fails(provider(errorResponse(404, { error: { message: 'sk-secret' } })), 'invalid_model', 400);
  await fails(provider(errorResponse(400, { error: { code: 'model_not_found', message: 'sk-secret' } })), 'invalid_model', 400);
  await fails(provider(errorResponse(429, { error: { message: 'sk-secret' } })), 'rate_limited', 429);
  await fails(provider(errorResponse(500, { error: { message: 'sk-secret' } })), 'provider_error', 502);
  await fails(provider(errorResponse(400, 'not json sk-secret')), 'provider_error', 502);
});
test('メッセージに提供元とモデルを含み、応答本文は含まない', async () => {
  await assert.rejects(provider(errorResponse(404, { error: { message: 'sk-secret' } })).generate(base()), (e: unknown) => e instanceof AIError && e.message === '選んだモデルを確認してください（提供元：OpenAI、モデル：gpt-test）');
});
test('redirectには追従せず、認証情報を別URLへ送らない', async () => {
  let calls = 0;
  await fails(provider(async () => { calls++; return new Response(null, { status: 307, headers: { location: 'https://example.com/untrusted' } }); }), 'provider_error', 502);
  assert.equal(calls, 1);
});
test('incomplete・refusalを区別し、不正な応答はAIErrorにする', async () => {
  assert.deepEqual(await provider(async () => Response.json({ status: 'incomplete', output: [] })).generate(base()), { kind: 'incomplete' });
  assert.deepEqual(await provider(async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] })).generate(base()), { kind: 'refused' });
  for (const fetcher of [async () => new Response('not json', { headers: { 'content-type': 'application/json' } }), async () => new Response('{}', { headers: { 'content-type': 'text/html' } }), async () => completed('not json')])
    await assert.rejects(provider(fetcher).generate(base()), AIError);
});
test('2MiBを超える応答はAIErrorにする', async () => {
  await assert.rejects(provider(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })).generate(base()), (e: unknown) => e instanceof AIError && e.status === 502);
});
