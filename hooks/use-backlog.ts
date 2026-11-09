'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadBacklog, saveBacklog } from '../lib/backlog/client-db.ts';
import { acknowledgeReads, applyChanges, changesUrl, expireEntries, forOwner, parseChanges, queueRead, takePendingBatches, type BacklogState } from '../lib/backlog/client-state.ts';
import { runRefresh, type RefreshFailure } from '../lib/backlog/refresh.ts';
import type { BacklogEntry } from '../lib/backlog/types.ts';
import type { Article } from '../lib/types.ts';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const REFRESH_TIMEOUT_MS = 30000;
// サーバーが同じカーソルを返し続けた場合でも止まるようにする。1ページ250件で20万件まで。超えた分は次の同期で続きから取る。
const MAX_PAGES_PER_SYNC = 800;
const OFFLINE_ERROR = 'サーバーに接続できません。接続後に同期します。';
const LOAD_ERROR = '記事を読み込めませんでした。';
const READ_ERROR = '既読を保存できませんでした。';
const OWNER_ERROR = '別のアカウントでログインしています。ページを再読み込みしてください。';

type View = { state: BacklogState | null; lastError: string; articles: Article[] };
export type RefreshOutcome = { completed: boolean; failed: RefreshFailure[] };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const errorText = (body: unknown, fallback: string) => isRecord(body) && typeof body.error === 'string' ? body.error : fallback;

const EMPTY_ARTICLES: Article[] = [];
// 記事の sourceId は配信元から作ったIDなので、購読一覧のフィードID（feedId）にそろえる。
const viewArticle = (entry: BacklogEntry): Article => (entry.article.sourceId === entry.feedId ? entry.article : { ...entry.article, sourceId: entry.feedId }) as Article;
function sortedArticles(entries: Map<string, BacklogEntry>): Article[] {
  const keyed = Array.from(entries.values(), entry => ({ article: viewArticle(entry), time: Date.parse(entry.article.publishedAt) || 0 }));
  keyed.sort((a, b) => b.time - a.time);
  return keyed.map(item => item.article);
}
/** 記事の顔ぶれが同じか。既読だけが変わったときは並べ直さず、前の配列をそのまま使う（数万件で既読のたびに並べ直さない）。 */
function sameArticles(previous: Map<string, BacklogEntry>, next: Map<string, BacklogEntry>): boolean {
  if (previous.size !== next.size) return false;
  for (const [id, entry] of next) {
    const before = previous.get(id);
    if (!before || before.article !== entry.article || before.feedId !== entry.feedId) return false;
  }
  return true;
}

/**
 * 1人の持ち主の端末側バックログを、Reactの描画とは別に持つ。持ち主が変わったら作り直す。
 * サーバーの応答の ownerId がこの持ち主と違えば止まり、以後は何も送らない。
 */
class BacklogSync {
  readonly ownerId: string;
  lastAttemptAt = 0;
  private onChange: (view: View) => void;
  private state: BacklogState | null = null;
  private syncError = '';
  private readError = '';
  private stopError = '';
  private disposed = false;
  private stopped = false;
  // 応答の ownerId を一度確かめるまでは、未送信の既読操作を送らない。
  private verified = false;
  // 読み込み前の既読操作。読み込み後に反映する。
  private early: { ids: string[]; read: boolean }[] = [];
  private loading: Promise<void> = Promise.resolve();
  private saving: Promise<void> = Promise.resolve();
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private flushing: Promise<void> | null = null;
  // 取得中の差分ページより後に送信できた既読操作。そのページの応答では端末の値を残す。
  private getInFlight = false;
  private settled = new Map<string, boolean>();
  private sorted: { entries: Map<string, BacklogEntry> | null; articles: Article[] } = { entries: null, articles: EMPTY_ARTICLES };

  constructor(ownerId: string, onChange: (view: View) => void) {
    this.ownerId = ownerId;
    this.onChange = onChange;
  }

  start(): void {
    this.loading = this.load();
    void this.sync();
  }

  dispose(): void { this.disposed = true; }

  /** 送受信してよい間だけ状態を返す。 */
  private active(): BacklogState | null {
    return this.disposed || this.stopped ? null : this.state;
  }

  private async load(): Promise<void> {
    const loaded = forOwner(await loadBacklog(this.ownerId), this.ownerId);
    if (this.disposed) return;
    let state = expireEntries(loaded, new Date());
    for (const { ids, read } of this.early) state = queueRead(state, ids, read);
    this.early = [];
    this.state = state;
    if (state !== loaded) this.saving = saveBacklog(state);
    this.emit();
  }

  private emit(): void {
    if (!this.disposed) this.onChange({ state: this.state, lastError: this.stopError || this.readError || this.syncError, articles: this.articlesOf(this.state) });
  }

  private articlesOf(state: BacklogState | null): Article[] {
    if (!state) return EMPTY_ARTICLES;
    const { entries } = state;
    const cached = this.sorted;
    if (cached.entries === entries) return cached.articles;
    const articles = cached.entries && sameArticles(cached.entries, entries) ? cached.articles : sortedArticles(entries);
    this.sorted = { entries, articles };
    return articles;
  }

  private commit(next: BacklogState): void {
    if (this.disposed || next === this.state) return;
    this.state = next;
    this.saving = saveBacklog(next);
    this.emit();
  }

  // 既読の送信と差分の取得の失敗は分けて持つ。差分の取得に成功しても、未送信の既読があることは知らせ続ける。
  private setErrors(patch: { sync?: string; read?: string }): void {
    if (this.disposed) return;
    const sync = patch.sync ?? this.syncError;
    const read = patch.read ?? this.readError;
    if (sync === this.syncError && read === this.readError) return;
    this.syncError = sync;
    this.readError = read;
    this.emit();
  }

  private stop(): void {
    if (this.disposed || this.stopped) return;
    this.stopped = true;
    this.stopError = OWNER_ERROR;
    this.emit();
  }

  private request(url: string, init: RequestInit = {}, timeout = REQUEST_TIMEOUT_MS): Promise<Response> {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(timeout), ...init });
  }

  setRead(ids: string[], read: boolean): void {
    if (this.disposed || !ids.length) return;
    if (!this.state) { this.early.push({ ids: [...ids], read }); return; }
    // 先に端末へ保存し（flushが保存の完了を待つ）、それから送る。止まった後も端末には残す。
    this.commit(queueRead(this.state, ids, read));
    void this.flush();
  }

  /** 既読を記録して送り、指定の記事がすべてサーバーに届いたかを返す。届かなかった分は端末に残り、次の同期で送る。 */
  async setReadAndSend(ids: string[], read: boolean): Promise<boolean> {
    if (this.disposed || !ids.length) return !ids.length;
    this.setRead(ids, read);
    await this.flush();
    const state = this.active();
    return !!state && this.verified && ids.every(id => state.pendingReads.get(id) !== read);
  }

  flush(): Promise<void> {
    if (!this.verified || !this.active()) return Promise.resolve();
    this.flushing ??= this.sendReads().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async sendReads(): Promise<void> {
    for (;;) {
      await this.saving.catch(() => undefined);
      const state = this.active();
      if (!state || !this.verified) return;
      const [batch] = takePendingBatches(state);
      if (!batch) return;
      let response: Response;
      let body: unknown;
      try {
        response = await this.request('/api/articles/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
        body = await response.json().catch(() => null);
      } catch { this.setErrors({ read: OFFLINE_ERROR }); return; }
      const current = this.active();
      if (!current) return;
      if (response.ok) {
        // 別の利用者として保存された。操作は残し、以後は送らない。
        if (!isRecord(body) || body.ownerId !== this.ownerId) { this.stop(); return; }
        if (this.getInFlight) {
          for (const id of batch.ids) this.settled.set(id, batch.read);
          // 取得中のページは送信前の内容なので、同じ同期の中でもう一度取りに行く。
          this.syncAgain = true;
        }
        this.commit(acknowledgeReads(current, batch));
        this.setErrors({ read: '' });
        continue;
      }
      if (response.status === 400) {
        // 内容が受け付けられない操作は再送しても通らないので捨てる。
        this.commit(acknowledgeReads(current, batch));
        this.setErrors({ read: errorText(body, READ_ERROR) });
        continue;
      }
      // ログイン切れや通信の不調。操作は端末に残し、次の同期で送る。
      this.setErrors({ read: errorText(body, READ_ERROR) });
      return;
    }
  }

  sync(): Promise<void> {
    if (this.disposed || this.stopped) return Promise.resolve();
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    this.syncing = (async () => {
      do { this.syncAgain = false; await this.pull(); } while (this.syncAgain && this.active());
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async pull(): Promise<void> {
    await this.loading;
    if (!this.active()) return;
    this.lastAttemptAt = Date.now();
    await this.flush();
    let restarted = false;
    for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const before = this.active();
      if (!before) return;
      const cursor = before.cursor;
      this.settled = new Map();
      this.getInFlight = true;
      let response: Response;
      let body: unknown;
      try {
        response = await this.request(changesUrl(cursor));
        body = await response.json().catch(() => null);
      } catch { this.setErrors({ sync: OFFLINE_ERROR }); return; } finally { this.getInFlight = false; }
      const state = this.active();
      if (!state) return;
      if (response.status === 400 && cursor !== null && !restarted) {
        // カーソルを受け付けられなかった。手元の記事は残したまま最初から取り直す。
        restarted = true;
        this.commit({ ...state, cursor: null });
        continue;
      }
      if (!response.ok) { this.setErrors({ sync: errorText(body, LOAD_ERROR) }); return; }
      // 別の利用者の記事は手元のバックログに混ぜず、以後は何も送らない。
      if (!isRecord(body) || body.ownerId !== this.ownerId) { this.stop(); return; }
      const changes = parseChanges(body);
      if (!changes) { this.setErrors({ sync: LOAD_ERROR }); return; }
      this.commit(applyChanges(state, changes.entries, changes.next, this.settled));
      if (!this.verified) {
        // 持ち主を確かめられたので、未送信の既読操作を送る。
        this.verified = true;
        await this.flush();
      }
      if (!changes.hasMore || changes.next === cursor) break;
    }
    const state = this.active();
    if (!state) return;
    this.commit(expireEntries(state, new Date()));
    this.setErrors({ sync: '' });
  }

  /**
   * サーバーに feedIds の取得を頼み、終わったら差分を受け取る。
   * completed は、すべて頼み終えて差分も受け取れたか。取得できなかったフィードは failed に入る。
   */
  async refreshFeeds(feedIds: string[], onProgress?: (done: number, total: number) => void): Promise<RefreshOutcome> {
    await this.loading;
    // 持ち主を確かめる前は、先に差分を1回取得して確かめる。
    if (!this.verified) await (this.syncing ?? this.sync());
    if (!this.active() || !this.verified) return { completed: false, failed: [] };
    // 1回のリクエストで取得するのは1フィードだけ（無料プランのCPU上限のため）。数件ずつ並行して頼む。
    const { stopped, failed } = await runRefresh(feedIds, async feedId => {
      if (!this.active()) return 'stop';
      try {
        const response = await this.request(`/api/feeds/refresh?feed=${encodeURIComponent(feedId)}`, { method: 'POST' }, REFRESH_TIMEOUT_MS);
        const body: unknown = await response.json().catch(() => null);
        // 404はまだサーバーに同期されていないフィード。次の同期後に取得できる。
        if (response.status === 404) return null;
        if (!response.ok) return { feedId, kind: 'server' };
        return isRecord(body) && typeof body.error === 'string' ? { feedId, kind: body.error } : null;
      } catch { this.setErrors({ sync: OFFLINE_ERROR }); return 'stop'; }
    }, { onProgress });
    if (stopped) return { completed: false, failed };
    await this.sync();
    return { completed: !!this.active() && this.syncError === '', failed };
  }
}


/** サーバーに蓄積された記事の、この端末での写し。ownerId は同期で確かめた持ち主のID。 */
export function useBacklog(ownerId: string | null) {
  const [view, setView] = useState<View>({ state: null, lastError: '', articles: EMPTY_ARTICLES });
  const controllerRef = useRef<BacklogSync | null>(null);

  useEffect(() => {
    if (!ownerId) return;
    const controller = new BacklogSync(ownerId, setView);
    controllerRef.current = controller;
    controller.start();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void controller.sync();
    }, SYNC_INTERVAL_MS);
    const visibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - controller.lastAttemptAt >= SYNC_INTERVAL_MS) void controller.sync();
    };
    const online = () => { void controller.sync(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', online);
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', online);
    };
  }, [ownerId]);

  // 前の持ち主の状態が残っていても表示しない。
  const state = ownerId && view.state?.ownerId === ownerId ? view.state : null;
  const entries = state?.entries;
  const pendingReads = state?.pendingReads;
  const articles = state ? view.articles : EMPTY_ARTICLES;
  const readIds = useMemo(() => {
    const ids = new Set<string>();
    if (entries) for (const [id, entry] of entries) if (entry.readAt !== null) ids.add(id);
    if (pendingReads) for (const [id, read] of pendingReads) { if (read) ids.add(id); else ids.delete(id); }
    return ids;
  }, [entries, pendingReads]);

  // 描画中の持ち主と違う controller（切り替え直後に残ったもの）には頼まない。
  const controllerFor = useCallback(() => {
    const controller = controllerRef.current;
    return controller && controller.ownerId === ownerId ? controller : null;
  }, [ownerId]);
  const setRead = useCallback((ids: string[], read: boolean) => { controllerFor()?.setRead(ids, read); }, [controllerFor]);
  const sync = useCallback(async () => { await controllerFor()?.sync(); }, [controllerFor]);
  const refreshFeeds = useCallback(async (feedIds: string[], onProgress?: (done: number, total: number) => void): Promise<RefreshOutcome> =>
    (await controllerFor()?.refreshFeeds(feedIds, onProgress)) ?? { completed: false, failed: [] }, [controllerFor]);
  // まとめて既読用。送れたかどうかを返す（送れなかった分も端末には残る）。
  const sendRead = useCallback(async (ids: string[], read: boolean) => (await controllerFor()?.setReadAndSend(ids, read)) ?? false, [controllerFor]);

  return { ready: state !== null, articles, readIds, setRead, sendRead, sync, refreshFeeds, lastError: state ? view.lastError : '' };
}
