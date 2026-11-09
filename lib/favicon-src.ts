/** フィードのアイコン画像のURL。サイトのURL（使えなければフィードのURL）のHTTPSのオリジンを、自前の /api/favicon で取得する。 */
export function faviconSrc(feed: { website: string; url: string }): string | null {
  for (const raw of [feed.website, feed.url]) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:') return `/api/favicon?site=${encodeURIComponent(url.origin)}`;
    } catch { /* 次の候補を試す */ }
  }
  return null;
}
