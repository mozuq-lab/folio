import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CATEGORY_TABS, TOPICS, categoryTabs, sanitizeTopics, tagTopics, toggleCategoryTab } from '../lib/topics.ts';

test('13個のトピックすべてに判定の規則がある', () => {
  assert.equal(TOPICS.length, 13);
  const samples: Record<string, string> = {
    'AI・機械学習': '生成AIの新モデル', 'デザイン': 'Figmaの新しいUI', 'テクノロジー': '半導体の供給', '開発': 'TypeScriptで書く',
    'スタートアップ': '資金調達を発表', 'ビジネス': '経営の判断', 'プロダクト': '新製品を発売', 'サイエンス': '宇宙の観測',
    'カルチャー': '映画と音楽の話題', '暮らし': '週末の料理',
    'セキュリティ': 'Chromeに複数の脆弱性', '投資・マネー': '新NISAで株を買う', 'ゲーム': 'Nintendo Switchの新作ゲーム',
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

test('セキュリティ・投資・マネー・ゲームの規則は、単語の一部には当てはめない', () => {
  assert.ok(tagTopics('Weekly Report: WordPressに複数の脆弱性').includes('セキュリティ'));
  assert.ok(tagTopics('CVE-2026-1234 の修正').includes('セキュリティ'));
  assert.ok(tagTopics('為替と金利の見通し').includes('投資・マネー'));
  assert.ok(tagTopics('Steamでセール中の新作').includes('ゲーム'));
  // stock を含む単語（stockholm など）や game を含む単語（endgame は除く）に当てはめない。
  assert.ok(!tagTopics('Stockholm travel guide').includes('投資・マネー'));
  assert.ok(!tagTopics('A gamechanger for teams').includes('ゲーム'));
  // マネージャー・マネージメントは投資・マネーにしない。フィッシングは詐欺などのときだけ。
  assert.ok(!tagTopics('プロダクトマネージャーの仕事術').includes('投資・マネー'));
  assert.ok(tagTopics('マネーの基本').includes('投資・マネー'));
  assert.ok(!tagTopics('週末のフィッシング（釣り）').includes('セキュリティ'));
  assert.ok(tagTopics('フィッシング詐欺に注意').includes('セキュリティ'));
});

test('一覧の上のタブ：選んでいなければ既定の5つ、選んだら候補の順で表示し、候補にないものは出さない', () => {
  assert.deepEqual(DEFAULT_CATEGORY_TABS, ['テクノロジー', 'デザイン', 'ビジネス', 'サイエンス', '暮らし']);
  assert.deepEqual(categoryTabs(undefined), ['すべて', ...DEFAULT_CATEGORY_TABS]);
  assert.deepEqual(categoryTabs(['ゲーム', '未知', 'セキュリティ']), ['すべて', 'セキュリティ', 'ゲーム']);
  assert.deepEqual(categoryTabs([]), ['すべて']);
});

test('toggleCategoryTab: 既定の5つから始めて切り替える', () => {
  assert.deepEqual(toggleCategoryTab(undefined, 'ゲーム'), [...DEFAULT_CATEGORY_TABS, 'ゲーム']);
  assert.deepEqual(toggleCategoryTab(undefined, 'デザイン'), ['テクノロジー', 'ビジネス', 'サイエンス', '暮らし']);
  assert.deepEqual(toggleCategoryTab(['ゲーム'], 'ゲーム'), []);
});
