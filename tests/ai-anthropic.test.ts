import assert from 'node:assert/strict';
import test from 'node:test';
import { AIError } from '../lib/ai.ts';
import { createAnthropicProvider } from '../lib/ai/providers/anthropic.ts';
import { resultSchema, stripUnsupportedForClaude } from '../lib/ai/schema.ts';
import type { StructuredRequest } from '../lib/ai/types.ts';

const base = (over: Partial<StructuredRequest> = {}): StructuredRequest => ({ model: 'claude-test', effort: 'medium', instructions: '指示', input: '{"a":1}', schemaName: 'folio_ask', schema: resultSchema('ask'), maxOutputTokens: 16000, signal: new AbortController().signal, ...over });
const message = (content: unknown[], stop_reason = 'end_turn') => Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
const text = (t: string) => ({ type: 'text', text: t });
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const provider = (fetcher: Fetcher) => createAnthropicProvider({ apiKey: 'sk-key', fetch: fetcher as typeof fetch });
const errorResponse = (status: number, type: string, msg: string): Fetcher => async () => Response.json({ type: 'error', error: { type, message: msg } }, { status });
const fails = (p: ReturnType<typeof provider>, code: string, status: number) => assert.rejects(p.generate(base()), (e: unknown) => e instanceof AIError && e.code === code && e.status === status && !e.message.includes('sk-secret') && !e.message.includes('sk-key'));
const KEYS = ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'];

test('stripUnsupportedForClaudeは非対応キーを再帰的に除き、元を変更しない', () => {
  const original = resultSchema('digest');
  const before = JSON.stringify(original);
  const stripped = JSON.stringify(stripUnsupportedForClaude(original));
  for (const key of KEYS) assert.ok(!stripped.includes(`"${key}"`), key);
  assert.ok(stripped.includes('"additionalProperties":false') && stripped.includes('"required"'));
  assert.equal(JSON.stringify(original), before);
  assert.ok(before.includes('"maxLength"'));
});
test('Messages APIへ送信する本文とヘッダー', async () => {
  let calls = 0;
  const failures: unknown[] = [];
  const p = provider(async (input, init) => {
    calls++;
    try { return check(input, init); } catch (e) { failures.push(e); throw e; }
  });
  const check = (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.anthropic.com/v1/messages');
    // SDK 1.6.0 sends apiKey as a Bearer token (not x-api-key).
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'claude-test'); assert.equal(body.max_tokens, 16000); assert.equal(body.system, '指示');
    assert.deepEqual(body.messages, [{ role: 'user', content: '{"a":1}' }]);
    assert.equal(body.output_config.format.type, 'json_schema'); assert.equal(body.output_config.effort, 'medium');
    assert.ok(!JSON.stringify(body.output_config.format.schema).includes('maxLength'));
    assert.ok(init?.signal);
    return message([text('{"kind":"ask"}')]);
  };
  const result = await p.generate(base()).catch(e => e);
  assert.deepEqual(failures, []);
  assert.deepEqual(result, { kind: 'ok', json: { kind: 'ask' } });
  assert.equal(calls, 1);
});
test('effort autoではeffortを送らない', async () => {
  await provider(async (_i, init) => {
    const body = JSON.parse(String(init?.body));
    assert.ok(!('effort' in body.output_config));
    return message([text('{}')]);
  }).generate(base({ effort: 'auto' }));
});
test('thinkingブロックを無視してtextを結合し、refusal・max_tokensを区別する', async () => {
  assert.deepEqual(await provider(async () => message([{ type: 'thinking', thinking: '', signature: 's' }, text('{"a":'), text('1}')])).generate(base()), { kind: 'ok', json: { a: 1 } });
  assert.deepEqual(await provider(async () => message([], 'refusal')).generate(base()), { kind: 'refused' });
  assert.deepEqual(await provider(async () => message([text('{')], 'max_tokens')).generate(base()), { kind: 'incomplete' });
  await assert.rejects(provider(async () => message([text('not json')])).generate(base()), (e: unknown) => e instanceof AIError && e.code === 'invalid_output');
});
test('エラー応答を分類し、応答本文を含めない', async () => {
  await fails(provider(errorResponse(404, 'not_found_error', 'sk-secret')), 'invalid_model', 400);
  await fails(provider(errorResponse(400, 'invalid_request_error', 'prompt is too long sk-secret')), 'input_too_long', 413);
  await fails(provider(errorResponse(400, 'invalid_request_error', 'output_config.effort not supported sk-secret')), 'unsupported_effort', 400);
  await fails(provider(errorResponse(400, 'invalid_request_error', 'other sk-secret')), 'provider_error', 502);
  await fails(provider(errorResponse(429, 'rate_limit_error', 'sk-secret')), 'rate_limited', 429);
  await fails(provider(errorResponse(500, 'api_error', 'sk-secret')), 'provider_error', 502);
  await fails(provider(async () => { throw new TypeError('sk-secret'); }), 'provider_error', 502);
});
test('メッセージに提供元とモデルを含む', async () => {
  await assert.rejects(provider(errorResponse(404, 'not_found_error', 'sk-secret')).generate(base()), (e: unknown) => e instanceof AIError && e.message === '選んだモデルを確認してください（提供元：Claude、モデル：claude-test）');
});
test('JSONとして読めない出力はreasonをoutput_not_jsonにする', async () => {
  await assert.rejects(provider(async () => message([text('not json sk-secret')])).generate(base()), (e: unknown) => e instanceof AIError && e.code === 'invalid_output' && e.reason === 'output_not_json');
});
