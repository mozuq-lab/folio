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
