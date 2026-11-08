import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFeedback, rankArticles } from '../lib/recommendations.ts';
import type { Article, Preferences } from '../lib/types.ts';

const NOW = Date.parse('2026-11-06T03:00:00.000Z');

function preferences(overrides: Partial<Preferences> = {}): Preferences {
  return { interests: [], mutedTopics: [], topicWeights: {}, sourceWeights: {}, diversity: 0, ...overrides };
}

function article(id: string, overrides: Partial<Article> = {}): Article {
  return {
    id,
    title: `${id}の記事`,
    description: '記事の概要',
    url: `https://example.com/${id}`,
    sourceId: id,
    sourceName: id,
    publishedAt: new Date(NOW).toISOString(),
    tags: ['テクノロジー'],
    readingMinutes: 5,
    ...overrides,
  };
}

test('興味を変更すると一致する記事が上位になり、日本語の理由が付く', () => {
  const articles = [article('ai', { tags: ['AI・機械学習'] }), article('design', { tags: ['デザイン'] })];
  const aiRanking = rankArticles(articles, preferences({ interests: ['AI・機械学習'] }), {}, NOW);
  const designRanking = rankArticles(articles, preferences({ interests: ['デザイン'] }), {}, NOW);
  assert.equal(aiRanking[0].id, 'ai');
  assert.equal(designRanking[0].id, 'design');
  assert.match(aiRanking[0].reason, /AI・機械学習/);
  assert.match(aiRanking[0].reason, /[ぁ-んァ-ヶ一-龠]/);
});

test('学習したtopicとsourceの重みが順位に反映される', () => {
  const articles = [article('a'), article('b', { tags: ['デザイン'] }), article('c', { sourceId: 'favorite' })];
  assert.equal(rankArticles(articles, preferences({ topicWeights: { デザイン: 3 } }), {}, NOW)[0].id, 'b');
  assert.equal(rankArticles(articles, preferences({ sourceWeights: { favorite: 3 } }), {}, NOW)[0].id, 'c');
});

test('同じ関連度なら新しい記事を優先する', () => {
  const articles = [article('a-old', { publishedAt: '2026-09-01T00:00:00Z' }), article('z-new')];
  assert.equal(rankArticles(articles, preferences(), {}, NOW)[0].id, 'z-new');
});

test('ミュートしたtopicと興味なしの記事を除外する', () => {
  const articles = [article('muted', { tags: ['デザイン'] }), article('disliked'), article('visible')];
  const ranked = rankArticles(articles, preferences({ mutedTopics: ['デザイン'] }), { disliked: 'dislike' }, NOW);
  assert.deepEqual(ranked.map(({ id }) => id), ['visible']);
});

test('興味ありの記事を優先する', () => {
  const ranked = rankArticles([article('a'), article('z')], preferences(), { z: 'like' }, NOW);
  assert.equal(ranked[0].id, 'z');
  assert.match(ranked[0].reason, /興味あり/);
});

test('多様性を上げると同一sourceの連続より別sourceを優先する', () => {
  const articles = [
    article('a', { sourceId: 'frequent' }),
    article('b', { sourceId: 'frequent' }),
    article('c', { sourceId: 'new-source', publishedAt: '2026-11-05T03:00:00Z' }),
  ];
  assert.deepEqual(rankArticles(articles, preferences(), {}, NOW).map(({ id }) => id), ['a', 'b', 'c']);
  assert.deepEqual(rankArticles(articles, preferences({ diversity: 100 }), {}, NOW).map(({ id }) => id), ['a', 'c', 'b']);
});

test('同点の順序は入力順に依存せず安定する', () => {
  const articles = [article('b'), article('a'), article('c')];
  assert.deepEqual(rankArticles(articles, preferences(), {}, NOW).map(({ id }) => id), ['a', 'b', 'c']);
  assert.deepEqual(rankArticles([...articles].reverse(), preferences(), {}, NOW).map(({ id }) => id), ['a', 'b', 'c']);
});

test('無効な日付や極端な重みでもスコアは有限の0〜99に収まる', () => {
  const ranked = rankArticles([
    article('invalid', { publishedAt: 'not-a-date' }),
    article('future', { publishedAt: '2999-01-01T00:00:00Z', tags: ['デザイン'] }),
  ], preferences({ topicWeights: { デザイン: 1e200 }, sourceWeights: { invalid: -1e200 } }), {}, NOW);
  assert.equal(ranked.length, 2);
  for (const entry of ranked) {
    assert.ok(Number.isFinite(entry.score));
    assert.ok(entry.score >= 0 && entry.score <= 99);
  }
});

test('ランキングで元の記事や設定を変更しない', () => {
  const articles = [article('b'), article('a')];
  const settings = preferences({ interests: ['テクノロジー'] });
  const before = structuredClone({ articles, settings });
  rankArticles(articles, settings, {}, NOW);
  assert.deepEqual({ articles, settings }, before);
});

test('興味ありの学習を取り消すと元の設定へ戻る', () => {
  const settings = preferences({ topicWeights: { デザイン: 4 }, sourceWeights: { source: 2 } });
  const target = article('target', { sourceId: 'source', tags: ['デザイン', 'AI・機械学習'] });
  const learned = applyFeedback(settings, target, undefined, 'like');
  assert.ok(learned.topicWeights['デザイン'] > 4);
  assert.ok(learned.sourceWeights.source > 2);
  assert.deepEqual(applyFeedback(learned, target, 'like', undefined), settings);
  assert.deepEqual(settings.topicWeights, { デザイン: 4 });
});

test('興味ありから興味なしへの変更は反応を直接設定した結果と一致する', () => {
  const settings = preferences();
  const target = article('target');
  const liked = applyFeedback(settings, target, undefined, 'like');
  const switched = applyFeedback(liked, target, 'like', 'dislike');
  assert.deepEqual(switched, applyFeedback(settings, target, undefined, 'dislike'));
  assert.ok(switched.topicWeights['テクノロジー'] < 0);
  assert.ok(switched.sourceWeights.target < 0);
  assert.deepEqual(applyFeedback(switched, target, 'dislike', undefined), settings);
});

test('同じ反応の再適用で学習が重複しない', () => {
  const target = article('target', { tags: ['デザイン', 'デザイン'] });
  const initial = preferences();
  const liked = applyFeedback(initial, target, undefined, 'like');
  assert.deepEqual(applyFeedback(liked, target, 'like', 'like'), liked);
  assert.deepEqual(applyFeedback(liked, target, 'like', undefined), initial);
  const sameTopicOnce = applyFeedback(initial, { ...target, tags: ['デザイン'] }, undefined, 'like');
  assert.deepEqual(liked, sameTopicOnce);
});
