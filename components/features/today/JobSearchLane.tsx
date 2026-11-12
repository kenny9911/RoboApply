'use client';

// JobSearchLane — the "Job search" lane of /today (docs/agent-driven/REDESIGN.md §5.3).
//
//   evidence  one past-tense line from a real count (ruling C38): the Jobs nav
//             badge's own number, with the date it starts from. Not loaded or
//             failed reads "—", never 0.
//   picks     the three best. With Ready to apply on they are the top fits not
//             yet on the user's list; without it, the top of the Jobs list.
//             Each row leads with the gap (ruling R2), then what lines up, the
//             tier and score with "This is not your chance of getting hired."
//             under them (C5: never one without the other), then company ·
//             title · location and ONE action.
//   action    `Prepare application` (it puts the job on the list, shows the
//             cost before anything is spent, then starts the preparation).
//             Without Ready to apply the action is the job's own page.
//
// D1: nothing here applies. Preparing tailors the resume and writes the
// letter; the user opens the application and submits it.
//
// The rows on screen are HELD while the picks stay loaded (`useHeldPicks`).
// `Prepare application` first puts the job on the user's list, and a job on the
// list is no longer a suggestion: the refreshed picks come back without it. If
// the lane followed them, the row would vanish under the user's hand together
// with the cost sheet it had just opened, and nothing would be prepared. So a
// row that was shown stays (it turns into "Being prepared"), nothing is
// reordered while someone reads, and a new list is taken only after the picks
// were asked for afresh (the search changed: GoalLine resets them).
//
// GoApply (market `cn`): a posting is never shown without where it was
// published (D3; the Jobs list's own rule, cardModel `hasNamedSource`). So a
// pick with no named source is left out there, and each row names its source.

import Link from 'next/link';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { FitTierLabel, HonestyLine, IconArrow } from '../../v3/primitives';
import type { FeedItem } from '../../../lib/api/contracts/feed';
import { useBrand } from '../../../lib/brand/BrandProvider';
import type { Loadable, NewJobs, TodayFlags, TodaySources } from '../../../hooks/today';
import { PrepareApplicationButton } from '../agent';
import { normalizeScore, type FitTierKey } from '../common';
// The Jobs card's pure helpers, from their own file (no UI): `hasNamedSource` is not part of the feed's index.
import { hasNamedSource, sourceLine } from '../feed/cardModel';
import { FailedNote, Lane, Unknown } from './parts';
import { PICKS_ANCHOR } from './WaitingList';
import styles from './today.module.css';

/** Path of a job's own page. */
export function jobHref(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}`;
}

/** The picks a market may show: on GoApply only postings that name where they were published. Pure. */
export function shownPicks(items: readonly FeedItem[], market: 'intl' | 'cn'): FeedItem[] {
  return market === 'cn' ? items.filter(hasNamedSource) : [...items];
}

/**
 * The picks as first shown, kept while the read stays loaded. A refresh updates
 * a held row's own data (its fit) and neither removes nor adds rows; a pass
 * through loading (the picks were reset) starts again with the new answer.
 */
export function useHeldPicks(picks: Loadable<FeedItem[]>): Loadable<FeedItem[]> {
  const [held, setHeld] = useState<FeedItem[] | null>(null);
  if (picks.status !== 'ready') {
    if (held !== null) setHeld(null);
    return picks;
  }
  const fresh = picks.data;
  // The first answer; also the first one with anything in it (an empty lane has no row to keep).
  if (held === null || (held.length === 0 && fresh.length > 0)) {
    setHeld(fresh);
    return picks;
  }
  const latest = new Map(fresh.map((item) => [item.jobId, item]));
  return { status: 'ready', data: held.map((item) => latest.get(item.jobId) ?? item) };
}

function Evidence({ newJobs }: { newJobs: Loadable<NewJobs> }) {
  const t = useTranslations('today');
  const format = useFormatter();
  if (newJobs.status === 'off') return null;
  if (newJobs.status !== 'ready') {
    return (
      <p className={styles.evidence} data-testid="today-evidence" data-known="false">
        {t('jobSearch.foundUnknown')} <Unknown />
      </p>
    );
  }
  const { count, since, capped } = newJobs.data;
  const date = since ? format.dateTime(new Date(since), { month: 'short', day: 'numeric' }) : null;
  const line = capped
    ? date
      ? t('jobSearch.foundCapped', { count, date })
      : t('jobSearch.foundCappedSinceVisit', { count })
    : date
      ? t('jobSearch.found', { count, date })
      : t('jobSearch.foundSinceVisit', { count });
  return (
    <p className={styles.evidence} data-testid="today-evidence" data-known="true">
      {line}
    </p>
  );
}

function PickRow({ item, agent, withSource, lead }: { item: FeedItem; agent: boolean; withSource: boolean; lead: boolean }) {
  const t = useTranslations('today');
  const tAny = useTranslations();
  const fit = item.fit;
  const score = normalizeScore(fit?.score);
  const tier = (fit?.tier ?? null) as FitTierKey | null;
  const href = jobHref(item.jobId);
  // The Jobs card's own source sentence; a posting whose card needs none (a verified employer's own post) is named plainly.
  const sourceText = (): string | null => {
    const line = sourceLine(item);
    if (line?.key === 'bank') return tAny('jobs.card.source.bank', { sourceName: line.sourceName });
    if (line?.key === 'user_import') return tAny('jobs.card.source.user_import');
    if (line) return tAny(`jobs.card.source.${line.key}`, { name: line.name });
    const name = item.source?.name?.trim() || (typeof item.source?.original === 'string' ? item.source.original.trim() : '');
    return name ? tAny('jobs.card.source.provider', { name }) : null;
  };
  const source = withSource ? sourceText() : null;

  return (
    <li className={styles.pick} data-testid="today-pick" data-job-id={item.jobId}>
      {fit ? (
        <>
          <div className={styles.pickTop}>
            <div className={styles.lead}>
              {fit.topGap ? (
                <p className={styles.gap} data-testid="pick-gap">
                  <span className={styles.leadLabel}>{tAny('jobs.card.leadLabel', { label: tAny('jobs.card.whatsMissing') })}</span> {fit.topGap}
                </p>
              ) : null}
              {fit.topOverlap ? (
                <p className={styles.overlap} data-testid="pick-overlap">
                  <span className={styles.leadLabel}>{tAny('jobs.card.leadLabel', { label: tAny('jobs.card.whatLinesUp') })}</span> {fit.topOverlap}
                </p>
              ) : null}
            </div>
            <div className={styles.corner} data-testid="pick-fit">
              {/* No tier word without a number: an unknown score is "—", never a tier. */}
              <FitTierLabel tier={score === null ? null : tier} score={score} estimate={fit.kind === 'pre'} />
              <span className={styles.score}>{score === null ? '—' : tAny('jobs.score.unit', { score })}</span>
            </div>
          </div>
          {/* C5: wherever a tier or score shows, so does this line. */}
          <HonestyLine kind="fit" />
        </>
      ) : null}

      <div className={styles.pickBottom}>
        <p className={styles.identity}>
          <span className={styles.company}>{item.company.name}</span>
          <span className={styles.sep} aria-hidden="true">
            ·
          </span>
          {agent ? (
            <Link href={href} className={styles.jobLink} aria-label={tAny('jobs.card.openJob', { title: item.title, company: item.company.name })}>
              {item.title}
            </Link>
          ) : (
            <span className={styles.company}>{item.title}</span>
          )}
          {item.location ? (
            <>
              <span className={styles.sep} aria-hidden="true">
                ·
              </span>
              <span>{item.location}</span>
            </>
          ) : null}
          {source ? (
            <>
              <span className={styles.sep} aria-hidden="true">
                ·
              </span>
              <span data-testid="pick-source">{source}</span>
            </>
          ) : null}
        </p>
        {/* Three rows share one action word: the group names the job it acts on. */}
        <div role="group" aria-label={tAny('jobs.card.actions.label', { title: item.title })}>
          {agent ? (
            <PrepareApplicationButton jobId={item.jobId} variant={lead ? 'primary' : 'default'} addedVia="suggestions" />
          ) : (
            <Link href={href} className={lead ? 'btn primary' : 'btn'} data-testid="pick-view">
              {t('jobSearch.viewJob')}
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

export interface JobSearchLaneProps {
  flags: TodayFlags;
  newJobs: TodaySources['newJobs'];
  picks: TodaySources['picks'];
  picksFrom: TodaySources['picksFrom'];
  /**
   * Nothing waits for the user, so the first pick is the next move: its action
   * is the screen's one primary button (a new account has no waiting card, and
   * three equal buttons give no first step). False while a waiting card holds
   * the primary button, and while the waiting list is still loading.
   */
  leadPrimary?: boolean;
}

export function JobSearchLane({ flags, newJobs, picks: latestPicks, picksFrom, leadPrimary = false }: JobSearchLaneProps) {
  const t = useTranslations('today');
  const cn = useBrand().market === 'cn';
  const picks = useHeldPicks(latestPicks);
  // No list to pick from on this account (the Jobs list is off and so is Ready to apply).
  const off = flags.ready && picksFrom === null && newJobs.status === 'off';
  const failures = [newJobs, picks].filter((r): r is Extract<Loadable<unknown>, { status: 'error' }> => r.status === 'error');
  const rows = picks.status === 'ready' ? shownPicks(picks.data, cn ? 'cn' : 'intl') : [];

  return (
    <Lane id={PICKS_ANCHOR} title={t('jobSearch.title')} agent busy={picks.status === 'loading'} testId="today-job-search">
      {off ? (
        <p className={styles.evidence} data-testid="today-jobs-off">
          {t('jobSearch.off')}
        </p>
      ) : (
        <>
          <Evidence newJobs={newJobs} />

          {picks.status === 'loading' ? (
            <div role="status">
              <span className={styles.srOnly}>{t('jobSearch.picksLoading')}</span>
              <div className={styles.skeletons} aria-hidden="true">
                <div className={styles.skeletonRow} />
                <div className={styles.skeletonRow} />
                <div className={styles.skeletonRow} />
              </div>
            </div>
          ) : picks.status === 'ready' ? (
            rows.length > 0 ? (
              <div>
                <h3 className={styles.subTitle}>{t('jobSearch.picksTitle')}</h3>
                <ul className={styles.picks} aria-label={t('jobSearch.picksTitle')}>
                  {rows.map((item, index) => (
                    <PickRow key={item.jobId} item={item} agent={flags.agent} withSource={cn} lead={leadPrimary && index === 0} />
                  ))}
                </ul>
              </div>
            ) : (
              <p className={styles.note} data-testid="today-picks-none">
                {t('jobSearch.picksNone')}
              </p>
            )
          ) : null}

          {failures.length > 0 ? (
            <FailedNote message={picks.status === 'error' ? t('jobSearch.picksFailed') : t('laneFailed')} onRetry={() => failures.forEach((f) => f.retry())} />
          ) : null}
        </>
      )}

      <div className={styles.laneFoot}>
        <Link href="/jobs" className="btn ghost">
          {t('jobSearch.seeAll')}
          <IconArrow size={14} />
        </Link>
      </div>
    </Lane>
  );
}
