import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneLibrary, runBacklogMigration, trimImported, type MigrationDeps } from '../lib/backlog/migration-runner.ts';
import { DEFAULT_INTELLIGENCE, type IntelligenceState } from '../lib/intelligence-types.ts';
import type { Article, ReaderState } from '../lib/types.ts';
import type { ImportRequest } from '../lib/backlog/view.ts';

const NOW = new Date('2026-11-09T00:00:00Z');
const art = (id: string, extra: Partial<Article> = {}): Article => ({ id, title: id, description: '', url: `https://e.com/${id}`, sourceId: 's', sourceName: 'S', publishedAt: '2026-11-01T00:00:00Z', tags: [], readingMinutes: 1, ...extra });
const reader = (over: Partial<ReaderState> = {}): ReaderState => ({ version: 1, articles: [art('saved', { content: '本文' }), art('noted'), art('a'), art('b'), art('sample', { isSample: true })], feeds: [], saved: ['saved'], read: ['saved', 'a'], feedback: {}, preferences: { interests: [], mutedTopics: [], topicWeights: {}, sourceWeights: {}, diversity: 0 }, lastUpdated: null, ...over });
const intel = (over: Partial<IntelligenceState> = {}): IntelligenceState => ({ ...DEFAULT_INTELLIGENCE, notes: [{ id: 'n', articleId: 'noted', quote: '', body: 'm', createdAt: '', updatedAt: '' }], ...over });
const ids = (articles: { id: string }[]) => articles.map(a => a.id);

type Harness = { owner: string | null; reader: ReaderState; intelligence: IntelligenceState; posts: ImportRequest[]; reads: { ids: string[]; read: boolean }[]; synced: number };
// 同期データの写しを持つ、テスト用の依存。updateReader は useLibrary の setState と同じく同期的に適用する。
function harness(start: ReaderState, options: { owner?: string; echo?: (call: number) => unknown; fail?: number; onPost?: (call: number, h: Harness) => void } = {}) {
  const h: Harness = { owner: 'alice', reader: start, intelligence: intel(), posts: [], reads: [], synced: 0 };
  const deps: MigrationDeps = {
    ownerId: options.owner ?? 'alice',
    library: () => ({ ownerId: h.owner, reader: h.reader, intelligence: h.intelligence }),
    post: async body => {
      const call = h.posts.length;
      h.posts.push(body);
      options.onPost?.(call, h);
      if (options.fail === call) return null;
      return options.echo ? options.echo(call) : { ownerId: 'alice', inserted: body.articles.length };
    },
    syncBacklog: async () => { h.synced++; },
    updateReader: update => { h.reader = update(h.reader); },
    setBacklogRead: (list, read) => { h.reads.push({ ids: list, read }); },
    now: () => NOW,
  };
  return { h, deps };
}

test('runBacklogMigration: 全部取り込めたら保持対象だけにし、移行済みの印を付ける', async () => {
  const { h, deps } = harness(reader());
  assert.equal(await runBacklogMigration(deps), 'done');
  assert.deepEqual(h.posts.map(p => ids(p.articles)), [['saved', 'noted', 'a', 'b']]);
  assert.deepEqual(h.posts[0].read, ['saved', 'a']);
  assert.equal(h.synced, 1);
  assert.deepEqual(ids(h.reader.articles), ['saved', 'noted']);
  assert.equal(h.reader.articles[0].content, '本文');
  assert.deepEqual(h.reader.read, ['saved']);
  assert.equal(h.reader.backlogMigratedAt, NOW.toISOString());
});

test('runBacklogMigration: 途中の送信が失敗したら何も外さない', async () => {
  const many = Array.from({ length: 1500 }, (_, i) => art(`m${i}`));
  const { h, deps } = harness(reader({ articles: many, read: [], saved: [] }), { fail: 1 });
  assert.equal(await runBacklogMigration(deps), 'failed');
  assert.equal(h.posts.length, 2);
  assert.equal(h.synced, 0);
  assert.equal(h.reader.articles.length, 1500);
  assert.equal(h.reader.backlogMigratedAt, undefined);
});

test('runBacklogMigration: 途中で利用者が替わったら、それ以上送らず外さない', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => art(`m${i}`));
  const { h, deps } = harness(reader({ articles: many, read: [], saved: [] }), { onPost: (call, state) => { if (call === 0) { state.owner = 'bob'; state.reader = reader({ articles: [art('bob-only')], saved: [], read: [] }); } } });
  assert.equal(await runBacklogMigration(deps), 'owner-changed');
  assert.equal(h.posts.length, 1);
  assert.deepEqual(ids(h.reader.articles), ['bob-only']);
  assert.equal(h.synced, 0);
});

test('runBacklogMigration: 開始時に持ち主が違えば何も送らない', async () => {
  const { h, deps } = harness(reader(), { owner: 'bob' });
  assert.equal(await runBacklogMigration(deps), 'owner-changed');
  assert.equal(h.posts.length, 0);
  assert.equal(h.reader.articles.length, 5);
});

test('runBacklogMigration: 応答の ownerId が違えば外さない', async () => {
  const { h, deps } = harness(reader(), { echo: () => ({ ownerId: 'bob', inserted: 4 }) });
  assert.equal(await runBacklogMigration(deps), 'owner-changed');
  assert.equal(h.synced, 0);
  assert.equal(h.reader.articles.length, 5);
  const missing = harness(reader(), { echo: () => ({ inserted: 4 }) });
  assert.equal(await runBacklogMigration(missing.deps), 'owner-changed');
});

test('runBacklogMigration: 取り込みの後に増えた記事は外さず、移行済みの印も付けない', async () => {
  const { h, deps } = harness(reader(), { onPost: (_call, state) => { state.reader = { ...state.reader, articles: [...state.reader.articles, art('late')] }; } });
  assert.equal(await runBacklogMigration(deps), 'done');
  assert.deepEqual(ids(h.reader.articles), ['saved', 'noted', 'late']);
  assert.equal(h.reader.backlogMigratedAt, undefined);
});

test('runBacklogMigration: 送った後に変わった既読をバックログへ渡してから外す', async () => {
  const { h, deps } = harness(reader(), { onPost: (_call, state) => { state.reader = { ...state.reader, read: ['saved', 'b'] }; } });
  assert.equal(await runBacklogMigration(deps), 'done');
  assert.deepEqual(h.reads, [{ ids: ['b'], read: true }, { ids: ['a'], read: false }]);
  assert.deepEqual(h.reader.read, ['saved']);
});

test('runBacklogMigration: 移行が不要なら何もしない', async () => {
  const { h, deps } = harness(reader({ backlogMigratedAt: 't' }));
  assert.equal(await runBacklogMigration(deps), 'skipped');
  assert.equal(h.posts.length, 0);
});

test('trimImported: 取り込んだ記事だけを外し、サンプルは落とす', () => {
  const t = trimImported(reader({ articles: [art('saved'), art('a'), art('other'), art('sample', { isSample: true })], read: ['a', 'other'] }), intel(), new Set(['saved', 'a']), NOW);
  assert.deepEqual(ids(t.articles), ['saved', 'other']);
  assert.deepEqual(t.read, ['other']);
  assert.equal(t.backlogMigratedAt, undefined);
});

test('pruneLibrary: 保持対象でなくなった記事を外し、その既読を渡す', () => {
  const r = reader({ backlogMigratedAt: 't', articles: [art('saved', { content: '本文' }), art('noted'), art('digest'), art('chat'), art('story'), art('unsaved'), art('old')], saved: ['saved'], read: ['saved', 'unsaved', 'gone'] });
  const i = intel({
    digest: { title: '', overview: '', items: [{ articleId: 'digest', summary: '', takeaway: '', minutes: 1 }], totalMinutes: 1, generatedAt: '', mode: 'ai' },
    chats: [{ id: 'c', question: 'q', createdAt: '', result: { answer: '', citations: [{ articleId: 'chat', quote: '' }] } }],
    storyReports: { s: { overview: '', developments: [{ text: '', articleIds: ['story'] }], perspectives: [], uncertainties: [] } },
  });
  const { reader: pruned, readHandOver } = pruneLibrary(r, i);
  assert.deepEqual(ids(pruned.articles), ['saved', 'noted', 'digest', 'chat', 'story']);
  assert.equal(pruned.articles[0].content, '本文');
  assert.deepEqual(pruned.read, ['saved']);
  assert.deepEqual(readHandOver, ['unsaved']);
});

test('pruneLibrary: 外すものが無いか、移行前なら同じ reader を返す', () => {
  const kept = reader({ backlogMigratedAt: 't', articles: [art('saved'), art('noted')], read: ['saved'] });
  assert.equal(pruneLibrary(kept, intel()).reader, kept);
  const before = reader();
  assert.deepEqual(pruneLibrary(before, intel()), { reader: before, readHandOver: [] });
});
