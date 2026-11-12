'use client';

import { useEffect, type RefObject } from 'react';
import { nextTopbarScroll, type TopbarScroll } from '../lib/topbar-scroll.ts';

/** サイドバーがメニューになる幅（globals.css の @media(max-width:760px) と同じ）。 */
const MOBILE = '(max-width: 760px)';
/** 上部バーの高さ。これより上では常に出す。 */
const REVEAL = 56;
const THRESHOLD = 10;

/**
 * スマホ表示で、下へスクロールしたら上部バーを隠し、上へ戻したら出す（メニューをいつでも開けるように）。
 * 再描画を避けるため、React の state にはせず、ref の要素に data-topbar-hidden を付け外しする。
 */
export function useTopbarScroll(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const media = window.matchMedia(MOBILE);
    let state: TopbarScroll = { hidden: false, anchor: window.scrollY };
    let frame = 0;
    const apply = () => {
      frame = 0;
      const next = media.matches ? nextTopbarScroll(state, window.scrollY, { reveal: REVEAL, threshold: THRESHOLD }) : { hidden: false, anchor: window.scrollY };
      if (next.hidden !== state.hidden) element.toggleAttribute('data-topbar-hidden', next.hidden);
      state = next;
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(apply); };
    window.addEventListener('scroll', onScroll, { passive: true });
    media.addEventListener('change', apply);
    return () => {
      window.removeEventListener('scroll', onScroll);
      media.removeEventListener('change', apply);
      if (frame) cancelAnimationFrame(frame);
      element.removeAttribute('data-topbar-hidden');
    };
  }, [ref]);
}
