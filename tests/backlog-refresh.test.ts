import test from 'node:test';
import assert from 'node:assert/strict';
import { REFRESH_CONCURRENCY, refreshFailureMessage, refreshTargets, runRefresh } from '../lib/backlog/refresh.ts';
import type { Feed } from '../lib/types.ts';

const feed = (id: string, priority?: boolean) => ({ id, name: `名前${id}`, url: `https://${id}.example/feed`, category: 'x', color: '#000', initial: 'x', ...(priority === undefined ? {} : { priority }) }) as Feed;

test('refreshTargets: フィードを表示中ならそのフィードだけ、それ以外は全フィードを優先フィードから', () => {
  const feeds = [feed('a'), feed('p', true), feed('b'), feed('q', true)];
  assert.deepEqual(refreshTargets(feeds, 'feed:b'), ['b']);
  assert.deepEqual(refreshTargets(feeds, 'all'), ['p', 'q', 'a', 'b']);
  assert.deepEqual(refreshTargets(feeds, 'for-you'), ['p', 'q', 'a', 'b']);
  assert.deepEqual(refreshTargets(feeds, 'feed:gone'), []);
  assert.deepEqual(refreshTargets([], 'all'), []);
  assert.deepEqual(refreshTargets([feed('a'), feed('a')], 'all'), ['a']);
});

test('refreshFailureMessage: 1件だけ頼んだときは名前と理由、複数のときは件数を知らせる', () => {
  const feeds = [feed('a'), feed('b'), feed('c')];
  assert.equal(refreshFailureMessage(feeds, 3, []), '');
  assert.equal(refreshFailureMessage(feeds, 1, [{ feedId: 'b', kind: 'network' }]), '「名前b」を取得できませんでした（配信元に接続できませんでした）。');
  assert.equal(refreshFailureMessage(feeds, 1, [{ feedId: 'b', kind: 'http' }]), '「名前b」を取得できませんでした（配信元がエラーを返しました）。');
  assert.equal(refreshFailureMessage(feeds, 1, [{ feedId: 'b', kind: 'format' }]), '「名前b」を取得できませんでした（RSSとして読み込めませんでした）。');
  assert.equal(refreshFailureMessage(feeds, 1, [{ feedId: 'b', kind: 'timeout' }]), '「名前b」を取得できませんでした（時間内に応答がありませんでした）。');
  assert.equal(refreshFailureMessage(feeds, 1, [{ feedId: 'b', kind: 'server' }]), '「名前b」を取得できませんでした（サーバーで処理できませんでした）。');
  // 配信元の文言はそのまま出さない。
  assert.equal(refreshFailureMessage(feeds, 1, [{ feedId: 'gone', kind: '<b>secret</b>' }]), '「フィード」を取得できませんでした（サーバーで処理できませんでした）。');
  assert.equal(refreshFailureMessage(feeds, 3, [{ feedId: 'a', kind: 'http' }, { feedId: 'c', kind: 'network' }]), '3件中2件のフィードを取得できませんでした。「フィードの管理」で状況を確認できます。');
});

test('runRefresh: 同時に頼むのは上限まで、全件を1回ずつ頼み、失敗と進み具合を返す', async () => {
  assert.equal(REFRESH_CONCURRENCY, 4);
  const ids = Array.from({ length: 10 }, (_, i) => `f${i}`);
  let running = 0, peak = 0;
  const seen: string[] = [];
  const progress: [number, number][] = [];
  const result = await runRefresh(ids, async id => {
    running++; peak = Math.max(peak, running); seen.push(id);
    await new Promise(resolve => setTimeout(resolve, 2));
    running--;
    return id === 'f3' || id === 'f7' ? { feedId: id, kind: 'http' } : null;
  }, { onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(peak, REFRESH_CONCURRENCY);
  assert.deepEqual([...seen].sort(), [...ids].sort());
  assert.equal(result.stopped, false);
  assert.deepEqual(result.failed.map(f => f.feedId).sort(), ['f3', 'f7']);
  assert.deepEqual(progress.at(-1), [10, 10]);
  assert.deepEqual(progress.map(p => p[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('runRefresh: stopを返したら残りを頼まずに止まる', async () => {
  const seen: string[] = [];
  const result = await runRefresh(['a', 'b', 'c', 'd', 'e', 'f'], async id => { seen.push(id); return id === 'b' ? 'stop' : null; }, { limit: 1 });
  assert.equal(result.stopped, true);
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(await runRefresh([], async () => null), { stopped: false, failed: [] });
});
