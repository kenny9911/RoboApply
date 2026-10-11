'use client';

// components/features/feed/AlsoInLocations.tsx — "Also in N more locations"
// under a job card (MARKET_STRATEGY 2.3 step 9; SM-12).
//
// When a company posts the same role in several places, the list shows one
// card (the best ranked of those postings) and the server attaches the others
// to it as `FeedItem.alsoIn`: how many other places, and for each of them the
// place name beside its own job id. The server folds at most ten postings into
// one card (a further place is a card of its own), so every one is named here.
// This control lists them; each opens that posting's own job page (or the
// split view on a wide screen), so every folded posting stays reachable.
// Nothing is merged: saving or applying still acts on the one posting the
// person opened. A count larger than the list (another server version) is said
// in words and never shown as a link that does not exist.
//
// Its own component on purpose: the card (JobCard.tsx) is not touched, and
// FeedList renders this directly under the card of an item that has `alsoIn`.

import type { MouseEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import type { FeedItem } from '../../../lib/api/contracts/feed';
import styles from './feed.module.css';

export interface AlsoInLocationsProps {
  alsoIn: NonNullable<FeedItem['alsoIn']>;
  /** The card's own role and company, for the list's accessible name. */
  title: string;
  company: string;
  /** Opens a job in the split view; true when it did (then the link does not navigate). */
  onOpen?: (jobId: string) => boolean;
}

/** The places that can be named and opened: `locations[i]` belongs to `jobIds[i]`. Pure. */
export function alsoInEntries(alsoIn: NonNullable<FeedItem['alsoIn']>): Array<{ jobId: string; location: string }> {
  const ids = Array.isArray(alsoIn.jobIds) ? alsoIn.jobIds : [];
  const places = Array.isArray(alsoIn.locations) ? alsoIn.locations : [];
  const out: Array<{ jobId: string; location: string }> = [];
  for (let i = 0; i < ids.length; i += 1) {
    const jobId = ids[i];
    const location = places[i];
    if (typeof jobId === 'string' && jobId && typeof location === 'string' && location.trim()) out.push({ jobId, location: location.trim() });
  }
  return out;
}

export function AlsoInLocations({ alsoIn, title, company, onOpen }: AlsoInLocationsProps) {
  const t = useTranslations('jobs.card');
  const entries = alsoInEntries(alsoIn);
  // The number said is the server's count of other places; never fewer than the ones listed here.
  const count = Math.max(Number.isFinite(alsoIn.count) ? Math.floor(alsoIn.count) : 0, entries.length);
  if (count <= 0 || entries.length === 0) return null;
  const unlisted = count - entries.length;

  const open = (jobId: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if (onOpen?.(jobId)) e.preventDefault();
  };

  return (
    <div className={styles.notice} data-testid="also-in">
      <details className={styles.why}>
        <summary>{t('alsoIn', { count })}</summary>
        <ul className={styles.chips} aria-label={t('alsoInList', { title, company })}>
          {entries.map((entry) => (
            <li key={entry.jobId}>
              <Link href={`/jobs/${encodeURIComponent(entry.jobId)}`} className={styles.link} onClick={open(entry.jobId)}>
                {entry.location}
              </Link>
            </li>
          ))}
        </ul>
        {unlisted > 0 ? <p className={styles.help}>{t('alsoInMore', { count: unlisted })}</p> : null}
      </details>
    </div>
  );
}
