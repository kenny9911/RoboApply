'use client';

// components/features/feed/JobsWorkspace.tsx — /jobs, the "For you" tab
// (PRODUCT F-FEED-01/02/09/10, F-MATCH-05, F-GROW-07; TASK_PLAN.md WP-33).
//
//   header        title, intro, "You and what employers ask" (/jobs/report,
//                 flag `competitiveness`)
//   tabs          For you · Explore · Added by you
//   prompts       "Looks better / Not quite" (after an Assistant change),
//                 the skills check, the getting-started checklist
//   filters       FilterBar (WP-20) with the "Hiding {n} weaker fits" number
//   sort          Recommended · Newest · Your best fits · Highest pay
//                 (+ GoApply deadline) and "How ranking works". `?sort=<key>`
//                 opens the list in that order (the Assistant's "Show jobs
//                 sorted this way" link); a key this market does not offer is
//                 ignored. Picking a sort keeps the address in step.
//   list          infinite, 20 per page; the rating card after 10 cards
//   split detail  desktop `?job=<id>` renders JobDetailPanel (WP-34) beside
//                 the list; on a phone a job opens as /jobs/[id]
//
// The feed is on by default on both brands (D5). With `jobs.feed` switched
// off (GoApply: CN_RECRUITMENT_INFO_MODE=off) there is no list at all, only
// the way to jobs the user adds and, on GoApply, "Search other job sites"
// (links the user opens themselves, started from their saved search words).
//
// GoApply header (D3; MARKET_STRATEGY §1.4): under the intro, a line built
// from the response's own `sources` says where the postings come from, and a
// thin result set shows the same search links under the list. Both read the
// first page from the query cache (useFeedFirstPage); nothing is requested twice.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import { FilterBar } from '../filters';
import { GettingStartedChecklist } from '../growth';
import { JobDetailPanel } from '../job';
import { CnFeedSources, ExternalSearchPanel } from '../market';
import { cnFeedSummary } from '../../../lib/api/cnJobs';
import { useFeedFirstPage } from './useFeedFirstPage';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { useFlag } from '../../../lib/flags';
import { useActiveSearchProfile } from '../../../hooks/search';
import { useFeed } from '../../../hooks/feed/useFeed';
import { feedKeys } from '../../../hooks/feed/keys';
import { SPLIT_VIEW_QUERY, useIsDesktop } from '../../../hooks/feed/useIsDesktop';
import { RATING_AFTER_CARDS, useCalibration, useSeenCounter, useSkillsCheckData } from '../../../hooks/feed/useCalibration';
import type { FeedSort, NewCountResponse } from '../../../lib/api/contracts/feed';
import { AfterChangeCheck } from './AfterChangeCheck';
import { FeedList } from './FeedList';
import { FeedTabs, feedTabPanelProps } from './FeedTabs';
import { RatingCard, RatingFixes, type RatingFix } from './RatingCard';
import { SkillsCheck } from './SkillsCheck';
import { SortMenu, sortFromQuery, sortsFor } from './SortMenu';
import { ZeroResults } from './ZeroResults';
import styles from './feed.module.css';

export function JobsWorkspace() {
  const t = useTranslations('jobs.workspace');
  const brand = useBrand();
  const market = brand.market;
  const feedOn = useFlag('jobs.feed');
  const reportOn = useFlag('competitiveness');
  const router = useRouter();
  const pathname = usePathname() ?? '/jobs';
  const params = useSearchParams();
  const jobParam = params?.get('job') ?? null;
  const desktop = useIsDesktop();

  const profiles = useActiveSearchProfile();
  const profile = profiles.profile;
  // `?sort=` picks the order; anything this market's menu does not offer is ignored.
  const urlSort = sortFromQuery(params?.get('sort') ?? null, market);
  const [sort, setSortState] = useState<FeedSort>(urlSort ?? 'recommended');
  // A link to /jobs?sort=… followed while the page is already open (the
  // Assistant rail) changes the query, not the component: follow it.
  const [seenUrlSort, setSeenUrlSort] = useState<FeedSort | null>(urlSort);
  if (urlSort !== seenUrlSort) {
    setSeenUrlSort(urlSort);
    if (urlSort) setSortState(urlSort);
  }
  const setSort = useCallback(
    (next: FeedSort) => {
      setSortState(next);
      const query = new URLSearchParams(params?.toString() ?? '');
      if (next === 'recommended') query.delete('sort');
      else query.set('sort', next);
      const qs = query.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  const fitTier = profile?.filters.fitTier ?? 'all';

  const feed = useFeed({
    searchProfileId: profile?.id ?? null,
    version: profile?.version ?? null,
    sort: sortsFor(market).includes(sort) ? sort : 'recommended',
    fitTier,
    enabled: feedOn && !profiles.isPending,
  });

  // What the server said about this list: where its rows come from, whether
  // it is thin, and whether it is ordered by date (GoApply header; D3).
  const firstPage = useFeedFirstPage({
    searchProfileId: profile?.id ?? null,
    version: profile?.version ?? null,
    sort: sortsFor(market).includes(sort) ? sort : 'recommended',
    fitTier,
  });
  const cnSummary = market === 'cn' && feedOn ? cnFeedSummary(firstPage) : { header: null, thin: false };
  // Ordered by date posted (personalised ranking is off): the intro must not say "ranked by your resume".
  const byDate = feedOn && firstPage?.order === 'recency';

  const listKey = `${profile?.id ?? ''}:${profile?.version ?? 0}:${sort}:${fitTier}`;
  const [seenCount, markSeen] = useSeenCounter(listKey);
  const calibration = useCalibration({ seenCount, enabled: feedOn && feed.items.length > 0 });
  const skillsData = useSkillsCheckData(calibration.skills.show);
  // Fixes a low rating offers. Kept here, outside FeedList, so a list reload
  // (a saved fix changes the search) keeps them and never re-asks for a rating.
  const [ratingFixes, setRatingFixes] = useState<RatingFix[] | null>(null);
  const onRated = (fixes: RatingFix[]) => {
    calibration.rating.markRated();
    setRatingFixes(fixes.length ? fixes : null);
  };

  // Opening the feed is the visit the Jobs nav badge counts from: once the
  // first page is on screen, the badge's "N new" is cleared at once (and a
  // read still in flight is dropped) instead of lingering until its next poll.
  const qc = useQueryClient();
  const firstPageLoaded = feedOn && !feed.isPending && !feed.isError;
  useEffect(() => {
    if (!firstPageLoaded) return;
    void qc.cancelQueries({ queryKey: feedKeys.newCount() });
    qc.setQueryData<NewCountResponse>(feedKeys.newCount(), { count: 0, since: null });
  }, [firstPageLoaded, qc]);

  // A shared `/jobs?job=<id>` link on a phone opens the job's own page.
  // Read the media query itself: during hydration `desktop` is still false.
  useEffect(() => {
    if (!jobParam || desktop || typeof window === 'undefined' || !window.matchMedia) return;
    if (!window.matchMedia(SPLIT_VIEW_QUERY).matches) router.replace(`/jobs/${encodeURIComponent(jobParam)}`);
  }, [jobParam, desktop, router]);

  const openJob = useCallback(
    (jobId: string) => {
      if (!desktop) return false;
      const next = new URLSearchParams(params?.toString() ?? '');
      next.set('job', jobId);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
      return true;
    },
    [desktop, params, pathname, router],
  );

  const closeJob = useCallback(() => {
    const next = new URLSearchParams(params?.toString() ?? '');
    next.delete('job');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  const splitOpen = desktop && !!jobParam;

  return (
    <div className={styles.workspace}>
      <header className={styles.head}>
        <h1 className={styles.title}>{t('title')}</h1>
        <p className={styles.intro}>{byDate ? t('introByDate') : t('intro')}</p>
        {/* GoApply only (renders nothing on RoboApply): where the postings below come from. */}
        <CnFeedSources header={cnSummary.header} />
        {reportOn && feedOn ? (
          <div className={styles.headLinks}>
            <Link href="/jobs/report" className={styles.link}>
              {t('reportLink')}
            </Link>
          </div>
        ) : null}
      </header>

      <FeedTabs active={feedOn ? 'forYou' : 'added'} feedOn={feedOn} />

      <div {...feedTabPanelProps(feedOn ? 'forYou' : 'added')} className={styles.workspace}>
        {!feedOn ? (
          <>
            <div className={styles.prompt}>
              <p className={styles.help}>{t('feedOff')}</p>
              <div className={styles.row}>
                <Link href="/jobs/added" className={styles.link}>
                  {t('addJob')}
                </Link>
              </div>
            </div>
            {/* GoApply only (renders nothing on RoboApply). */}
            <ExternalSearchPanel initialQuery={profile?.filters.q ?? profile?.filters.titles?.[0] ?? null} />
          </>
        ) : (
          <>
            <AfterChangeCheck />
            {calibration.skills.show && skillsData.data ? <SkillsCheck data={skillsData.data} onClose={calibration.skills.close} /> : null}
            <GettingStartedChecklist variant="card" />

            <div className={styles.filters}>
              <FilterBar hiddenWeakerFits={feed.hiddenByTier} />
            </div>
            <div className={styles.toolbar}>
              <SortMenu value={sort} market={market} onChange={setSort} />
            </div>

            <div className={`${styles.split}${splitOpen ? ` ${styles.splitOpen}` : ''}`}>
              <div>
                <FeedList
                  feed={feed}
                  market={market}
                  label={t('listLabel')}
                  activeJobId={splitOpen ? jobParam : null}
                  onOpen={openJob}
                  onSeen={markSeen}
                  empty={<ZeroResults profile={profile} />}
                  inline={
                    ratingFixes
                      ? {
                          after: RATING_AFTER_CARDS - 1,
                          node: (
                            <RatingFixes
                              fixes={ratingFixes}
                              onApplied={(reason) => setRatingFixes((prev) => {
                                const rest = (prev ?? []).filter((f) => f.reason !== reason);
                                return rest.length ? rest : null;
                              })}
                              onClose={() => setRatingFixes(null)}
                            />
                          ),
                        }
                      : calibration.rating.show
                        ? {
                            after: RATING_AFTER_CARDS - 1,
                            node: <RatingCard sessionId={feed.sessionId} onClose={calibration.rating.close} onRated={onRated} />,
                          }
                        : null
                  }
                />
              </div>
              {splitOpen && jobParam ? (
                <aside className={styles.detail} aria-label={t('detailLabel')} data-testid="split-detail">
                  <div className={styles.detailHead}>
                    <button type="button" className={styles.iconBtn} onClick={closeJob} aria-label={t('closeDetail')}>
                      <span aria-hidden="true">×</span>
                    </button>
                  </div>
                  <JobDetailPanel key={jobParam} jobId={jobParam} mode="split" onClose={closeJob} />
                </aside>
              ) : null}
            </div>
            {/* GoApply only: few results, so the same search on other job sites is one tap away. */}
            {cnSummary.thin ? <ExternalSearchPanel variant="thin" initialQuery={profile?.filters.q ?? profile?.filters.titles?.[0] ?? null} /> : null}
          </>
        )}
      </div>
    </div>
  );
}
