import test from 'node:test';
import assert from 'node:assert/strict';
import { learningProgress } from '../lib/learning-progress.ts';

test('リアクションが無いときは、興味あり・興味なしの両方を案内する', () => {
  const progress = learningProgress(0);
  assert.equal(progress.label, 'はじめの一歩');
  assert.equal(progress.percent, 12);
  assert.match(progress.description, /「興味あり」/);
  assert.match(progress.description, /「興味なし」/);
});

test('リアクションの件数を説明文に出す', () => {
  const progress = learningProgress(3);
  assert.equal(progress.label, '学習中');
  assert.equal(progress.description, '3件のリアクションを反映しています。');
});

test('バーは件数が増えるほど伸び続け、満タンにはならない', () => {
  const counts = [0, 1, 5, 11, 12, 30, 100, 1000];
  const percents = counts.map(count => learningProgress(count).percent);
  for (let i = 1; i < percents.length; i++) assert.ok(percents[i] > percents[i - 1], `${counts[i]}件で伸びていません`);
  assert.ok(percents.every(percent => percent < 100));
});

test('件数が不正な値なら0件として扱う', () => {
  for (const count of [-1, Number.NaN]) assert.deepEqual(learningProgress(count), learningProgress(0));
});
