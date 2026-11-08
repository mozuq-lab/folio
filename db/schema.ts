import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
