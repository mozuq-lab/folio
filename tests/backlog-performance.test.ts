import test from 'node:test';
import assert from 'node:assert/strict';
import type { Article, Preferences } from '../lib/types.ts';
import { DEFAULT_INTELLIGENCE, type IntelligenceState } from '../lib/intelligence-types.ts';
import { applyNaturalProfile, buildReadingPlan, clusterStories, recentArticles, searchLibrary, selectExploration } from '../lib/discovery.ts';
import { mixExploration, rankPersonalized } from '../lib/personalization.ts';
import { syntheticArticles } from './helpers/synthetic-articles.ts';

// 上限はCIの揺れを見込んだ値（計画の上限）。手元のノートPCでの目安（For You 30,000件で1秒以内）はspec 7章。
const NOW = Date.parse('2026-11-09T00:00:00Z');
const preferences: Preferences = { interests: ['AI', '開発'], mutedTopics: ['政治', '広告'], topicWeights: { ゲーム: 2, 経済: -1 }, sourceWeights: { 'source-3': 1, 'source-7': -1 }, diversity: 50 };
const intelligence: IntelligenceState = {
  ...DEFAULT_INTELLIGENCE,
  profile: { summary: '', boostTerms: ['Rust', '量子', 'security'], muteTerms: ['ゴシップ'], preferredDepth: 'practical' },
  analysis: { 'article-10': { articleId: 'article-10', interest: 80, importance: 60, reason: '実践的', importanceReason: '影響が大きい', summary: '概要' } },
};

/**
 * 処理時間は並行して走る他のテストの影響を受けるので、準備の1回（JITの最適化）のあと3回測り、最も速い値で判定する。
 * 解析結果や索引は記事objectと配列ごとにcacheされるので、毎回 make で新しい記事を作る（作る時間は測らない）。
 */
function bestOf<I, T>(make: () => I, run: (input: I) => T, options: { warmUp?: boolean } = {}): { value: T; ms: number; input: I } {
  if (options.warmUp ?? true) run(make());
  let best: { value: T; ms: number; input: I } | null = null;
  for (let i = 0; i < 3; i++) {
    const input = make();
    const start = performance.now();
    const value = run(input);
    const ms = performance.now() - start;
    if (!best || ms < best.ms) best = { value, ms, input };
  }
  return best!;
}

test('30,000件でFor Youのおすすめを2,000ms以内に、件数にほぼ比例する時間で計算する', t => {
  const rank = (articles: Article[]) => rankPersonalized(articles, preferences, {}, intelligence);
  // 10,000件は30日分にして、1日あたりの記事数（同じニュースの候補を探す7日の範囲に入る件数）を30,000件・90日分とそろえる。
  const small = bestOf(() => syntheticArticles(10_000, { now: NOW, days: 30 }), rank);
  const large = bestOf(() => syntheticArticles(30_000, { now: NOW }), rank, { warmUp: false });
  const ratio = large.ms / small.ms;
  t.diagnostic(`rankPersonalized 10,000件（30日分）: ${small.ms.toFixed(0)}ms / 30,000件: ${large.ms.toFixed(0)}ms（比 ${ratio.toFixed(2)}）`);
  assert.ok(large.value.length > 20_000);
  assert.ok(large.ms < 2000, `rankPersonalized が ${large.ms.toFixed(0)}ms かかりました`);
  // 期間と件数が3倍なら、件数に比例する処理は約3倍、件数の2乗なら約9倍になる。マシンの速さに依らない検査。
  assert.ok(ratio < 5, `10,000件から30,000件で処理時間が ${ratio.toFixed(2)} 倍になりました`);
  // 画面と同じく、おすすめを計算済みの記事（解析済み）から新しい視点の記事を選んで混ぜる。
  const articles = large.input, ranked = large.value;
  const mix = bestOf(() => null, () => {
    const discoveries = selectExploration(applyNaturalProfile(articles, intelligence.profile), preferences, {}, 10, ranked.slice(0, 6).map(article => article.id));
    return mixExploration(ranked, discoveries, 20);
  });
  t.diagnostic(`新しい視点の選択と混ぜ込み 30,000件: ${mix.ms.toFixed(0)}ms`);
  assert.equal(mix.value.slice(0, 10).filter(article => article.isExploration).length, 2);
  assert.ok(mix.ms < 500, `新しい視点の選択と混ぜ込みが ${mix.ms.toFixed(0)}ms かかりました`);
});

test('7日分5,000件でニュースのまとまりを1,000ms以内に作る', t => {
  const cluster = (articles: Article[]) => clusterStories(articles, articles.filter((_, i) => i % 3 === 0).map(article => article.id), NOW);
  const week = bestOf(() => syntheticArticles(5_000, { now: NOW, days: 7, seed: 7 }), cluster);
  t.diagnostic(`clusterStories 5,000件: ${week.ms.toFixed(0)}ms（${week.value.length}件のまとまり）`);
  assert.equal(week.value.reduce((sum, cluster) => sum + cluster.articles.length, 0), week.input.length);
  assert.ok(week.value.some(cluster => cluster.articles.length > 1));
  assert.ok(week.ms < 1000, `clusterStories が ${week.ms.toFixed(0)}ms かかりました`);
  // 画面と同じく、90日分30,000件から直近7日を選んでまとめる。
  const recent = bestOf(() => syntheticArticles(30_000, { now: NOW, seed: 9 }), library => cluster(recentArticles(library, new Date(NOW))));
  t.diagnostic(`recentArticles + clusterStories 30,000件から直近7日: ${recent.ms.toFixed(0)}ms`);
  assert.ok(recent.value.length > 0);
  assert.ok(recent.value.every(cluster => cluster.articles.every(article => Date.parse(article.publishedAt) >= NOW - 7 * 86_400_000)));
  assert.ok(recent.ms < 1000, `直近7日のニュースのまとまりが ${recent.ms.toFixed(0)}ms かかりました`);
});

// どれも件数に比例する処理で、件数の2乗にならないことを確かめる（検索は保存・メモ付きの記事だけが対象で、実際は数百件）。
test('30,000件で新しい視点・ダイジェスト・検索をそれぞれ1,000ms以内に計算する', t => {
  const make = () => {
    const articles = syntheticArticles(30_000, { now: NOW, seed: 11 });
    return { articles, readIds: articles.filter((_, i) => i % 2 === 0).map(article => article.id) };
  };
  const explore = bestOf(make, ({ articles, readIds }) => selectExploration(articles, preferences, {}, 18, readIds));
  const plan = bestOf(make, ({ articles, readIds }) => buildReadingPlan(articles, 15, readIds));
  const search = bestOf(make, ({ articles }) => searchLibrary(articles, [], '生成AI security', 200));
  t.diagnostic(`selectExploration: ${explore.ms.toFixed(0)}ms / buildReadingPlan: ${plan.ms.toFixed(0)}ms / searchLibrary: ${search.ms.toFixed(0)}ms`);
  assert.equal(explore.value.length, 18);
  assert.ok(plan.value.totalMinutes > 0);
  assert.ok(search.value.length > 0);
  for (const [label, { ms }] of [['selectExploration', explore], ['buildReadingPlan', plan], ['searchLibrary', search]] as const)
    assert.ok(ms < 1000, `${label} が ${ms.toFixed(0)}ms かかりました`);
});
