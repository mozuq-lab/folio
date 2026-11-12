import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTopbarScroll } from '../lib/topbar-scroll.ts';

const options = { reveal: 56, threshold: 10 };

test('下へスクロールしたら上部バーを隠し、上へ戻したら出す', () => {
  let state = { hidden: false, anchor: 0 };
  state = nextTopbarScroll(state, 300, options);
  assert.equal(state.hidden, true);
  state = nextTopbarScroll(state, 280, options);
  assert.equal(state.hidden, false);
});

test('少しずつスクロールしても、動いた量を足して判定する', () => {
  let state = { hidden: false, anchor: 100 };
  for (const y of [103, 106, 109]) { state = nextTopbarScroll(state, y, options); assert.equal(state.hidden, false); }
  state = nextTopbarScroll(state, 112, options);
  assert.equal(state.hidden, true);
  for (const y of [109, 106, 103]) { state = nextTopbarScroll(state, y, options); assert.equal(state.hidden, true); }
  state = nextTopbarScroll(state, 100, options);
  assert.equal(state.hidden, false);
});

test('ページの先頭近くでは常に出す', () => {
  assert.deepEqual(nextTopbarScroll({ hidden: true, anchor: 400 }, 40, options), { hidden: false, anchor: 40 });
  assert.equal(nextTopbarScroll({ hidden: true, anchor: 400 }, -20, options).hidden, false);
});

test('位置が数値でなければ状態を変えない', () => {
  const state = { hidden: true, anchor: 300 };
  assert.deepEqual(nextTopbarScroll(state, Number.NaN, options), state);
});
