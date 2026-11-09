import type { Feed } from '../types.ts';

/** 「フィードを更新」で同時にサーバーへ頼む数。1回のリクエストで取得するのは1フィードだけ（無料プランのCPU上限のため）。 */
export const REFRESH_CONCURRENCY = 4;

/** kind はサーバーが返す取得失敗の種類（network・http・format・timeout）か、応答が正常でなかったときの server。 */
export type RefreshFailure = { feedId: string; kind: string };

/** 「フィードを更新」で取得するフィード。フィードを表示中ならそのフィードだけ、それ以外は全フィード（優先フィードを先に）。 */
export function refreshTargets(feeds: Feed[], view: string): string[] {
  if (view.startsWith('feed:')) {
    const id = view.slice('feed:'.length);
    return feeds.some(feed => feed.id === id) ? [id] : [];
  }
  return [...new Set([...feeds.filter(feed => feed.priority), ...feeds.filter(feed => !feed.priority)].map(feed => feed.id))];
}

const REASONS: Record<string, string> = {
  network: '配信元に接続できませんでした',
  http: '配信元がエラーを返しました',
  format: 'RSSとして読み込めませんでした',
  timeout: '時間内に応答がありませんでした',
};

/** 取得できなかったフィードの知らせ。1件だけ頼んだときは名前と理由、複数のときは件数。失敗が無ければ空文字。 */
export function refreshFailureMessage(feeds: Feed[], requested: number, failed: RefreshFailure[]): string {
  if (!failed.length) return '';
  if (requested === 1) {
    const name = feeds.find(feed => feed.id === failed[0].feedId)?.name ?? 'フィード';
    const reason = Object.hasOwn(REASONS, failed[0].kind) ? REASONS[failed[0].kind] : 'サーバーで処理できませんでした';
    return `「${name}」を取得できませんでした（${reason}）。`;
  }
  return `${requested}件中${failed.length}件のフィードを取得できませんでした。「フィードの管理」で状況を確認できます。`;
}

/**
 * feedIds を最大 limit 件ずつ並行して1回ずつ頼む。refreshOne は失敗なら RefreshFailure、成功なら null、
 * 続けられない（接続できない・持ち主が替わった）なら 'stop' を返す。stop の後は新しく頼まない。
 */
export async function runRefresh(
  feedIds: string[],
  refreshOne: (feedId: string) => Promise<RefreshFailure | null | 'stop'>,
  options: { limit?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ stopped: boolean; failed: RefreshFailure[] }> {
  const failed: RefreshFailure[] = [];
  let next = 0, done = 0, stopped = false;
  const worker = async () => {
    while (!stopped && next < feedIds.length) {
      const outcome = await refreshOne(feedIds[next++]);
      if (outcome === 'stop') { stopped = true; return; }
      if (outcome) failed.push(outcome);
      options.onProgress?.(++done, feedIds.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.limit ?? REFRESH_CONCURRENCY, feedIds.length) }, worker));
  return { stopped, failed };
}
