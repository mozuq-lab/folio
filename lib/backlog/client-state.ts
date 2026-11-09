import { articleSchema } from '../cloud-library.ts';
import { MAX_READ_BATCH, RETENTION_DAYS } from './constants.ts';
import type { BacklogEntry } from './types.ts';

// 端末側のバックログ。値は書き換えず、変更のたびに新しい状態を返す。
// entries と pendingReads のキーは記事ID。pendingReads は未送信の既読操作（true=既読、false=未読）。
export type BacklogState = { ownerId: string; cursor: string | null; entries: Map<string, BacklogEntry>; pendingReads: Map<string, boolean> };
export type ReadBatch = { ids: string[]; read: boolean };
export type ChangesPage = { entries: BacklogEntry[]; next: string; hasMore: boolean };

// 差分の1ページの件数。サーバーの上限（1,000件）より小さくし、1回の処理時間を抑える。続きは hasMore を見て取りに行く。
export const CHANGES_PAGE_SIZE = 250;

/** GET /api/articles のURL。 */
export function changesUrl(cursor: string | null, limit = CHANGES_PAGE_SIZE): string {
  return `/api/articles?limit=${limit}${cursor === null ? '' : `&after=${encodeURIComponent(cursor)}`}`;
}

export const emptyBacklog = (ownerId: string): BacklogState => ({ ownerId, cursor: null, entries: new Map(), pendingReads: new Map() });

/** 別の持ち主の状態は使わず、空の状態にする。 */
export function forOwner(state: BacklogState | null, ownerId: string): BacklogState {
  return state && state.ownerId === ownerId ? state : emptyBacklog(ownerId);
}

/** 未送信の操作があればそれを、無ければ保存済みの既読時刻を見る。 */
export function isRead(state: BacklogState, id: string): boolean {
  const pending = state.pendingReads.get(id);
  return pending ?? (state.entries.get(id)?.readAt ?? null) !== null;
}

/**
 * サーバーの差分を反映する。未送信の既読操作がある記事は、既読状態だけ端末の値を残す。
 * settled は、この差分を取りに行った後で送信できた操作。差分の方が古いので、未送信と同じく端末の値を残す。
 */
export function applyChanges(state: BacklogState, entries: BacklogEntry[], next: string, settled: ReadonlyMap<string, boolean> = new Map()): BacklogState {
  const merged = new Map(state.entries);
  for (const incoming of entries) {
    const id = incoming.article.id;
    const pending = state.pendingReads.get(id) ?? settled.get(id);
    if (pending === undefined) { merged.set(id, incoming); continue; }
    const local = merged.get(id);
    // 端末に記事が無いまま既読にした場合は、時刻の代わりに取得時刻を入れる（既読であることだけが意味を持つ）。
    const readAt = pending ? (local?.readAt ?? incoming.readAt ?? incoming.fetchedAt) : null;
    merged.set(id, { ...incoming, readAt });
  }
  return { ...state, cursor: next, entries: merged };
}

/** 取得から90日を過ぎた記事を除く。サーバーは削除を知らせないので、端末でも消す。 */
export function expireEntries(state: BacklogState, now: Date): BacklogState {
  const cutoff = now.getTime() - RETENTION_DAYS * 86400000;
  const expired: string[] = [];
  for (const [id, entry] of state.entries) if (Date.parse(entry.fetchedAt) < cutoff) expired.push(id);
  if (!expired.length) return state;
  const entries = new Map(state.entries);
  let pendingReads = state.pendingReads;
  for (const id of expired) {
    entries.delete(id);
    if (pendingReads.has(id)) {
      if (pendingReads === state.pendingReads) pendingReads = new Map(pendingReads);
      pendingReads.delete(id);
    }
  }
  return { ...state, entries, pendingReads };
}

/** 既読・未読の操作を記録し、端末の表示にもすぐ反映する。 */
export function queueRead(state: BacklogState, ids: string[], read: boolean, now = new Date()): BacklogState {
  if (!ids.length) return state;
  const readAt = now.toISOString();
  const entries = new Map(state.entries);
  const pendingReads = new Map(state.pendingReads);
  for (const id of ids) {
    pendingReads.set(id, read);
    const entry = entries.get(id);
    if (entry) entries.set(id, { ...entry, readAt: read ? (entry.readAt ?? readAt) : null });
  }
  return { ...state, entries, pendingReads };
}

/** 未送信の操作を、既読・未読ごとに size 件ずつに分ける。状態は変えない。 */
export function takePendingBatches(state: BacklogState, size = MAX_READ_BATCH): ReadBatch[] {
  const groups: Record<'read' | 'unread', string[]> = { read: [], unread: [] };
  for (const [id, read] of state.pendingReads) groups[read ? 'read' : 'unread'].push(id);
  const batches: ReadBatch[] = [];
  for (const [ids, read] of [[groups.read, true], [groups.unread, false]] as const) {
    for (let i = 0; i < ids.length; i += size) batches.push({ ids: ids.slice(i, i + size), read });
  }
  return batches;
}

/** 送信できた操作を消す。送信中に操作し直した記事は、新しい操作を残す。 */
export function acknowledgeReads(state: BacklogState, batch: ReadBatch): BacklogState {
  const pendingReads = new Map(state.pendingReads);
  for (const id of batch.ids) if (pendingReads.get(id) === batch.read) pendingReads.delete(id);
  return { ...state, pendingReads };
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function isEntry(value: unknown): value is BacklogEntry {
  return isRecord(value) && typeof value.feedId === 'string' && typeof value.fetchedAt === 'string'
    && (value.readAt === null || typeof value.readAt === 'string') && articleSchema.safeParse(value.article).success;
}

/** GET /api/articles の応答を確かめる。形の合わない記事は除き、応答自体が壊れていれば null。 */
export function parseChanges(body: unknown): ChangesPage | null {
  if (!isRecord(body) || !Array.isArray(body.entries) || typeof body.next !== 'string' || typeof body.hasMore !== 'boolean') return null;
  return { entries: body.entries.filter(isEntry), next: body.next, hasMore: body.hasMore };
}
