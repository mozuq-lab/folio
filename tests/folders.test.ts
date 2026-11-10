import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FOLDERS, UNFILED, addFeedsToFolders, createFolder, deleteFolder, folderFeedIds, moveFeedInFolder, moveFolder,
  moveUnfiledFeed, removeFeedFromFolders, renameFolder, resolveFolders, setFeedFolders, sidebarGroups, withCategories,
} from '../lib/folders.ts';
import type { Feed, ReaderState } from '../lib/types.ts';
import { DEFAULT_INTELLIGENCE } from '../lib/intelligence-types.ts';
import { validateSyncDocument } from '../lib/cloud-library.ts';
import { decodeState } from '../lib/storage.ts';

const feed = (id: string, category: string) => ({ id, name: id, url: `https://${id}.example/feed`, website: `https://${id}.example`, category, color: '#000', initial: id[0] }) as Feed;
const feeds = [feed('a', '暮らし'), feed('b', 'テクノロジー'), feed('c', '自作'), feed('d', '未分類'), feed('e', 'テクノロジー')];

test('resolveFolders: 保存が無ければ分類（category）から既定の順で作り、「未分類」は分類にしない', () => {
  assert.deepEqual(resolveFolders(feeds, undefined), [
    { name: 'テクノロジー', feedIds: ['b', 'e'] }, { name: '暮らし', feedIds: ['a'] }, { name: '自作', feedIds: ['c'] },
  ]);
});

test('resolveFolders: 保存があればその順を使い、購読していないIDと重複を除き、空の分類も残す', () => {
  const saved = [{ name: '読む', feedIds: ['e', 'zz', 'e', 'a'] }, { name: '空', feedIds: [] }];
  assert.deepEqual(resolveFolders(feeds, saved), [{ name: '読む', feedIds: ['e', 'a'] }, { name: '空', feedIds: [] }]);
});

test('sidebarGroups: 空でない分類を順に並べ、どこにも入っていないフィードを最後の「未分類」にまとめる', () => {
  const folders = [{ name: 'X', feedIds: ['c', 'a'] }, { name: '空', feedIds: [] }, { name: 'Y', feedIds: ['a'] }];
  const groups = sidebarGroups(feeds, folders);
  assert.deepEqual(groups.map(g => [g.name, g.feeds.map(f => f.id), g.unfiled]), [['X', ['c', 'a'], false], ['Y', ['a'], false], [UNFILED, ['b', 'd', 'e'], true]]);
  assert.deepEqual(folderFeedIds(feeds, folders, 'X'), ['c', 'a']);
  assert.deepEqual(folderFeedIds(feeds, folders, UNFILED), ['b', 'd', 'e']);
  assert.deepEqual(folderFeedIds(feeds, folders, 'none'), []);
});

test('分類の作成と名前の変更：空・長すぎる・「未分類」・重複・上限を拒否する', () => {
  const base = [{ name: 'A', feedIds: ['a'] }];
  assert.deepEqual(createFolder(base, '  B  '), { folders: [...base, { name: 'B', feedIds: [] }], error: null });
  assert.equal(createFolder(base, ' ').error, '分類の名前を入力してください。');
  assert.equal(createFolder(base, 'x'.repeat(41)).error, '分類の名前は40文字以内にしてください。');
  assert.equal(createFolder(base, UNFILED).error, '「未分類」は分類の名前に使えません。');
  assert.equal(createFolder(base, 'A').error, '同じ名前の分類があります。');
  const full = Array.from({ length: MAX_FOLDERS }, (_, i) => ({ name: `f${i}`, feedIds: [] }));
  assert.equal(createFolder(full, 'new').error, `分類は${MAX_FOLDERS}件まで作れます。`);
  assert.deepEqual(renameFolder([...base, { name: 'B', feedIds: [] }], 'A', 'C').folders.map(f => f.name), ['C', 'B']);
  assert.equal(renameFolder([...base, { name: 'B', feedIds: [] }], 'A', 'B').error, '同じ名前の分類があります。');
  assert.equal(renameFolder(base, 'A', 'A').error, null);
});

test('分類の削除・並び替えと、フィードの所属（複数可）・分類の中での並び替え', () => {
  const base = [{ name: 'A', feedIds: ['a', 'b', 'c'] }, { name: 'B', feedIds: ['b'] }, { name: 'C', feedIds: [] }];
  assert.deepEqual(deleteFolder(base, 'B').map(f => f.name), ['A', 'C']);
  assert.deepEqual(moveFolder(base, 2, 0).map(f => f.name), ['C', 'A', 'B']);
  assert.deepEqual(moveFolder(base, 0, 9).map(f => f.name), ['B', 'C', 'A']);
  assert.equal(moveFolder(base, 1, 1), base);
  assert.deepEqual(setFeedFolders(base, 'b', ['B', 'C']), [{ name: 'A', feedIds: ['a', 'c'] }, { name: 'B', feedIds: ['b'] }, { name: 'C', feedIds: ['b'] }]);
  assert.deepEqual(setFeedFolders(base, 'b', []).map(f => f.feedIds), [['a', 'c'], [], []]);
  assert.deepEqual(moveFeedInFolder(base, 'A', 2, 0)[0].feedIds, ['c', 'a', 'b']);
  assert.deepEqual(removeFeedFromFolders(base, 'b').map(f => f.feedIds), [['a', 'c'], [], []]);
});

test('moveUnfiledFeed: 未分類のフィードだけを並べ替え、分類に入っているフィードの位置は変えない', () => {
  const folders = [{ name: 'X', feedIds: ['b'] }];
  // 未分類は a, c, d, e。c を先頭へ。
  assert.deepEqual(moveUnfiledFeed(feeds, folders, 1, 0).map(f => f.id), ['c', 'b', 'a', 'd', 'e']);
});

test('addFeedsToFolders: 新しいフィードを分類名の分類の最後に入れ、無ければ分類を最後に作る', () => {
  const base = [{ name: 'A', feedIds: ['a'] }];
  assert.deepEqual(addFeedsToFolders(base, [feed('n', 'A'), feed('m', '新規'), feed('u', UNFILED), feed('a', 'A')]), [
    { name: 'A', feedIds: ['a', 'n'] }, { name: '新規', feedIds: ['m'] },
  ]);
});

test('withCategories: 各フィードの分類名を、入っている最初の分類にそろえる（変わらないものは同じオブジェクト）', () => {
  const folders = [{ name: 'X', feedIds: ['c'] }, { name: 'テクノロジー', feedIds: ['b', 'c'] }];
  const next = withCategories(feeds, folders);
  assert.deepEqual(next.map(f => f.category), [UNFILED, 'テクノロジー', 'X', UNFILED, UNFILED]);
  assert.equal(next[1], feeds[1]);
  assert.equal(next[3], feeds[3]);
});

test('同期データ：folders は任意項目。無い文書・ある文書を読み込み、形の違うものは拒否する', () => {
  const reader = (extra: Record<string, unknown> = {}) => ({ version: 1, articles: [], feeds: [feed('a', 'X')], saved: [], read: [], feedback: {}, preferences: { interests: [], mutedTopics: [], topicWeights: {}, sourceWeights: {}, diversity: 50 }, lastUpdated: null, ...extra }) as unknown as ReaderState;
  const doc = (r: ReaderState) => ({ version: 2, reader: r, intelligence: DEFAULT_INTELLIGENCE, updatedAt: 't' });
  assert.equal(validateSyncDocument(doc(reader())), true);
  assert.equal(validateSyncDocument(doc(reader({ folders: [{ name: 'X', feedIds: ['a'] }, { name: '空', feedIds: [] }] }))), true);
  for (const bad of [{ folders: 'x' }, { folders: [{ name: 'X' }] }, { folders: [{ name: 'X', feedIds: ['a'], extra: 1 }] }, { folders: [{ name: '', feedIds: [] }] }]) assert.equal(validateSyncDocument(doc(reader(bad))), false);
  const fallback = reader({ feeds: [] });
  assert.deepEqual(decodeState(JSON.stringify(reader({ folders: [{ name: 'X', feedIds: ['a'] }] })), fallback).folders, [{ name: 'X', feedIds: ['a'] }]);
  assert.equal(decodeState(JSON.stringify(reader()), fallback).feeds.length, 1);
  assert.equal(decodeState(JSON.stringify(reader({ folders: [{ name: 1, feedIds: [] }] })), fallback), fallback);
});

test('resolveFolders: 長すぎる分類名と上限を超える分類は作らず、同期データの検証を通る', () => {
  const many = [feed('long', 'あ'.repeat(201)), ...Array.from({ length: 250 }, (_, i) => feed(`f${i}`, `分類${i}`))];
  const folders = resolveFolders(many, undefined);
  assert.equal(folders.length, MAX_FOLDERS);
  assert.ok(!folders.some(folder => folder.feedIds.includes('long')));
  const reader = { version: 1, articles: [], feeds: withCategories(many, folders), saved: [], read: [], feedback: {}, preferences: { interests: [], mutedTopics: [], topicWeights: {}, sourceWeights: {}, diversity: 50 }, lastUpdated: null, folders } as unknown as ReaderState;
  assert.equal(validateSyncDocument({ version: 2, reader, intelligence: DEFAULT_INTELLIGENCE, updatedAt: 't' }), true);
});

test('addFeedsToFolders: createMissing が false なら、無い分類は作らずに未分類のままにする', () => {
  const base = [{ name: 'Tech', feedIds: ['a'] }];
  assert.deepEqual(addFeedsToFolders(base, [feed('n', 'テクノロジー'), feed('m', 'Tech')], { createMissing: false }), [{ name: 'Tech', feedIds: ['a', 'm'] }]);
});

test('分類の名前に「すべて」は使えない', () => {
  assert.equal(createFolder([], 'すべて').error, '「すべて」は分類の名前に使えません。');
  assert.equal(renameFolder([{ name: 'A', feedIds: [] }], 'A', 'すべて').error, '「すべて」は分類の名前に使えません。');
});

test('同期データ：AIの評価の tags は任意項目', () => {
  const reader = { version: 1, articles: [], feeds: [], saved: [], read: [], feedback: {}, preferences: { interests: [], mutedTopics: [], topicWeights: {}, sourceWeights: {}, diversity: 50 }, lastUpdated: null } as unknown as ReaderState;
  const analysis = (extra: object) => ({ ...DEFAULT_INTELLIGENCE, analysis: { a: { articleId: 'a', interest: 1, importance: 1, summary: '', reason: '', importanceReason: '', ...extra } } });
  assert.equal(validateSyncDocument({ version: 2, reader, intelligence: analysis({}), updatedAt: 't' }), true);
  assert.equal(validateSyncDocument({ version: 2, reader, intelligence: analysis({ tags: ['開発'] }), updatedAt: 't' }), true);
  assert.equal(validateSyncDocument({ version: 2, reader, intelligence: analysis({ tags: 'x' }), updatedAt: 't' }), false);
});
