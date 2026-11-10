import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const folioLibraries = sqliteTable('folio_libraries', {
  userId: text('user_id').primaryKey().notNull(),
  document: text('document').notNull(),
  revision: integer('revision').notNull().default(1),
  updatedAt: text('updated_at').notNull(),
});

export const folioLibraryChunks = sqliteTable('folio_library_chunks', {
  userId: text('user_id').notNull(),
  operationToken: text('operation_token').notNull(),
  part: integer('part').notNull(),
  content: text('content').notNull(),
}, table => [primaryKey({columns:[table.userId,table.operationToken,table.part]})]);

export const folioArticles = sqliteTable('folio_articles', {
  userId: text('user_id').notNull(),
  articleId: text('article_id').notNull(),
  feedId: text('feed_id').notNull(),
  url: text('url').notNull(),
  publishedAt: text('published_at').notNull(),
  fetchedAt: text('fetched_at').notNull(),
  readAt: text('read_at'),
  updatedSeq: integer('updated_seq').notNull(),
  payload: text('payload').notNull(),
}, table => [
  primaryKey({columns:[table.userId,table.articleId]}),
  uniqueIndex('folio_articles_user_url_unique').on(table.userId,table.url),
  index('folio_articles_user_seq_idx').on(table.userId,table.updatedSeq,table.articleId),
  index('folio_articles_fetched_at_idx').on(table.fetchedAt),
]);

export const folioSeq = sqliteTable('folio_seq', {
  userId: text('user_id').primaryKey().notNull(),
  value: integer('value').notNull(),
});

export const folioFeeds = sqliteTable('folio_feeds', {
  userId: text('user_id').notNull(),
  feedId: text('feed_id').notNull(),
  url: text('url').notNull(),
  name: text('name').notNull(),
  priority: integer('priority').notNull().default(0),
}, table => [primaryKey({columns:[table.userId,table.feedId]})]);

export const folioUsers = sqliteTable('folio_users', {
  userId: text('user_id').primaryKey().notNull(),
  email: text('email').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
});

export const folioFeedState = sqliteTable('folio_feed_state', {
  userId: text('user_id').notNull(),
  feedId: text('feed_id').notNull(),
  lastFetchedAt: text('last_fetched_at'),
  etag: text('etag'),
  lastModified: text('last_modified'),
  lastError: text('last_error'),
}, table => [primaryKey({columns:[table.userId,table.feedId]})]);

// 期限切れで消した記事の印。フィードに載り続けている記事を、同じIDで未読として取り込み直さないために残す（lib/backlog/store.ts）。
export const folioExpired = sqliteTable('folio_expired', {
  userId: text('user_id').notNull(),
  articleId: text('article_id').notNull(),
  url: text('url').notNull(),
  expiredAt: text('expired_at').notNull(),
}, table => [
  primaryKey({columns:[table.userId,table.articleId]}),
  index('folio_expired_user_url_idx').on(table.userId,table.url),
  index('folio_expired_expired_at_idx').on(table.expiredAt),
]);
