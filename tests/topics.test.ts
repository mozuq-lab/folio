import test from 'node:test';
import assert from 'node:assert/strict';
import { TOPICS, sanitizeTopics, tagTopics } from '../lib/topics.ts';

test('10個のトピックすべてに判定の規則がある', () => {
  assert.equal(TOPICS.length, 10);
  const samples: Record<string, string> = {
    'AI・機械学習': '生成AIの新モデル', 'デザイン': 'Figmaの新しいUI', 'テクノロジー': '半導体の供給', '開発': 'TypeScriptで書く',
    'スタートアップ': '資金調達を発表', 'ビジネス': '経営の判断', 'プロダクト': '新製品を発売', 'サイエンス': '宇宙の観測',
    'カルチャー': '映画と音楽の話題', '暮らし': '週末の料理',
  };
  for (const topic of TOPICS) assert.ok(tagTopics(samples[topic]).includes(topic), topic);
});

test('どれにも当てはまらなければタグを付けない（テクノロジーにしない）', () => {
  assert.deepEqual(tagTopics('今日の天気について'), []);
  // 「start」の中の art はカルチャーにしない。
  assert.ok(!tagTopics('How to start a company').includes('カルチャー'));
  // production・productivity・agriculture は単語の一部なので当てはめない。
  assert.ok(!tagTopics('Deploying to production with better productivity').includes('プロダクト'));
  assert.ok(!tagTopics('The future of agriculture').includes('カルチャー'));
  assert.ok(tagTopics('New products for teams').includes('プロダクト'));
});

test('sanitizeTopics: 候補にあるものだけを、重複を除いて3個まで残す', () => {
  assert.deepEqual(sanitizeTopics(['開発', 'unknown', '開発', 'AI・機械学習', 'デザイン', 'ビジネス', 3]), ['開発', 'AI・機械学習', 'デザイン']);
  assert.deepEqual(sanitizeTopics('開発'), []);
});
