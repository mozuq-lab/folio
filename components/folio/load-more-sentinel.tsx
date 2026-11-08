import { useEffect, useRef } from 'react';

/**
 * Invisible marker placed after the article list. When it scrolls within
 * `rootMargin` of the viewport, `onVisible` loads the next page of articles,
 * like an infinite feed. The visible "load more" button stays as a fallback.
 */
export function LoadMoreSentinel({ onVisible, rootMargin = '800px' }: { onVisible: () => void; rootMargin?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onVisible);
  useEffect(() => { callback.current = onVisible; }, [onVisible]);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) callback.current(); }, { rootMargin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [rootMargin]);
  return <div ref={ref} aria-hidden="true" className="load-more-sentinel" />;
}
