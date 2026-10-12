'use client';

// JobTickerView — the live job ticker (F-MKT-02, ruling H19): the newest
// jobs we may show publicly (`publicDisplay`), each worded
// "Found {n} min ago · posted {date}" from `firstSeenAt` and `postedAt`; the
// posted date is left out when it was estimated (the API sends null).
// `now` comes from the server render so the relative times hydrate the same.
// Renders nothing without items.

import Link from 'next/link';

import type { TickerItem } from '../../../lib/api/contracts/seo';
import { useSeoFormat } from './labels';
import styles from './seo.module.css';

const MIN = 60_000;

/** `{ key, n }` for "Found … ago" (minutes under an hour, hours under two days, then days). */
export function foundAgo(firstSeenAt: string, now: Date): { key: 'foundMinutes' | 'foundHours' | 'foundDays'; n: number } {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(firstSeenAt).getTime()) / MIN));
  if (minutes < 60) return { key: 'foundMinutes', n: minutes };
  if (minutes < 48 * 60) return { key: 'foundHours', n: Math.floor(minutes / 60) };
  return { key: 'foundDays', n: Math.floor(minutes / (24 * 60)) };
}

export interface JobTickerViewProps {
  items: readonly TickerItem[];
  /** ISO time of the server render. */
  now: string;
}

export function JobTickerView({ items, now }: JobTickerViewProps) {
  const { t, date } = useSeoFormat();
  if (!items.length) return null;
  const at = new Date(now);
  return (
    <section className={styles.ticker} aria-labelledby="seo-ticker" data-seo-ticker="">
      <h2 className={styles.h2} id="seo-ticker">
        {t('ticker.title')}
      </h2>
      <ul className={styles.tickerList}>
        {items.map((item) => {
          const found = foundAgo(item.firstSeenAt, at);
          const posted = date(item.postedAt);
          return (
            <li key={item.id} className={styles.tickerItem}>
              <Link className={styles.tickerLink} href={item.path}>
                {item.title}
              </Link>
              <div>
                {item.companyName}
                {item.location ? ` · ${item.location}` : ''}
              </div>
              <div>
                {t(`ticker.${found.key}`, { n: found.n })}
                {posted ? ` · ${t('ticker.posted', { date: posted })}` : ''}
              </div>
            </li>
          );
        })}
      </ul>
      <p className={styles.note}>{t('ticker.note')}</p>
    </section>
  );
}
