import test from 'node:test';
import assert from 'node:assert/strict';
import { needsBacklogMigration, migrationPayload, retainArticle } from '../lib/backlog/migration.ts';
import { DEFAULT_INTELLIGENCE } from '../lib/intelligence-types.ts';
import { validateSyncDocument } from '../lib/cloud-library.ts';
import { decodeState } from '../lib/storage.ts';
import { parseLibraryBackup } from '../lib/library-backup.ts';
import type { Article, ReaderState } from '../lib/types.ts';

const art = (id: string, extra: Partial<Article> = {}): Article => ({ id, title: id, description: '', url: `https://e.com/${id}`, sourceId: 's', sourceName: 'S', publishedAt: '2026-11-01T00:00:00Z', tags: [], readingMinutes: 1, ...extra });
const base = (over: Partial<ReaderState> = {}): ReaderState => ({ version: 1, articles: [art('saved', { content: '本文' }), art('noted'), art('only-read'), art('unread'), art('sample', { isSample: true })], feeds: [], saved: ['saved'], read: ['saved', 'only-read', 'gone'], feedback: {}, preferences: { interests: [], mutedTopics: [], topicWeights: {}, sourceWeights: {}, diversity: 0 }, lastUpdated: null, ...over });
const NOW = new Date('2026-11-09T00:00:00Z');

test('needsBacklogMigration: 未移行で保持対象外の記事か既読があれば true', () => {
  assert.equal(needsBacklogMigration(base()), true);
  assert.equal(needsBacklogMigration(base({ articles: [], read: [] })), false);
  assert.equal(needsBacklogMigration(base({ backlogMigratedAt: NOW.toISOString() })), false);
});

test('migrationPayload: サンプル以外の全記事と、それを指す既読IDだけを返す', () => {
  const p = migrationPayload(base());
  assert.deepEqual(p.articles.map(a => a.id), ['saved', 'noted', 'only-read', 'unread']);
  assert.deepEqual(p.read, ['saved', 'only-read']);
});

test('retainArticle: 無ければ本文付きで追加し、あれば同じオブジェクトを返す', () => {
  const r = base();
  const a = art('new', { content: 'x', contentFetchedAt: 't' });
  const added = retainArticle(r, a);
  assert.deepEqual(added.articles.at(-1), a);
  assert.equal(retainArticle(added, a), added);
});

test('backlogMigratedAt の有無どちらの文書も検証を通る', () => {
  const doc = (reader: ReaderState) => ({ version: 2, reader, intelligence: DEFAULT_INTELLIGENCE, updatedAt: 't' });
  assert.equal(validateSyncDocument(doc(base())), true);
  assert.equal(validateSyncDocument(doc(base({ backlogMigratedAt: NOW.toISOString() }))), true);
  assert.equal(validateSyncDocument(doc({ ...base(), backlogMigratedAt: 5 as unknown as string })), false);
  const fb = base({ articles: [] });
  assert.equal(decodeState(JSON.stringify(base({ backlogMigratedAt: 'x' })), fb).backlogMigratedAt, 'x');
  assert.equal(decodeState(JSON.stringify(base()), fb).articles.length, 5);
  assert.equal(decodeState(JSON.stringify({ ...base(), backlogMigratedAt: 5 }), fb), fb);
});

test('古い形式のバックアップは読み込めて、移行対象になる', () => {
  const many = Array.from({ length: 300 }, (_, i) => art(`a${i}`));
  const old = { version: 2, reader: { ...base({ articles: many, read: many.map(a => a.id) }) }, intelligence: DEFAULT_INTELLIGENCE, updatedAt: 't' };
  const parsed = parseLibraryBackup(JSON.stringify(old));
  assert.equal(parsed.reader.backlogMigratedAt, undefined);
  assert.equal(needsBacklogMigration(parsed.reader), true);
});
