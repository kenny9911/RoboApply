'use client';

// components/features/feed/FeedList.tsx — the infinite job list (PRODUCT
// F-FEED-01): skeletons while the first page loads, cards as pages arrive
// (20 per page, cursor), a sentinel that loads the next page when it scrolls
// into view plus a "Show more jobs" button for keyboards and old browsers,
// and "That's every job…" at the end. A job the user hid leaves the list at
// once. On GoApply a public posting that names no source is not shown (D3:
// no card without a source); the server never sends one, so this only guards
// the rule. Nothing else is filtered on the client.

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import type { FeedListState } from '../../../hooks/feed/useFeed';
import { useImpressions } from '../../../hooks/feed/useImpressions';
import { JobCard } from './JobCard';
import { hasNamedSource } from './cardModel';
import styles from './feed.module.css';

export const SKELETON_COUNT = 4;

export interface FeedListProps {
  feed: FeedListState;
  market: 'intl' | 'cn';
  /** Job open in the split view. */
  activeJobId?: string | null;
  onOpen?: (jobId: string) => boolean;
  /** First time a card was on screen (calibration counts these). */
  onSeen?: (jobId: string) => void;
  /** Shown when the first page is empty and the feed has ended. */
  empty?: ReactNode;
  label: string;
  /** A prompt shown inside the list after the card at index `after` (the rating card after 10). */
  inline?: { after: number; node: ReactNode } | null;
}

export function FeedList({ feed, market, activeJobId = null, onOpen, onSeen, empty, label, inline = null }: FeedListProps) {
  const t = useTranslations('jobs.workspace');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const sentinel = useRef<HTMLDivElement>(null);
  const items = useMemo(
    () => feed.items.filter((i) => !hidden.has(i.jobId) && (market !== 'cn' || hasNamedSource(i))),
    [feed.items, hidden, market],
  );
  const tiers = useMemo(() => new Map(feed.items.map((i) => [i.jobId, i.fit?.tier ?? null])), [feed.items]);
  const observe = useImpressions({ sessionId: feed.sessionId, onSeen: (id) => onSeen?.(id), tierOf: (id) => tiers.get(id) ?? null });

  // Load the next page when the sentinel scrolls into view.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage || typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') return undefined;
    const io = new window.IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) fetchNextPage();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (feed.isPending) {
    return (
      <div aria-busy="true" aria-label={t('loading')} role="status">
        <ul className={styles.list}>
          {Array.from({ length: SKELETON_COUNT }, (_, i) => (
            <li key={i} className={styles.skeleton} data-testid="card-skeleton" aria-hidden="true" />
          ))}
        </ul>
      </div>
    );
  }

  if (feed.isError && feed.items.length === 0) {
    return feed.refreshLimited ? (
      <p className={`${styles.notice} ${styles.noticeWarn}`} role="status">
        {t('refreshLimited')}
      </p>
    ) : (
      <div className={styles.prompt} role="alert">
        <h2 className={styles.promptTitle}>{t('errorTitle')}</h2>
        <p className={styles.help}>{t('errorBody')}</p>
        <div className={styles.row}>
          <Btn className={styles.actionBtn} onClick={feed.refetch}>
            {t('retry')}
          </Btn>
        </div>
      </div>
    );
  }

  if (items.length === 0 && feed.endOfFeed && !feed.hasNextPage) {
    return <>{empty ?? null}</>;
  }

  return (
    <div>
      <ul className={styles.list} aria-label={label}>
        {items.map((item, index) => (
          <Fragment key={item.jobId}>
            <li>
              <JobCard
                item={item}
                position={index}
                market={market}
                active={item.jobId === activeJobId}
                onOpen={onOpen}
                onHidden={(id) => setHidden((prev) => new Set(prev).add(id))}
                observe={observe(item.jobId, index)}
              />
            </li>
            {inline && inline.node && index === Math.min(inline.after, items.length - 1) ? <li>{inline.node}</li> : null}
          </Fragment>
        ))}
      </ul>
      <div ref={sentinel} className={styles.sentinel} aria-hidden="true" />
      <div className={styles.listFoot}>
        {feed.hasNextPage ? (
          <Btn className={styles.actionBtn} onClick={feed.fetchNextPage} disabled={feed.isFetchingNextPage}>
            {feed.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
          </Btn>
        ) : feed.endOfFeed ? (
          <p className={styles.help}>{t('endOfFeed')}</p>
        ) : null}
      </div>
    </div>
  );
}
