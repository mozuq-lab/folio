import test from 'node:test';
import assert from 'node:assert/strict';
import type { Preferences } from '../lib/types.ts';
import { DEFAULT_INTELLIGENCE, type IntelligenceState } from '../lib/intelligence-types.ts';
import { applyNaturalProfile, buildReadingPlan, clusterStories, recentArticles, searchLibrary, selectExploration } from '../lib/discovery.ts';
import { mixExploration, rankPersonalized } from '../lib/personalization.ts';
import { syntheticArticles } from './helpers/synthetic-articles.ts';

// 上限はCIの揺れを見込んだ値。手元のノートPCでの目安（For You 30,000件で1秒以内）はspec 7章。
const NOW = Date.parse('2026-11-09T00:00:00Z');
const preferences: Preferences = { interests: ['AI', '開発'], mutedTopics: ['政治', '広告'], topicWeights: { ゲーム: 2, 経済: -1 }, sourceWeights: { 'source-3': 1, 'source-7': -1 }, diversity: 50 };
const intelligence: IntelligenceState = {
  ...DEFAULT_INTELLIGENCE,
  profile: { summary: '', boostTerms: ['Rust', '量子', 'security'], muteTerms: ['ゴシップ'], preferredDepth: 'practical' },
  analysis: { 'article-10': { articleId: 'article-10', interest: 80, importance: 60, reason: '実践的', importanceReason: '影響が大きい', summary: '概要' } },
};

function measure<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

test('30,000件でFor Youのおすすめを2,000ms以内に計算する', t => {
  const articles = syntheticArticles(30_000, { now: NOW });
  const { value: ranked, ms } = measure(() => rankPersonalized(articles, preferences, {}, intelligence));
  t.diagnostic(`rankPersonalized 30,000件: ${ms.toFixed(0)}ms`);
  assert.ok(ranked.length > 20_000);
  assert.ok(ms < 2000, `rankPersonalized が ${ms.toFixed(0)}ms かかりました`);
  const { value: mixed, ms: mixMs } = measure(() => {
    const discoveries = selectExploration(applyNaturalProfile(articles, intelligence.profile), preferences, {}, 10, ranked.slice(0, 6).map(article => article.id));
    return mixExploration(ranked, discoveries, 20);
  });
  t.diagnostic(`探索記事の選択と混ぜ込み 30,000件: ${mixMs.toFixed(0)}ms`);
  assert.equal(mixed.slice(0, 10).filter(article => article.isExploration).length, 2);
  assert.ok(mixMs < 500, `探索記事の選択と混ぜ込みが ${mixMs.toFixed(0)}ms かかりました`);
});

test('7日分5,000件でニュースのまとまりを1,000ms以内に作る', t => {
  const articles = syntheticArticles(5_000, { now: NOW, days: 7, seed: 7 });
  const readIds = articles.filter((_, i) => i % 3 === 0).map(article => article.id);
  const { value: clusters, ms } = measure(() => clusterStories(articles, readIds, NOW));
  t.diagnostic(`clusterStories 5,000件: ${ms.toFixed(0)}ms（${clusters.length}件のまとまり）`);
  assert.equal(clusters.reduce((sum, cluster) => sum + cluster.articles.length, 0), articles.length);
  assert.ok(clusters.some(cluster => cluster.articles.length > 1));
  assert.ok(ms < 1000, `clusterStories が ${ms.toFixed(0)}ms かかりました`);
  // 画面と同じく、90日分30,000件から直近7日を選んでまとめる。
  const library = syntheticArticles(30_000, { now: NOW, seed: 9 });
  const { value: recent, ms: recentMs } = measure(() => clusterStories(recentArticles(library, new Date(NOW)), readIds, NOW));
  t.diagnostic(`recentArticles + clusterStories 30,000件から直近7日: ${recentMs.toFixed(0)}ms`);
  assert.ok(recent.length > 0);
  assert.ok(recent.every(cluster => cluster.articles.every(article => Date.parse(article.publishedAt) >= NOW - 7 * 86_400_000)));
  assert.ok(recentMs < 1000, `直近7日のニュースのまとまりが ${recentMs.toFixed(0)}ms かかりました`);
});

// どれも件数に比例する処理で、件数の2乗にならないことを確かめる（検索は保存・メモ付きの記事だけが対象で、実際は数百件）。
test('30,000件で新しい発見・読書プラン・検索をそれぞれ1,000ms以内に計算する', t => {
  const articles = syntheticArticles(30_000, { now: NOW, seed: 11 });
  const readIds = articles.filter((_, i) => i % 2 === 0).map(article => article.id);
  const explore = measure(() => selectExploration(articles, preferences, {}, 18, readIds));
  const plan = measure(() => buildReadingPlan(articles, 15, readIds));
  const search = measure(() => searchLibrary(articles, [], '生成AI security', 200));
  t.diagnostic(`selectExploration: ${explore.ms.toFixed(0)}ms / buildReadingPlan: ${plan.ms.toFixed(0)}ms / searchLibrary: ${search.ms.toFixed(0)}ms`);
  assert.equal(explore.value.length, 18);
  assert.ok(plan.value.totalMinutes > 0);
  assert.ok(search.value.length > 0);
  for (const [label, { ms }] of [['selectExploration', explore], ['buildReadingPlan', plan], ['searchLibrary', search]] as const)
    assert.ok(ms < 1000, `${label} が ${ms.toFixed(0)}ms かかりました`);
});
