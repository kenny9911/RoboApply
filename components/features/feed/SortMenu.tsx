'use client';

// components/features/feed/SortMenu.tsx — the feed's sort (PRODUCT F-FEED-02,
// F-MATCH-05 "Your best fits") with the link to the public "How ranking
// works" page (/help/ranking, WP-40), which lists every ranking factor.
// "Applications closing soonest" exists only on GoApply (campus deadlines).

import { useId } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import type { FeedSort } from '../../../lib/api/contracts/feed';
import styles from './feed.module.css';

const INTL_SORTS: readonly FeedSort[] = ['recommended', 'newest', 'best_fit', 'highest_pay'];
const CN_SORTS: readonly FeedSort[] = [...INTL_SORTS, 'deadline'];

/** Sorts offered on each market. Pure. */
export function sortsFor(market: 'intl' | 'cn'): readonly FeedSort[] {
  return market === 'cn' ? CN_SORTS : INTL_SORTS;
}

/** The sort a `/jobs?sort=<key>` link asks for, or null when the key is missing or not offered on this market. Pure. */
export function sortFromQuery(raw: string | null | undefined, market: 'intl' | 'cn'): FeedSort | null {
  const options = sortsFor(market);
  return raw && (options as readonly string[]).includes(raw) ? (raw as FeedSort) : null;
}

export interface SortMenuProps {
  value: FeedSort;
  market: 'intl' | 'cn';
  onChange: (sort: FeedSort) => void;
}

export function SortMenu({ value, market, onChange }: SortMenuProps) {
  const t = useTranslations('jobs.workspace');
  const id = useId();
  const options = sortsFor(market);
  return (
    <div className={styles.sort}>
      <label htmlFor={id}>{t('sortLabel')}</label>
      <select id={id} className={styles.select} value={options.includes(value) ? value : 'recommended'} onChange={(e) => onChange(e.target.value as FeedSort)}>
        {options.map((s) => (
          <option key={s} value={s}>
            {t(`sort.${s}`)}
          </option>
        ))}
      </select>
      <Link href="/help/ranking" className={styles.link}>
        {t('howRanking')}
      </Link>
    </div>
  );
}
