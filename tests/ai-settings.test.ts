import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveModelDraft, clientTimeoutMs, effectiveSelection, updateEffort, updateModel, updateProvider } from '../lib/ai-settings.ts';
import { providerStatuses, resolveSelection } from '../lib/ai/registry.ts';
import type { AISettings } from '../lib/intelligence-types.ts';

const ai = { run: async () => ({}) };
const allKeys = providerStatuses({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'r', AI: ai }, { dev: false });
const openaiOnly = providerStatuses({ OPENAI_API_KEY: 'o' }, { dev: false });
const noKeys = providerStatuses({}, { dev: true });

test('effectiveSelection without settings follows the server auto selection', () => {
  for (const statuses of [allKeys, openaiOnly]) {
    const server = resolveSelection({}, statuses);
    const client = effectiveSelection(undefined, statuses);
    assert.deepEqual(client, { provider: server.provider, model: server.model, effort: server.effort, available: true, label: server.status.label });
  }
  assert.deepEqual(effectiveSelection(undefined, allKeys), { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium', available: true, label: 'Claude' });
  assert.equal(effectiveSelection(undefined, openaiOnly)?.provider, 'openai');
});

test('effectiveSelection uses the saved model and effort of the saved provider', () => {
  const settings: AISettings = { provider: 'openrouter', models: { openrouter: 'anthropic/claude-haiku-5-5', openai: 'gpt-x' }, efforts: { openrouter: 'high' } };
  assert.deepEqual(effectiveSelection(settings, allKeys), { provider: 'openrouter', model: 'anthropic/claude-haiku-5-5', effort: 'high', available: true, label: 'OpenRouter' });
  const server = resolveSelection({ provider: 'openrouter', model: 'anthropic/claude-haiku-5-5', effort: 'high' }, allKeys);
  assert.equal(server.model, 'anthropic/claude-haiku-5-5');
});

test('effectiveSelection keeps an unavailable saved provider instead of switching', () => {
  const settings: AISettings = { provider: 'anthropic', models: {}, efforts: {} };
  assert.deepEqual(effectiveSelection(settings, openaiOnly), { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium', available: false, label: 'Claude' });
  assert.deepEqual(effectiveSelection({ provider: 'workers-ai', models: {}, efforts: {} }, noKeys), { provider: 'workers-ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', effort: 'auto', available: false, label: 'Workers AI' });
});

test('effectiveSelection is null when nothing is chosen or available', () => {
  assert.equal(effectiveSelection(undefined, noKeys), null);
  assert.equal(effectiveSelection(undefined, []), null);
});

test('clientTimeoutMs adds ten seconds to the server timeout', () => {
  assert.equal(clientTimeoutMs('medium'), 190_000);
  assert.equal(clientTimeoutMs('high'), 250_000);
  assert.equal(clientTimeoutMs('auto'), 100_000);
});

test('updateProvider keeps saved models and efforts', () => {
  assert.deepEqual(updateProvider(undefined, 'openai'), { provider: 'openai', models: {}, efforts: {} });
  const settings: AISettings = { provider: 'anthropic', models: { openai: 'gpt-x' }, efforts: { anthropic: 'high' } };
  assert.deepEqual(updateProvider(settings, 'openai'), { provider: 'openai', models: { openai: 'gpt-x' }, efforts: { anthropic: 'high' } });
});

test('updateModel accepts only valid model IDs', () => {
  const settings: AISettings = { provider: 'openai', models: { openai: 'gpt-x' }, efforts: {} };
  assert.equal(updateModel(settings, 'openai', 'bad id'), settings);
  assert.equal(updateModel(settings, 'openai', ''), settings);
  assert.equal(updateModel(settings, 'openai', 'x'.repeat(201)), settings);
  assert.deepEqual(updateModel(settings, 'openai', 'gpt-6-luna'), { provider: 'openai', models: { openai: 'gpt-6-luna' }, efforts: {} });
  assert.deepEqual(updateModel(undefined, 'anthropic', 'claude-x'), { provider: 'anthropic', models: { anthropic: 'claude-x' }, efforts: {} });
});

test('updateEffort accepts only efforts the provider supports', () => {
  const settings: AISettings = { provider: 'anthropic', models: {}, efforts: { anthropic: 'medium' } };
  assert.equal(updateEffort(settings, 'anthropic', 'none'), settings);
  assert.equal(updateEffort(settings, 'workers-ai', 'high'), settings);
  assert.deepEqual(updateEffort(settings, 'anthropic', 'max'), { provider: 'anthropic', models: {}, efforts: { anthropic: 'max' } });
  assert.deepEqual(updateEffort(undefined, 'openai', 'none'), { provider: 'openai', models: {}, efforts: { openai: 'none' } });
});

test('rejected updates without saved settings do not pin a provider', () => {
  assert.equal(updateModel(undefined, 'openai', 'bad id'), undefined);
  assert.equal(updateEffort(undefined, 'anthropic', 'none'), undefined);
});
test('resolveModelDraft trims a valid draft and reverts an invalid one to the saved model', () => {
  assert.equal(resolveModelDraft(' gpt-6-luna ', 'saved'), 'gpt-6-luna');
  assert.equal(resolveModelDraft('bad id', 'saved'), 'saved');
  assert.equal(resolveModelDraft('', 'saved'), 'saved');
});
