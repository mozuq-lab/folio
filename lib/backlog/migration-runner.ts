import type { ReaderState } from '../types.ts';
import type { IntelligenceState } from '../intelligence-types.ts';
import { retainedArticleIds } from '../retention.ts';
import { migrationPayload, needsBacklogMigration } from './migration.ts';
import { importRequests, type ImportRequest } from './view.ts';

// 同期データからバックログへの移行の手順と、同期データの記事の整理。画面からは依存を渡して使う。

export type LibrarySnapshot = { ownerId: string | null; reader: ReaderState; intelligence: IntelligenceState };
export type MigrationDeps = {
  /** 移行を始めたときの、サーバーで確かめた持ち主。 */
  ownerId: string;
  /** いまの同期データとその持ち主（確かめた持ち主。無ければ null）。呼んだ時点の値を返す。 */
  library: () => LibrarySnapshot | null;
  /** POST /api/articles/import。成功なら応答の本文、失敗なら null を返す。 */
  post: (body: ImportRequest) => Promise<unknown>;
  syncBacklog: () => Promise<void>;
  /** 同期データの reader を、渡した関数でその場で書き換える（useLibrary の setState）。 */
  updateReader: (update: (reader: ReaderState) => ReaderState) => void;
  setBacklogRead: (ids: string[], read: boolean) => void;
  now?: () => Date;
};
export type MigrationOutcome = 'done' | 'skipped' | 'failed' | 'owner-changed';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** 保持対象の記事、またはまだ置き場所が無い記事の既読だけを残す。 */
function readFor(reader: ReaderState, articleIds: ReadonlySet<string>, keep: ReadonlySet<string>): string[] {
  return reader.read.filter(id => articleIds.has(id) || keep.has(id));
}

/**
 * 取り込んだ記事のうち保持対象でないものを外す。取り込んでいない記事（取り込みの後に増えた記事など）は残す。
 * サンプル記事は取り込まないので、保持対象でなければここで落とす。
 * 保持対象でない記事が残らなかったときだけ移行済みの印を付ける（残れば次に開いたときにもう一度移行する）。
 */
export function trimImported(reader: ReaderState, intelligence: IntelligenceState, importedIds: ReadonlySet<string>, now: Date): ReaderState {
  const keep = new Set(retainedArticleIds(reader, intelligence));
  const articles = reader.articles.filter(a => keep.has(a.id) || (!importedIds.has(a.id) && !a.isSample));
  const remaining = new Set(articles.map(a => a.id));
  const complete = articles.every(a => keep.has(a.id));
  return { ...reader, articles, read: readFor(reader, remaining, keep), ...(complete ? { backlogMigratedAt: now.toISOString() } : {}) };
}

/**
 * 移行済みの同期データから、保持対象でなくなった記事（保存の解除、作り直したダイジェスト、消した質問など）を外す。
 * readHandOver は外した記事のうち既読だったもの。呼び出し側がバックログの既読に引き継ぐ。
 */
export function pruneLibrary(reader: ReaderState, intelligence: IntelligenceState): { reader: ReaderState; readHandOver: string[] } {
  if (!reader.backlogMigratedAt) return { reader, readHandOver: [] };
  const keep = new Set(retainedArticleIds(reader, intelligence));
  const articles = reader.articles.filter(a => keep.has(a.id));
  const remaining = new Set(articles.map(a => a.id));
  const read = readFor(reader, remaining, keep);
  if (articles.length === reader.articles.length && read.length === reader.read.length) return { reader, readHandOver: [] };
  const dropped = new Set(reader.articles.filter(a => !keep.has(a.id)).map(a => a.id));
  return { reader: { ...reader, articles, read }, readHandOver: reader.read.filter(id => dropped.has(id)) };
}

/**
 * 同期データの記事と既読をバックログへ送り、全部届いたら取り込んだ記事を同期データから外す。
 * 送る前と外す前に持ち主を確かめ、替わっていたら（応答の ownerId が違っていても）止める。どれかの送信が失敗したら何も外さない。
 */
export async function runBacklogMigration(deps: MigrationDeps): Promise<MigrationOutcome> {
  const now = deps.now ?? (() => new Date());
  const start = deps.library();
  if (!start || start.ownerId !== deps.ownerId) return 'owner-changed';
  if (!needsBacklogMigration(start.reader)) return 'skipped';
  const snapshot = start.reader;
  const payload = migrationPayload(snapshot);
  const imported = new Set(payload.articles.map(a => a.id));
  const sameOwner = () => deps.library()?.ownerId === deps.ownerId;
  for (const body of importRequests(payload)) {
    if (!sameOwner()) return 'owner-changed';
    let response: unknown;
    try { response = await deps.post(body); } catch { return 'failed'; }
    if (response === null || response === undefined) return 'failed';
    if (!isRecord(response) || response.ownerId !== deps.ownerId) return 'owner-changed';
  }
  if (!sameOwner()) return 'owner-changed';
  await deps.syncBacklog();
  if (!sameOwner()) return 'owner-changed';
  // 送った後に変わった既読（外す記事のもの）は、外す前の状態と比べてバックログへ渡す。
  const before = new Set(snapshot.read);
  let nowRead: string[] = [];
  let nowUnread: string[] = [];
  deps.updateReader(current => {
    const intelligence = deps.library()?.intelligence ?? start.intelligence;
    const trimmed = trimImported(current, intelligence, imported, now());
    const remaining = new Set(trimmed.articles.map(a => a.id));
    const after = new Set(current.read);
    const dropped = (id: string) => imported.has(id) && !remaining.has(id);
    nowRead = current.read.filter(id => dropped(id) && !before.has(id));
    nowUnread = snapshot.read.filter(id => dropped(id) && !after.has(id));
    return trimmed;
  });
  if (nowRead.length) deps.setBacklogRead(nowRead, true);
  if (nowUnread.length) deps.setBacklogRead(nowUnread, false);
  return 'done';
}
