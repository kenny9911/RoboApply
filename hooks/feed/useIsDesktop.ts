'use client';

// hooks/feed/useIsDesktop.ts — wide enough for the split view (list + detail
// side by side, PRODUCT F-FEED-01). Below this width a job opens as its own
// page (/jobs/[id]). Server render and the first client render assume a
// phone, so nothing flashes a split layout on a small screen.

import { useSyncExternalStore } from 'react';

export const SPLIT_VIEW_QUERY = '(min-width: 1024px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const mq = window.matchMedia(SPLIT_VIEW_QUERY);
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }
  mq.addListener?.(onChange);
  return () => mq.removeListener?.(onChange);
}

function snapshot(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(SPLIT_VIEW_QUERY).matches;
}

export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
