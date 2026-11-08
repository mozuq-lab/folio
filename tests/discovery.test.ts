import test from 'node:test';
import assert from 'node:assert/strict';
import type { Article, Preferences } from '../lib/types.ts';
import type { ArticleNote, NaturalProfile } from '../lib/intelligence-types.ts';
import { applyNaturalProfile, buildReadingPlan, clusterStories, scoreImportance, scoreNaturalPreference, searchLibrary, selectExploration } from '../lib/discovery.ts';

const now = Date.parse('2026-11-06T12:00:00Z');
const article = (id: string, overrides: Partial<Article> = {}): Article => ({ id, title: '独立した記事 ' + id, description: '', url: 'https://example.com/' + id, sourceId: id, sourceName: id, publishedAt: '2026-11-06T10:00:00Z', tags: [], readingMinutes: 3, ...overrides });
const preferences: Preferences = { interests: ['AI'], mutedTopics: ['投資'], topicWeights: {}, sourceWeights: {}, diversity: 50 };

test('同じ話題だけの記事を分離し、同一ニュースと既読後の続報をまとめる', () => {
  const launch = article('a', { title: 'OpenAI launches Atlas browser for Mac', description: 'Atlas browser launches today.' });
  const follow = article('b', { title: 'OpenAI launches Atlas browser for Mac: pricing details', description: 'Pricing starts at $20.' });
  const unrelated = article('c', { title: 'OpenAI faces copyright investigation over training data' });
  const clusters = clusterStories([launch, follow, unrelated], ['a'], now);
  assert.equal(clusters.length, 2);
  const story = clusters.find(c => c.articles.length === 2)!;
  assert.deepEqual(story.readArticles.map(a => a.id), ['a']);
  assert.deepEqual(story.unreadArticles.map(a => a.id), ['b']);
  assert.ok(story.newCoverage.some(text => text.includes('pricing')));
  assert.ok(story.importance >= 0 && story.importance <= 99);
});

test('trackingとhashだけが異なるURLをまとめ、意味を持つqueryは保持する', () => {
  const a = article('a', { url: 'https://example.com/news?id=1&utm_source=rss#top' });
  const b = article('b', { url: 'https://example.com/news?utm_medium=email&id=1' });
  const c = article('c', { url: 'https://example.com/news?id=2' });
  assert.deepEqual(clusterStories([a, b, c], [], now).map(c => c.articles.length).sort(), [1, 2]);
});

test('別の製品番号と離れた日付のニュースは誤結合しない', () => {
  const a = article('a', { title: 'Apple launches iPhone 17 with new camera' });
  const b = article('b', { title: 'Apple launches iPhone 18 with new camera' });
  const c = article('c', { title: a.title, publishedAt: '2025-11-06T10:00:00Z' });
  assert.equal(clusterStories([a, b, c], [], now).length, 3);
});

test('同じメーカーの異なる製品名を共通の発表文で誤結合しない', () => {
  const a = article('a', { title: 'Apple launches MacBook Air with M4 chip' });
  const b = article('b', { title: 'Apple launches MacBook Pro with M4 chip' });
  assert.equal(clusterStories([a, b], [], now).length, 2);
});

test('日本語の似た見出しは同じ発表だけをまとめる', () => {
  const a = article('a', { title: '任天堂が新型ゲーム機Switch 2を発売、国内価格を発表' });
  const b = article('b', { title: '任天堂が新型ゲーム機Switch 2を発売、国内価格の詳細を発表' });
  const c = article('c', { title: '任天堂が新型ゲーム機Switch 2の修理サービスを開始' });
  assert.deepEqual(clusterStories([a, b, c], [], now).map(c => c.articles.length).sort(), [1, 2]);
});

test('重要度は複数出典と鮮度と公共影響を根拠にし、不正な日付でも有限', () => {
  const a = article('a', { title: 'Critical security vulnerability disclosed in Acme server' });
  const b = article('b', { title: a.title, sourceId: 'other' });
  const withCoverage = scoreImportance(a, [a, b], now);
  assert.ok(withCoverage.score > scoreImportance(a, [a], now).score);
  assert.ok(withCoverage.reason.includes('出典'));
  assert.ok(withCoverage.reason.includes('公共'));
  assert.ok(scoreImportance(a, [a], now).score > scoreImportance({ ...a, publishedAt: '2020-01-01' }, [a], now).score);
  const invalid = article('bad', { publishedAt: 'broken' });
  assert.ok(Number.isFinite(scoreImportance(invalid, [invalid], now).score));
  assert.equal(clusterStories([invalid], [], now)[0].latestAt, '');
});

test('同じ記事集合の再評価は内容・好みの付加情報から独立し、別集合の追加出典を反映する', () => {
  const a = article('a', { title: 'OpenAI launches Atlas browser for Mac' });
  const sameSource = article('duplicate', { title: a.title, sourceId: a.sourceId });
  const collection = [a, sameSource];
  assert.equal(scoreImportance(a, collection, now).score, 34);
  const decorated = { ...a, content: '好みのRust advanced tutorial security', score: 99, reason: '好みに一致' };
  assert.equal(scoreImportance(decorated, collection, now).score, 34);
  const b = article('b', { title: a.title, sourceId: 'different' });
  assert.equal(scoreImportance(a, [...collection, b], now).score, 46);
  assert.equal(scoreImportance(a, collection, now).score, 34);
  assert.equal(scoreImportance(a, collection, now + 10 * 86_400_000).score, 10);
});

test('同IDの別見出しを持つコピーに古い集約結果を適用しない', () => {
  const a = article('a', { title: 'Apple launches MacBook Air with M4 chip' });
  const b = article('b', { title: a.title });
  const collection = [a, b];
  assert.equal(scoreImportance(a, collection, now).score, 46);
  const different = { ...a, title: 'A museum opens a new exhibit', url: 'https://example.org/museum' };
  assert.equal(scoreImportance(different, collection, now).score, 34);
});

test('探索では明示除外とdislikeとmuteとsampleを除き、関心外と出典分散を優先する', () => {
  const input = [article('known', { tags: ['AI'] }), article('novel', { tags: ['科学'], sourceId: 'one' }), article('novel2', { tags: ['科学'], sourceId: 'one' }), article('diverse', { tags: ['歴史'], sourceId: 'two' }), article('muted', { tags: ['投資'] }), article('bad'), article('sample', { isSample: true }), article('excluded')];
  const result = selectExploration(input, preferences, { bad: 'dislike' }, 2, ['excluded']);
  assert.deepEqual(result.map(a => a.id), ['novel', 'diverse']);
  assert.deepEqual(selectExploration(input, preferences, {}, 0), []);
});

test('読書プランは既読を除外し時間予算内で概要の抜粋と記事IDを保持する', () => {
  const input = [article('read', { readingMinutes: 1 }), article('long', { readingMinutes: 10 }), article('fit', { readingMinutes: 2, description: '本文にある検証済みの概要。' }), article('short', { readingMinutes: 1 })];
  const plan = buildReadingPlan(input, 3, ['read']);
  assert.equal(plan.mode, 'extractive');
  assert.equal(plan.totalMinutes, 3);
  assert.deepEqual(plan.items.map(i => i.articleId), ['fit', 'short']);
  assert.equal(plan.items[0].summary, '本文にある検証済みの概要。');
  assert.equal(buildReadingPlan(input, 0).items.length, 0);
  assert.equal(buildReadingPlan([], 5).items.length, 0);
  assert.equal(buildReadingPlan([article('bad', { readingMinutes: NaN })], NaN).totalMinutes, 0);
  assert.ok(buildReadingPlan(Array.from({ length: 40 }, (_, i) => article('x' + i, { readingMinutes: 1 })), 100).totalMinutes <= 30);
});

test('ライブラリ検索は日本語とノート本文と引用を検索し無根拠では返さない', () => {
  const input = [article('a', { title: '量子計算の誤り訂正を解説' }), article('b'), article('c')];
  const notes: ArticleNote[] = [{ id: 'note', articleId: 'b', quote: 'distributed consensus', body: '分散合意の検証メモ', createdAt: '', updatedAt: '' }];
  assert.equal(searchLibrary(input, notes, '誤り訂正')[0].id, 'a');
  assert.equal(searchLibrary(input, notes, '検証メモ')[0].id, 'b');
  assert.equal(searchLibrary(input, notes, 'consensus')[0].id, 'b');
  assert.deepEqual(searchLibrary(input, notes, 'astronomy'), []);
  assert.deepEqual(searchLibrary(input, notes, ''), []);
  assert.equal(searchLibrary(input, notes, '記事', 1).length, 1);
});

test('自然文profileは明示muteを除外しboostと深さで並び替える', () => {
  const profile: NaturalProfile = { summary: '', boostTerms: ['Rust'], muteTerms: ['広告'], preferredDepth: 'advanced' };
  const plain = article('plain', { title: '今日のニュース' });
  const rust = article('rust', { title: 'Rust internals deep dive' });
  const muted = article('muted', { title: 'Rust 広告' });
  assert.deepEqual(applyNaturalProfile([plain, muted, rust], profile).map(a => a.id), ['rust', 'plain']);
  assert.ok(scoreNaturalPreference(rust, profile) > scoreNaturalPreference(plain, profile));
  assert.deepEqual(applyNaturalProfile([plain, rust], null), [plain, rust]);
  assert.equal(scoreNaturalPreference(plain, null), 0);
});
