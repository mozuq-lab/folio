import assert from 'node:assert/strict';
import test from 'node:test';
import { AIError } from '../lib/ai.ts';
import { createWorkersAIProvider } from '../lib/ai/providers/workers-ai.ts';
import { resultSchema } from '../lib/ai/schema.ts';
import type { StructuredRequest } from '../lib/ai/types.ts';

const base = (over: Partial<StructuredRequest> = {}): StructuredRequest => ({ model: '@cf/test/model', effort: 'auto', instructions: '指示', input: '{"a":1}', schemaName: 'folio_ask', schema: resultSchema('ask'), maxOutputTokens: 16000, signal: new AbortController().signal, ...over });
const provider = (run: (model: string, input: unknown, options?: unknown) => Promise<unknown>) => createWorkersAIProvider({ ai: { run } });
const fails = (p: ReturnType<typeof provider>, code: string, status: number) => assert.rejects(p.generate(base()), (e: unknown) => e instanceof AIError && e.code === code && e.status === status && !e.message.includes('sk-secret'));

test('ai.runへ送る内容にeffortやreasoningを含めない', async () => {
  let calls = 0;
  const p = provider(async (model, input) => {
    calls++;
    assert.equal(model, '@cf/test/model');
    assert.deepEqual(input, { messages: [{ role: 'system', content: '指示' }, { role: 'user', content: '{"a":1}' }], response_format: { type: 'json_schema', json_schema: resultSchema('ask') }, max_tokens: 16000 });
    return { response: { kind: 'ask' } };
  });
  assert.deepEqual(await p.generate(base({ effort: 'medium' })), { kind: 'ok', json: { kind: 'ask' } });
  assert.equal(calls, 1);
});
test('responseがオブジェクト・JSON文字列・json囲み文字列のどれでも同じに解釈する', async () => {
  for (const response of [{ kind: 'ask' }, '{"kind":"ask"}', '```json\n{"kind":"ask"}\n```', '```\n{"kind":"ask"}\n```'])
    assert.deepEqual(await provider(async () => ({ response })).generate(base()), { kind: 'ok', json: { kind: 'ask' } });
});
test('parseできない・空のresponseはinvalid_output', async () => {
  for (const result of [{ response: 'not json sk-secret' }, { response: '```json\nbroken\n```' }, {}, null, { response: null }])
    await fails(provider(async () => result), 'invalid_output', 502);
});
test('JSON Mode失敗はinvalid_output、他は分類する', async () => {
  await fails(provider(async () => { throw new Error("JSON Mode couldn't be met sk-secret"); }), 'invalid_output', 502);
  await fails(provider(async () => { throw new Error('No such model @cf/x: model not found sk-secret'); }), 'invalid_model', 400);
  await fails(provider(async () => { throw new Error('boom sk-secret'); }), 'provider_error', 502);
  await fails(provider(async () => { throw new Error('The model is overloaded sk-secret'); }), 'provider_error', 502);
  for (const message of ['unknown model x', 'Invalid model id', 'model not found']) await fails(provider(async () => { throw new Error(message); }), 'invalid_model', 400);
  await fails(provider(async () => { throw 'sk-secret'; }), 'provider_error', 502);
});
test('メッセージに提供元とモデルを含み、Errorのmessageは含まない', async () => {
  await assert.rejects(provider(async () => { throw new Error('no such model sk-secret'); }).generate(base()), (e: unknown) => e instanceof AIError && e.message === '選んだモデルを確認してください（提供元：Workers AI、モデル：@cf/test/model）');
});
test('abortは分類せず再throwする', async () => {
  const abort = new DOMException('aborted', 'AbortError'); const controller = new AbortController(); controller.abort(abort);
  await assert.rejects(provider(async () => { throw abort; }).generate(base({ signal: controller.signal })), (e: unknown) => e === abort);
});
test('signalのabortで、応答しないai.runを中断する', async () => {
  const controller = new AbortController();
  const pending = provider(() => new Promise(() => {})).generate(base({ signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof Error && e.name === 'AbortError');
  const already = new AbortController(); already.abort();
  await assert.rejects(provider(() => new Promise(() => {})).generate(base({ signal: already.signal })), (e: unknown) => e instanceof Error && e.name === 'AbortError');
});
test('runAIのタイムアウトで応答しないWorkers AIは504 timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runAI } = await import('../lib/ai.ts');
  const article = { id: 'a', title: 't', description: 'd', url: 'https://example.com', sourceId: 's', sourceName: 'n', publishedAt: '2026-01-01', tags: [], readingMinutes: 1 };
  const pending = runAI({ action: 'ask', question: 'q', articles: [article] }, { provider: provider(() => new Promise(() => {})), model: '@cf/x', effort: 'auto' });
  const check = assert.rejects(pending, (e: unknown) => e instanceof AIError && e.status === 504 && e.code === 'timeout');
  await Promise.resolve();
  t.mock.timers.tick(90_000);
  await check;
});
test('OpenAI互換の形（choices[0].message.content）で返すモデルの出力も読む', async () => {
  const chat = (content: unknown, finish = 'stop') => ({ id: 'x', object: 'chat.completion', choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, reasoning_content: '考えた過程 sk-secret' } }], usage: {} });
  for (const content of ['{"kind":"ask"}', '```json\n{"kind":"ask"}\n```', { kind: 'ask' }])
    assert.deepEqual(await provider(async () => chat(content)).generate(base()), { kind: 'ok', json: { kind: 'ask' } });
  // 出力の上限で途中で切れたときは「途中で終わった」として扱う。
  assert.deepEqual(await provider(async () => chat('{"kind":"as', 'length')).generate(base()), { kind: 'incomplete' });
  for (const result of [chat('not json sk-secret'), chat(null), { choices: [] }, { choices: 'x' }])
    await fails(provider(async () => result), 'invalid_output', 502);
});
