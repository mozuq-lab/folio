import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/d1.ts';

const columns = (db: ReturnType<typeof createTestD1>, table: string) => (db.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);

test('バックログ用のテーブルが仕様どおりの列を持つ', () => {
  const db = createTestD1();
  assert.deepEqual(columns(db, 'folio_articles'), ['user_id', 'article_id', 'feed_id', 'url', 'published_at', 'fetched_at', 'read_at', 'updated_seq', 'payload']);
  assert.deepEqual(columns(db, 'folio_seq'), ['user_id', 'value']);
  assert.deepEqual(columns(db, 'folio_feeds'), ['user_id', 'feed_id', 'url', 'name', 'priority']);
  assert.deepEqual(columns(db, 'folio_users'), ['user_id', 'email', 'last_seen_at']);
  assert.deepEqual(columns(db, 'folio_feed_state'), ['user_id', 'feed_id', 'last_fetched_at', 'etag', 'last_modified', 'last_error']);
});

test('同じ利用者で同じURLの記事は2行目を入れられない', () => {
  const db = createTestD1();
  const insert = db.sqlite.prepare('INSERT INTO folio_articles (user_id, article_id, feed_id, url, published_at, fetched_at, updated_seq, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('u1', 'a1', 'f1', 'https://example.com/x', 'now', 'now', 1, '{}');
  assert.throws(() => insert.run('u1', 'a2', 'f1', 'https://example.com/x', 'now', 'now', 2, '{}'), /UNIQUE/);
  insert.run('u2', 'a1', 'f1', 'https://example.com/x', 'now', 'now', 1, '{}');
});
