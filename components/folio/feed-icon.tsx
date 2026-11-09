'use client';

import { useState } from 'react';
import { faviconSrc } from '../../lib/favicon-src';
import type { Feed } from '../../lib/types';

/** フィードのアイコン。ファビコンを重ねて表示し、読み込めないときは色付きの頭文字のまま。 */
export function FeedIcon({ feed, fallback }: { feed?: Pick<Feed, 'website' | 'url' | 'color' | 'initial'>; fallback?: string }) {
  const src = feed ? faviconSrc(feed) : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return <span className="source-avatar feed-icon" style={{ background: feed?.color || '#4a6e5c' }} aria-hidden="true">
    {feed?.initial || Array.from(fallback ?? '')[0] || ''}
    {/* 画面の最初の描画より前に読み込みに失敗していると onError が届かないので、表示した時点でも確かめる。 */}
    {src && failedSrc !== src && <img ref={image => { if (image?.complete && image.naturalWidth === 0) setFailedSrc(src); }} src={src} alt="" loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />}
  </span>;
}
