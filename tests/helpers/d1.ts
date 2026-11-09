import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

type Value = string | number | null;
export type D1Like = Pick<D1Database, 'prepare' | 'batch'>;

const MIGRATIONS = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const LIMIT = 2000000;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

export function createTestD1(): D1Like & { sqlite: DatabaseSync } {
  return build() as unknown as D1Like & { sqlite: DatabaseSync };
}

function build() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort())
    for (const statement of readFileSync(MIGRATIONS + file, 'utf8').split('--> statement-breakpoint')) if (statement.trim()) sqlite.exec(statement);
  const queries = new WeakMap<object, { sql: string; values: Value[] }>();
  const prepare = (sql: string) => {
    const query = { sql, values: [] as Value[] };
    const statement = {
      bind(...values: Value[]) { query.values = values; return this; },
      async first<T>() { return (sqlite.prepare(sql).get(...query.values) ?? null) as T | null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...query.values) as T[], success: true, meta: {} }; },
      async run() {
        const info = sqlite.prepare(sql).run(...query.values);
        return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      },
    };
    queries.set(statement, query);
    return statement;
  };
  return { sqlite, prepare, async batch(statements: object[]) {
    sqlite.exec('BEGIN');
    try {
      const result = statements.map(statement => {
        const query = queries.get(statement)!;
        for (const value of query.values) if (typeof value === 'string' && bytes(value) > LIMIT) throw new Error('D1 binding exceeds 2MB');
        const prepared = sqlite.prepare(query.sql);
        if (prepared.columns().length === 0) return { results: [], success: true, meta: { changes: Number(prepared.run(...query.values).changes) } };
        const results = prepared.all(...query.values);
        for (const row of results) if (Object.values(row).reduce<number>((sum, value) => sum + (typeof value === 'string' ? bytes(value) : 8), 0) > LIMIT) throw new Error('D1 row exceeds 2MB');
        return { results, success: true, meta: {} };
      });
      sqlite.exec('COMMIT'); return result;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}
