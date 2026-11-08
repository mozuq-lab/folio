import assert from 'node:assert/strict';
import test from 'node:test';
import { AIError, validateRequest } from '../lib/ai.ts';
import { providerStatuses, resolveSelection } from '../lib/ai/registry.ts';
import { selectProvider } from '../lib/ai/selection.ts';

const ai = { run: async () => ({}) };
const find = (statuses: ReturnType<typeof providerStatuses>, id: string) => statuses.find(s => s.id === id)!;
const article = { id: 'a', title: 't', description: 'd', url: 'https://example.com', sourceId: 's', sourceName: 'n', publishedAt: '2026-01-01', tags: [], readingMinutes: 1 };
const req = (extra: object) => ({ action: 'analyze', articles: [article], ...extra });

test('providerStatuses: キーなし・空白のみはキー未設定', () => {
  const statuses = providerStatuses({ OPENAI_API_KEY: '   ', OPENROUTER_API_KEY: 'k' }, { dev: false });
  assert.equal(statuses.length, 4);
  for (const id of ['openai', 'anthropic']) { assert.equal(find(statuses, id).available, false); assert.equal(find(statuses, id).reason, 'キー未設定'); }
  assert.equal(find(statuses, 'openrouter').available, true);
  assert.equal(find(statuses, 'openrouter').reason, undefined);
  assert.equal(find(statuses, 'openai').label, 'OpenAI');
});
test('providerStatuses: workers-aiはAIバインディングがあり本番のときだけ使える', () => {
  assert.equal(find(providerStatuses({ AI: ai }, { dev: false }), 'workers-ai').available, true);
  assert.equal(find(providerStatuses({ AI: ai }, { dev: true }), 'workers-ai').reason, 'この環境では使えません');
  assert.equal(find(providerStatuses({}, { dev: false }), 'workers-ai').reason, 'この環境では使えません');
});
test('resolveSelection: 未指定ならanthropic、次にopenai、openrouterの順', () => {
  assert.equal(resolveSelection({}, providerStatuses({ OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' }, { dev: false })).provider, 'anthropic');
  assert.equal(resolveSelection({}, providerStatuses({ OPENAI_API_KEY: 'a', OPENROUTER_API_KEY: 'b' }, { dev: false })).provider, 'openai');
  assert.equal(resolveSelection({}, providerStatuses({ OPENROUTER_API_KEY: 'b' }, { dev: false })).provider, 'openrouter');
});
test('resolveSelection: workers-aiしか無ければ503 not_configured', () => {
  assert.throws(() => resolveSelection({}, providerStatuses({ AI: ai }, { dev: false })), (e: unknown) => e instanceof AIError && e.status === 503 && e.code === 'not_configured' && e.message === 'AIは未接続です。設定画面で提供元を選び、APIキーを登録してください。');
});
test('resolveSelection: 指定した提供元はキーが無くても切り替えない', () => {
  const statuses = providerStatuses({ OPENAI_API_KEY: 'a' }, { dev: false });
  const selected = resolveSelection({ provider: 'anthropic' }, statuses);
  assert.equal(selected.provider, 'anthropic');
  assert.equal(selected.status.available, false);
  assert.equal(selected.model, 'claude-haiku-5-5');
});
test('resolveSelection: effortとmodelの既定', () => {
  const statuses = providerStatuses({ OPENAI_API_KEY: 'a', AI: ai }, { dev: false });
  assert.deepEqual(resolveSelection({ provider: 'openai' }, statuses).effort, 'medium');
  assert.deepEqual(resolveSelection({ provider: 'workers-ai' }, statuses).effort, 'auto');
  const chosen = resolveSelection({ provider: 'openai', model: 'x', effort: 'high' }, statuses);
  assert.equal(chosen.model, 'x'); assert.equal(chosen.effort, 'high');
});
test('selectProvider: 何も指定せず利用可能な提供元も無ければnull', () => {
  assert.equal(selectProvider({}, providerStatuses({}, { dev: false })), null);
});
test('validateRequest: model・provider・effortの検証', () => {
  assert.equal(validateRequest(req({ provider: 'anthropic', model: 'claude-x:1', effort: 'high' })).provider, 'anthropic');
  for (const model of ['a b', 'a'.repeat(201)]) assert.throws(() => validateRequest(req({ model })), (e: unknown) => e instanceof AIError && e.status === 400);
  assert.throws(() => validateRequest(req({ provider: 'bogus' })), (e: unknown) => e instanceof AIError && e.status === 400);
  assert.throws(() => validateRequest(req({ effort: 'ultra' })), (e: unknown) => e instanceof AIError && e.status === 400);
  for (const extra of [{ provider: 'workers-ai', effort: 'medium' }, { provider: 'anthropic', effort: 'none' }]) {
    assert.throws(() => validateRequest(req(extra)), (e: unknown) => e instanceof AIError && e.status === 400 && e.code === 'invalid_effort' && e.message === '選んだ提供元では、この推論の深さを指定できません。');
  }
});
test('resolveSelection: 自動選択された提供元が指定のeffortに対応しなければ400 invalid_effort', () => {
  assert.throws(() => resolveSelection({ effort: 'none' }, providerStatuses({ ANTHROPIC_API_KEY: 'k' }, { dev: false })),
    (e: unknown) => e instanceof AIError && e.status === 400 && e.code === 'invalid_effort' && e.message === '選んだ提供元では、この推論の深さを指定できません。');
});
