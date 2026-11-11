'use client';

// JobMatches — "Your job matches" on the Dashboard, as resume.io lays them out
// (two columns of bordered cards: logo, title, company · location, date).
//
// The list is the first page of the user's own feed — the same query the
// jobs page runs (useActiveSearchProfile + useFeed, "Recommended" order and
// the saved search's fit tier), so the two share one cache and never
// disagree. Each card opens the job in /jobs (`?job=` opens its detail beside
// the list). Dates follow the feed card's rules (cardModel.cardDates): the
// employer's own posted date, otherwise when we first saw the posting.
//
// States: loading (quiet placeholders), the feed switched off for this brand,
// no saved search or no matches yet (a link to set the search up), an error
// (retry). Nothing is invented to fill the grid.

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { useFlag } from '../../../lib/flags';
import { useActiveSearchProfile } from '../../../hooks/search/useSearchProfiles';
import { useFeed } from '../../../hooks/feed/useFeed';
import { cardDates, companyInitial, shortDate } from '../feed/cardModel';
import type { FeedItem } from '../../../lib/api/contracts/feed';
import styles from './dashboard.module.css';

/** How many matches the dashboard shows (three rows of two). */
export const MATCHES_SHOWN = 6;

export function JobMatches() {
  const t = useTranslations('dashboard.matches');
  const feedOn = useFlag('jobs.feed');
  const profiles = useActiveSearchProfile();
  const profile = profiles.profile;
  const feed = useFeed({
    searchProfileId: profile?.id ?? null,
    version: profile?.version ?? null,
    sort: 'recommended',
    fitTier: profile?.filters.fitTier ?? 'all',
    enabled: feedOn && !profiles.isPending,
  });
  const items = feed.items.slice(0, MATCHES_SHOWN);
  const loading = feedOn && (profiles.isPending || (Boolean(profile) && feed.isPending));

  let body: React.ReactNode;
  if (!feedOn) {
    body = <p className={styles.matchesNote}>{t('off')}</p>;
  } else if (loading) {
    body = (
      <ul className={styles.matchGrid} aria-busy="true" aria-label={t('loading')}>
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} className={styles.matchSkeleton} aria-hidden="true" />
        ))}
      </ul>
    );
  } else if (feed.isError) {
    body = (
      <div className={styles.matchesNote}>
        <p>{t('error')}</p>
        <button type="button" className="btn" onClick={() => feed.refetch()}>
          {t('retry')}
        </button>
      </div>
    );
  } else if (!profile || items.length === 0) {
    body = (
      <div className={styles.matchesEmpty}>
        <strong>{t('empty_title')}</strong>
        <p>{t('empty_body')}</p>
        <Link href="/jobs" className="btn primary">
          {t('empty_cta')}
        </Link>
      </div>
    );
  } else {
    body = (
      <ul className={styles.matchGrid}>
        {items.map((item) => (
          <li key={item.jobId}>
            <MatchCard item={item} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className={styles.matches} aria-labelledby="dashboard-matches-title">
      <div className={styles.matchesHead}>
        <h2 id="dashboard-matches-title">{t('title')}</h2>
        {feedOn ? (
          <p>
            {t('update_lead')}{' '}
            <Link href="/jobs">{t('update_link')}</Link>
          </p>
        ) : null}
      </div>
      {body}
    </section>
  );
}

function MatchCard({ item }: { item: FeedItem }) {
  const t = useTranslations('jobs.card');
  const td = useTranslations('dashboard.matches');
  const locale = useLocale();
  const dates = cardDates(item);
  const lead = dates.lead ? shortDate(dates.lead.at, locale) : null;
  const when = lead && dates.lead ? (dates.lead.kind === 'posted' ? t('posted', { date: lead }) : t('firstSeen', { date: lead })) : null;
  const place = [item.company.name, item.location].filter(Boolean).join(' · ');

  return (
    <Link href={`/jobs?job=${encodeURIComponent(item.jobId)}`} className={styles.match} aria-label={td('open_aria', { title: item.title, company: item.company.name })}>
      <span className={styles.matchLogo} aria-hidden="true">
        {item.company.logoUrl ? <img src={item.company.logoUrl} alt="" loading="lazy" /> : <span>{companyInitial(item.company.name)}</span>}
      </span>
      <span className={styles.matchCopy}>
        <strong className={styles.matchTitle}>{item.title}</strong>
        <span className={styles.matchPlace}>{place}</span>
        {when ? <span className={styles.matchWhen}>{when}</span> : null}
      </span>
    </Link>
  );
}
