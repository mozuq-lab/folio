import { emptyBacklog, type BacklogState } from './client-state.ts';
import type { BacklogEntry } from './types.ts';

// 端末側のバックログをIndexedDBに置く。記事は「持ち主＋記事ID」ごとに1件ずつ保存し、
// 変わった記事だけを書き込む。カーソルと未送信の既読操作は持ち主ごとの小さな記録に置く。
// IndexedDBが使えない環境（プライベートモードなど）ではメモリーだけで動く。
export const BACKLOG_DB_NAME = 'folio-backlog';
const DB_VERSION = 1;
const ENTRIES = 'entries';
const META = 'meta';
const CONTENT = 'content';
const OPEN_TIMEOUT_MS = 5000;

type EntryRecord = { ownerId: string; articleId: string; entry: BacklogEntry };
type MetaRecord = { ownerId: string; cursor: string | null; pendingReads: [string, boolean][] };
type ContentRecord = { ownerId: string; articleId: string; content: string; fetchedAt: string };
export type StoredContent = { content: string; fetchedAt: string };

// IndexedDBに書けなかった持ち主の最新状態と、本文の控え。
const memory = new Map<string, BacklogState>();
const memoryContent = new Map<string, StoredContent>();
// 持ち主ごとに、IndexedDBへ最後に書けた状態。差分の基準にする。
const saved = new Map<string, BacklogState>();
const contentKey = (ownerId: string, articleId: string) => `${ownerId}\n${articleId}`;
// 持ち主の記録だけを指す範囲。配列のキーでは、配列は文字列より後ろに並ぶ。
const ownerRange = (ownerId: string) => IDBKeyRange.bound([ownerId], [ownerId, []]);

let opening: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  let attempt: Promise<IDBDatabase | null> | null = null;
  attempt = new Promise<IDBDatabase | null>(resolve => {
    let settled = false;
    // 時間切れ・他のタブによる待たされ・失敗のときはメモリーで続け、次の操作で開き直す。
    const giveUp = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (attempt && opening === attempt) opening = null;
      resolve(null);
    };
    const timer = setTimeout(giveUp, OPEN_TIMEOUT_MS);
    try {
      // IndexedDBが無い環境では開き直さない（opening は null を返し続ける）。
      if (typeof indexedDB === 'undefined') { settled = true; clearTimeout(timer); resolve(null); return; }
      const request = indexedDB.open(BACKLOG_DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: ['ownerId', 'articleId'] });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'ownerId' });
        if (!db.objectStoreNames.contains(CONTENT)) db.createObjectStore(CONTENT, { keyPath: ['ownerId', 'articleId'] });
      };
      request.onsuccess = () => {
        const db = request.result;
        // 諦めた後に開けた接続は使わずに閉じる。
        if (settled) { db.close(); return; }
        settled = true;
        clearTimeout(timer);
        // 別のタブが新しい版を開くときは閉じ、次の操作で開き直す。
        db.onversionchange = () => { db.close(); if (opening === attempt) opening = null; };
        resolve(db);
      };
      request.onerror = giveUp;
      request.onblocked = giveUp;
    } catch { giveUp(); }
  });
  opening = attempt;
  return attempt;
}

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const transactionDone = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error ?? new Error('aborted'));
});

// 読み書きを順番に行う。保存の途中で読み込むと古い状態が返るため。
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** 持ち主の端末側バックログを読む。無ければ空の状態。 */
export function loadBacklog(ownerId: string): Promise<BacklogState> {
  return serialized(async () => {
    const fallback = memory.get(ownerId) ?? emptyBacklog(ownerId);
    const db = await openDb();
    if (!db || memory.has(ownerId)) return fallback;
    try {
      const tx = db.transaction([ENTRIES, META], 'readonly');
      const [records, meta] = await Promise.all([
        requestResult(tx.objectStore(ENTRIES).getAll(ownerRange(ownerId))) as Promise<EntryRecord[]>,
        requestResult(tx.objectStore(META).get(ownerId)) as Promise<MetaRecord | undefined>,
      ]);
      const entries = new Map<string, BacklogEntry>();
      for (const record of records) if (record.ownerId === ownerId) entries.set(record.articleId, record.entry);
      const state: BacklogState = {
        ownerId,
        cursor: typeof meta?.cursor === 'string' ? meta.cursor : null,
        entries,
        pendingReads: new Map(Array.isArray(meta?.pendingReads) ? meta.pendingReads : []),
      };
      saved.set(ownerId, state);
      return state;
    } catch { return fallback; }
  });
}

/** 前回保存した状態との差分だけを書き込む。書けなければメモリーに残す。 */
export function saveBacklog(state: BacklogState): Promise<void> {
  return serialized(async () => {
    const { ownerId } = state;
    const db = await openDb();
    const base = saved.get(ownerId);
    // 読み込めなかった持ち主の記録は、上書きして未送信の操作を失わないようメモリーにだけ置く。
    if (!db || !base) { memory.set(ownerId, state); return; }
    try {
      const tx = db.transaction([ENTRIES, META, CONTENT], 'readwrite');
      const entries = tx.objectStore(ENTRIES);
      const content = tx.objectStore(CONTENT);
      for (const [articleId, entry] of state.entries) {
        if (base.entries.get(articleId) !== entry) entries.put({ ownerId, articleId, entry } satisfies EntryRecord);
      }
      for (const articleId of base.entries.keys()) {
        if (!state.entries.has(articleId)) { entries.delete([ownerId, articleId]); content.delete([ownerId, articleId]); }
      }
      if (base.cursor !== state.cursor || base.pendingReads !== state.pendingReads) {
        tx.objectStore(META).put({ ownerId, cursor: state.cursor, pendingReads: [...state.pendingReads] } satisfies MetaRecord);
      }
      await transactionDone(tx);
      saved.set(ownerId, state);
      memory.delete(ownerId);
    } catch {
      // 容量不足などで書けなかった。基準は前回のままにして、次の保存で書き直す。
      memory.set(ownerId, state);
    }
  });
}

/** 記事の本文を保存する。本文はサーバーに置かず、この端末だけに持つ。 */
export async function saveContent(ownerId: string, articleId: string, content: string, fetchedAt: string): Promise<void> {
  const db = await openDb();
  if (db) {
    try {
      const tx = db.transaction(CONTENT, 'readwrite');
      tx.objectStore(CONTENT).put({ ownerId, articleId, content, fetchedAt } satisfies ContentRecord);
      await transactionDone(tx);
      memoryContent.delete(contentKey(ownerId, articleId));
      return;
    } catch { /* メモリーに残す。 */ }
  }
  memoryContent.set(contentKey(ownerId, articleId), { content, fetchedAt });
}

/** 保存した本文を読む。無ければ null。 */
export async function loadContent(ownerId: string, articleId: string): Promise<StoredContent | null> {
  const kept = memoryContent.get(contentKey(ownerId, articleId));
  if (kept) return kept;
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(CONTENT, 'readonly');
    const record = await requestResult(tx.objectStore(CONTENT).get([ownerId, articleId])) as ContentRecord | undefined;
    return record && record.ownerId === ownerId && typeof record.content === 'string' ? { content: record.content, fetchedAt: record.fetchedAt } : null;
  } catch { return null; }
}
