'use client';

// hooks/feed/useImpressions.ts — which cards were on screen, and for how long
// (ARCHITECTURE.md §3.4 `POST /feed/impressions`, batched; first-party event
// `feed_card_impression`, WP-23).
//
//   const observe = useImpressions({ sessionId, onSeen });
//   <article ref={observe(item.jobId, position)} …>
//
// A card counts as seen when at least half of it has been visible. The time
// on screen is sent when it leaves the screen, when 10 are waiting, every
// 15 s, and when the page hides. Failures are dropped (telemetry never blocks
// the list). Without IntersectionObserver (old browsers, tests) every rendered
// card counts as seen once (the event is sent; no dwell time is reported).

import { useCallback, useEffect, useRef } from 'react';

import { recordImpressions } from '../../lib/api/feed';
import { track } from '../../lib/analytics';

export const IMPRESSION_BATCH = 10;
export const IMPRESSION_FLUSH_MS = 15_000;

interface Pending {
  jobId: string;
  position: number;
  ms: number;
}

export interface ImpressionOptions {
  sessionId: string | null;
  /** Called once per job the first time it is seen. */
  onSeen?: (jobId: string, position: number) => void;
  /** The card's fit tier for the event, when known. */
  tierOf?: (jobId: string) => string | null;
  enabled?: boolean;
}

export function useImpressions({ sessionId, onSeen, tierOf, enabled = true }: ImpressionOptions) {
  const queue = useRef<Pending[]>([]);
  const visibleSince = useRef(new Map<string, number>());
  const positions = useRef(new Map<string, number>());
  const seen = useRef(new Set<string>());
  const nodes = useRef(new Map<string, Element>());
  const observer = useRef<IntersectionObserver | null>(null);
  const session = useRef(sessionId);
  session.current = sessionId;
  const cb = useRef({ onSeen, tierOf });
  cb.current = { onSeen, tierOf };

  const flush = useCallback(() => {
    const sid = session.current;
    const batch = queue.current.splice(0, 100);
    if (!sid || batch.length === 0) return;
    void recordImpressions({ sessionId: sid, positions: batch }).catch(() => undefined);
  }, []);

  const firstSight = useCallback((jobId: string) => {
    if (seen.current.has(jobId)) return;
    seen.current.add(jobId);
    const position = positions.current.get(jobId) ?? 0;
    cb.current.onSeen?.(jobId, position);
    track('feed_card_impression', {
      jobId,
      position,
      tier: cb.current.tierOf?.(jobId) ?? null,
      feedSessionId: session.current,
    });
  }, []);

  const leave = useCallback(
    (jobId: string) => {
      const since = visibleSince.current.get(jobId);
      if (since === undefined) return;
      visibleSince.current.delete(jobId);
      const ms = Math.max(0, Math.min(3_600_000, Math.round(Date.now() - since)));
      queue.current.push({ jobId, position: positions.current.get(jobId) ?? 0, ms });
      if (queue.current.length >= IMPRESSION_BATCH) flush();
    },
    [flush],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    if (typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') return undefined;
    const io = new window.IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const jobId = (entry.target as HTMLElement).dataset.jobId;
          if (!jobId) continue;
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (!visibleSince.current.has(jobId)) visibleSince.current.set(jobId, Date.now());
            firstSight(jobId);
          } else {
            leave(jobId);
          }
        }
      },
      { threshold: [0, 0.5] },
    );
    observer.current = io;
    for (const node of nodes.current.values()) io.observe(node);
    const timer = window.setInterval(flush, IMPRESSION_FLUSH_MS);
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        for (const id of [...visibleSince.current.keys()]) leave(id);
        flush();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.clearInterval(timer);
      io.disconnect();
      observer.current = null;
      for (const id of [...visibleSince.current.keys()]) leave(id);
      flush();
    };
  }, [enabled, firstSight, leave, flush]);

  const refs = useRef(new Map<string, (node: Element | null) => void>());

  /** Ref factory for one card (stable per job and position, so React does not re-attach every render). */
  const make = useCallback(
    (jobId: string, position: number) => (node: Element | null) => {
      positions.current.set(jobId, position);
      const prev = nodes.current.get(jobId);
      if (prev && prev !== node) observer.current?.unobserve(prev);
      if (!node) {
        nodes.current.delete(jobId);
        leave(jobId);
        return;
      }
      nodes.current.set(jobId, node);
      if (!enabled) return;
      if (observer.current) observer.current.observe(node);
      else if (typeof window !== 'undefined' && typeof window.IntersectionObserver !== 'function') {
        // No observer: the card is rendered, count it once.
        if (!seen.current.has(jobId)) queueMicrotask(() => firstSight(jobId));
      }
    },
    [enabled, firstSight, leave],
  );

  useEffect(() => {
    refs.current.clear();
  }, [make]);

  return useCallback(
    (jobId: string, position: number) => {
      const key = `${jobId}:${position}`;
      let ref = refs.current.get(key);
      if (!ref) {
        ref = make(jobId, position);
        refs.current.set(key, ref);
      }
      return ref;
    },
    [make],
  );
}
