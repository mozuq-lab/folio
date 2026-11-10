/** フィードのアイコン画像のURL。サイトのURL（使えなければフィードのURL）のHTTPSのオリジンを、自前の /api/favicon で取得する。 */
export function faviconSrc(feed: { website: string; url: string }): string | null {
  for (const raw of [feed.website, feed.url]) {
    try {
      const url = new URL(raw);
      // v はブラウザーのキャッシュを探し方の変更に合わせて切り替えるための印（サーバーは見ない）。
      if (url.protocol === 'https:') return `/api/favicon?site=${encodeURIComponent(url.origin)}&v=2`;
    } catch { /* 次の候補を試す */ }
  }
  return null;
}
