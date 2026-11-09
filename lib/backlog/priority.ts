import type { Feed } from '../types.ts';
import { MAX_PRIORITY_FEEDS } from './constants.ts';

export type FeedFetchState = { lastFetchedAt: string | null; lastError: string | null };

export const PRIORITY_LIMIT_ERROR = `優先して取得できるのは${MAX_PRIORITY_FEEDS}件までです。`;

/** 優先して取得するかを切り替える。ONは上限まで、OFFは常にできる。 */
export function togglePriority(feeds: Feed[], feedId: string): { feeds: Feed[]; error: string | null } {
  const target = feeds.find(f => f.id === feedId);
  if (!target) return { feeds, error: null };
  if (!target.priority && feeds.filter(f => f.priority).length >= MAX_PRIORITY_FEEDS) return { feeds, error: PRIORITY_LIMIT_ERROR };
  return { feeds: feeds.map(f => f.id === feedId ? { ...f, priority: !f.priority } : f), error: null };
}

/** 取得状況の表示。失敗が最優先。日時は端末のローカル時刻で、今年以外は年も付ける。 */
export function formatFetchState(state: FeedFetchState | undefined, now: Date): string {
  if (state?.lastError) return '取得に失敗しました';
  const at = state?.lastFetchedAt ? new Date(state.lastFetchedAt) : null;
  if (!at || Number.isNaN(at.getTime())) return 'まだ取得していません';
  const time = `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`;
  const date = `${at.getMonth() + 1}/${at.getDate()}`;
  return `最後に取得：${at.getFullYear() === now.getFullYear() ? date : `${at.getFullYear()}/${date}`} ${time}`;
}

/**
 * 「フィードを更新」で取得するフィード。優先フィードがあればそれを、無ければ最後の取得が古い2件を選ぶ
 * （未取得が先。取得状況が分からなければ購読の先頭から2件）。定期取得の選び方と同じ。
 */
export function refreshTargets(feeds: Feed[], states: Record<string, FeedFetchState>): string[] {
  const priority = feeds.filter(f => f.priority);
  if (priority.length) return priority.map(f => f.id);
  const at = (f: Feed) => states[f.id]?.lastFetchedAt ?? '';
  return [...feeds].sort((a, b) => at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0).slice(0, 2).map(f => f.id);
}

/** GET /api/feeds/state の応答（{ feeds: [...] }）を feedId ごとの表に直す。形が違うものは捨てる。 */
export function parseFeedStates(body: unknown): Record<string, FeedFetchState> {
  const out: Record<string, FeedFetchState> = {};
  const rows = body && typeof body === 'object' ? (body as { feeds?: unknown }).feeds : undefined;
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r || typeof r !== 'object' || typeof r.feedId !== 'string') continue;
    out[r.feedId] = { lastFetchedAt: typeof r.lastFetchedAt === 'string' ? r.lastFetchedAt : null, lastError: typeof r.lastError === 'string' ? r.lastError : null };
  }
  return out;
}
