'use client';

// MatchFeed — the Today match list. Owns:
//   • the matches header (title + Refresh + the one entry point to setup)
//   • expand-one state (accordion: only one card open at a time)
//   • client-local "passed" dismissals (the feed filters them, per the proto)
//   • the single shared apply mutation (useApplyJob) so N cards share one
//     in-flight slot, with an optimistic "applied" flag per job
//   • ORDER — progressive re-sort as scores resolve (see below)
//   • loading / empty / error states
//
// Data comes from `useTodayMatches` (search.run + resolved resume variant).
// Every string is `t()` under the `jobs` namespace.
//
// ════ NEVER HIDE AN UNSCORED ROW ════════════════════════════════════════════
//
// There is no score floor in this file, and there must never be one. The
// reasoning, because it is not obvious and two reviewers reached it
// independently:
//
//   `RAJobIndexService` derives `matchScoreCached` from `RAJobMatchScore` rows.
//   A BRAND NEW USER HAS ZERO OF THEM. Every row therefore arrives with no
//   score at all — the service reports -1 — and any rule of the shape "render
//   scored rows and stop at the floor" evaluates to "render nothing" for
//   precisely the user first-run setup exists to serve. They finish setup,
//   land here, and see an empty screen. The one moment the product has to
//   prove it works is the one moment the floor guarantees it cannot.
//
//   Scores arrive per row, lazily, over seconds (`useJobScore`, cached
//   server-side and deterministic). So: render EVERY row the server returned,
//   immediately, in the order it returned them — retrieval order, which is
//   already `sortBy: 'match_desc'` — and re-sort progressively as each score
//   lands. A row without a score yet is a real job the user can read and apply
//   to; a row that is missing is nothing at all.
//
// The header still promises "best fit first", and it keeps that promise: the
// list converges on score order within a second or two of landing, without
// ever having been empty.

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';

import { Btn, EmptyState, IconRefresh } from '../primitives';
import { raV2Api } from '../../../lib/api/v2';
import type { JobScoreResponse, RAJobListItem } from '../../../lib/api/v2';
import { useApplyJob } from '../../../hooks/useJobDetail';
import {
  todayKeys,
  useTodayMatches,
  usePassMatch,
} from '../../../hooks/useTodayMatches';
import { MatchCard } from './MatchCard';

interface Props {
  /** Open the first-run setup panel. Wired by /jobs; the feed header is the
   *  one place in the product that offers it by tap (ruling C21 — one name,
   *  one place). Optional so the feed still renders standalone. */
  onOpenSetup?: () => void;
}

export function MatchFeed({ onOpenSetup }: Props = {}) {
  const t = useTranslations('jobs');
  const { feed, resumeVariantId } = useTodayMatches();
  const applyMutation = useApplyJob();
  const passMutation = usePassMatch();

  // Accordion. THREE states, not two:
  //   undefined → the user has not touched it; default-open the first row.
  //   null      → the user closed the open row; keep everything closed.
  //   string    → that row is open.
  // The old code used `expandedId ?? visible[0].id`, which made "close the
  // first card" a no-op — it fell straight back to the default.
  const [expandedId, setExpandedId] = useState<string | null | undefined>(
    undefined,
  );
  const [defaultOpenId, setDefaultOpenId] = useState<string | null>(null);
  const [passedIds, setPassedIds] = useState<Set<string>>(new Set());
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  // Track which job id is currently being applied to (the shared mutation only
  // exposes one isPending; we pin it to the right card).
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const allJobs = useMemo<RAJobListItem[]>(
    () => feed.data?.jobs ?? [],
    [feed.data],
  );

  // ── Scores, for ORDER only ────────────────────────────────────────────────
  //
  // These queries use the SAME keys, queryFn and staleTime as `useJobScore`,
  // which each MatchCard calls for itself. TanStack Query dedupes by key, so
  // this is not a second round of requests — it is a second SUBSCRIBER to the
  // same cache entries. The card still owns rendering its own score; the feed
  // only needs to know when one lands so it can re-order.
  //
  // Kept here rather than lifted into MatchCard's props on purpose: the card's
  // contract is unchanged, so nothing about how a score is displayed moved.
  const scoreQueries = useQueries({
    queries: allJobs.map((job) => ({
      queryKey: resumeVariantId
        ? todayKeys.score(job.id, resumeVariantId)
        : (['v3', 'today', 'score', job.id, 'null'] as const),
      queryFn: (): Promise<JobScoreResponse> => {
        if (!resumeVariantId) throw new Error('Missing resume variant');
        return raV2Api.jobs.score(job.id, { resumeVariantId });
      },
      enabled: Boolean(resumeVariantId),
      staleTime: Infinity,
    })),
  });

  /** jobId → a REAL score, or undefined for "not measured yet". Never a
   *  sentinel: -1 and 0 are both scores the UI would have to lie about.
   *
   *  `matchScoreCached` first: when the server already has a score, that is the
   *  same number the card renders, and using it keeps order and label agreeing
   *  even before this row's own query resolves. */
  const scoreById = new Map<string, number>();
  allJobs.forEach((job, i) => {
    const live = job.matchScoreCached ?? scoreQueries[i]?.data?.matchScore.score;
    if (typeof live === 'number') scoreById.set(job.id, live);
  });

  // `useQueries` hands back a fresh array on every render, so the map above
  // cannot be a useMemo dependency without defeating the memo. This signature
  // changes only when a score actually lands — which is exactly, and only, when
  // the order can change.
  const scoreSignature = allJobs
    .map((job) => `${job.id}:${scoreById.get(job.id) ?? ''}`)
    .join('|');

  const visible = useMemo(() => {
    const rows = allJobs.filter((j) => !passedIds.has(j.id));
    // Decorate–sort–undecorate with the retrieval index as the tiebreak, so the
    // sort is stable in every engine and unscored rows hold their server order
    // relative to each other. Scored rows sort above unscored ones — that is
    // the promise in the header — and each score landing moves exactly one row.
    return rows
      .map((job, i) => ({ job, i, score: scoreById.get(job.id) }))
      .sort((a, b) => {
        const as = a.score;
        const bs = b.score;
        if (as !== undefined && bs !== undefined && as !== bs) return bs - as;
        if (as !== undefined && bs === undefined) return -1;
        if (as === undefined && bs !== undefined) return 1;
        return a.i - b.i;
      })
      .map((row) => row.job);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scoreSignature IS
    // the stable projection of scoreById; see the note above it.
  }, [allJobs, passedIds, scoreSignature]);

  // Pin the default-open row ONCE, and re-pick only if it leaves the list
  // (passed). Without the pin, every re-sort would drag the open card out from
  // under whoever was reading it.
  useEffect(() => {
    if (visible.length === 0) return;
    if (defaultOpenId && visible.some((j) => j.id === defaultOpenId)) return;
    setDefaultOpenId(visible[0]!.id);
  }, [visible, defaultOpenId]);

  const effectiveExpanded = expandedId === undefined ? defaultOpenId : expandedId;

  const handleApply = (jobId: string, variantId: string | null) => {
    setApplyingId(jobId);
    applyMutation.mutate(
      {
        id: jobId,
        body: variantId
          ? { resumeVariantId: variantId, appliedVia: 'manual' }
          : { appliedVia: 'manual' },
      },
      {
        onSuccess: () => {
          setAppliedIds((prev) => new Set(prev).add(jobId));
        },
        onSettled: () => setApplyingId(null),
      },
    );
  };

  const handlePass = (jobId: string) => {
    setPassedIds((prev) => new Set(prev).add(jobId));
    passMutation.mutate(jobId);
  };

  const handleUndoPass = (jobId: string) => {
    setPassedIds((prev) => {
      const next = new Set(prev);
      next.delete(jobId);
      return next;
    });
  };

  return (
    <>
      <div className="matches-head">
        <div className="ttl">{t('matchesTitle')}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Btn
            variant="ghost"
            icon={<IconRefresh size={13} />}
            style={{ padding: '6px 10px' }}
            disabled={feed.isFetching}
            onClick={() => void feed.refetch()}
          >
            {t('actions.refresh')}
          </Btn>
          {/* Was a button labelled "Filter" with NO onClick — the first thing a
           *  curious first-run user taps, and it did nothing. It is now the
           *  entry point to setup, named for what the user gets rather than for
           *  the mechanism. Rendered only when /jobs supplies the callback, so
           *  a dead control can never come back. */}
          {onOpenSetup ? (
            <Btn
              variant="ghost"
              style={{ padding: '6px 10px' }}
              onClick={onOpenSetup}
            >
              {t('filter.setup_cta')}
            </Btn>
          ) : null}
        </div>
      </div>

      {/* `isPending`, not `isLoading` — the same trap the page header already
       *  documents. The feed query is HELD until stored preferences resolve, and
       *  a disabled TanStack query reports isLoading === false while it has no
       *  data. On `isLoading` this branch fell through to `visible.length === 0`
       *  and flashed "No jobs fit you yet." at every user on every cold load,
       *  before a single request had been made. */}
      {feed.isPending ? (
        <div className="matches">
          {Array.from({ length: 4 }).map((_, i) => (
            <MatchRowSkeleton key={i} />
          ))}
        </div>
      ) : feed.isError ? (
        <EmptyState
          title={`${t('error.title')} ${t('error.accent')}`}
          sub={t('error.sub')}
          action={
            <Btn variant="primary" onClick={() => void feed.refetch()}>
              {t('error.retry')}
            </Btn>
          }
        />
      ) : visible.length === 0 ? (
        // Reachable only when the SERVER returned nothing (or the user passed
        // on everything) — never because a score has not arrived yet.
        <EmptyState
          icon={<span style={{ fontSize: 'var(--fs-display)' }}>🎯</span>}
          title={`${t('empty.title')} ${t('empty.accent')}`}
          sub={t('empty.sub')}
          action={
            onOpenSetup ? (
              <Btn variant="primary" onClick={onOpenSetup}>
                {t('filter.setup_cta')}
              </Btn>
            ) : undefined
          }
        />
      ) : (
        <div className="matches">
          {visible.map((job, i) => (
            <MatchCard
              key={job.id}
              job={job}
              index={i}
              resumeVariantId={resumeVariantId}
              expanded={effectiveExpanded === job.id}
              onToggle={() =>
                setExpandedId(effectiveExpanded === job.id ? null : job.id)
              }
              onApply={handleApply}
              applying={applyingId === job.id && applyMutation.isPending}
              onPass={() => handlePass(job.id)}
              onUndoPass={() => handleUndoPass(job.id)}
              passed={passedIds.has(job.id)}
              appliedNow={appliedIds.has(job.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

// A collapsed-row shaped shimmer placeholder.
function MatchRowSkeleton() {
  const block = (w: number | string, h: number, mt = 0) => (
    <div
      className="animate-pulse"
      style={{
        width: w,
        height: h,
        marginTop: mt,
        borderRadius: 6,
        background: 'var(--surface-2)',
      }}
    />
  );
  return (
    <div className="match" style={{ cursor: 'default' }} aria-hidden="true">
      <div className="match-top">
        <div
          className="animate-pulse"
          style={{
            width: 44,
            height: 44,
            borderRadius: 11,
            background: 'var(--surface-2)',
          }}
        />
        <div className="match-body">
          {block('60%', 16)}
          {block('40%', 12, 8)}
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            {block(64, 18)}
            {block(52, 18)}
          </div>
        </div>
        <div className="match-right">
          <div
            className="animate-pulse"
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'var(--surface-2)',
            }}
          />
        </div>
      </div>
    </div>
  );
}
