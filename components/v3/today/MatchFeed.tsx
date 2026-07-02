'use client';

// MatchFeed — the Today match list. Owns:
//   • the matches header (title + Refresh + Filters)
//   • expand-one state (accordion: only one card open at a time)
//   • client-local "passed" dismissals (the feed filters them, per the proto)
//   • the single shared apply mutation (useApplyJob) so N cards share one
//     in-flight slot, with an optimistic "applied" flag per job
//   • loading / empty / error states
//
// Data comes from `useTodayMatches` (search.run + resolved resume variant).
// Every string is `t()` under the `today` namespace.

import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Btn, EmptyState, IconRefresh } from '../primitives';
import { useApplyJob } from '../../../hooks/useJobDetail';
import {
  useTodayMatches,
  usePassMatch,
} from '../../../hooks/useTodayMatches';
import { MatchCard } from './MatchCard';

export function MatchFeed() {
  const t = useTranslations('today');
  const { feed, resumeVariantId } = useTodayMatches();
  const applyMutation = useApplyJob();
  const passMutation = usePassMatch();

  // Accordion: which card is open. Default-open the first row once data lands.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [passedIds, setPassedIds] = useState<Set<string>>(new Set());
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  // Track which job id is currently being applied to (the shared mutation only
  // exposes one isPending; we pin it to the right card).
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const allJobs = feed.data?.jobs ?? [];
  const visible = useMemo(
    () => allJobs.filter((j) => !passedIds.has(j.id)),
    [allJobs, passedIds],
  );

  // Pick the default-open card: first visible row (only when nothing chosen).
  const effectiveExpanded =
    expandedId ?? (visible.length > 0 ? visible[0]!.id : null);

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
          <Btn variant="ghost" style={{ padding: '6px 10px' }}>
            {t('actions.filters')}
          </Btn>
        </div>
      </div>

      {feed.isLoading ? (
        <div className="matches">
          {Array.from({ length: 4 }).map((_, i) => (
            <MatchRowSkeleton key={i} />
          ))}
        </div>
      ) : feed.isError ? (
        <EmptyState
          title={t('error.title')}
          accentWord={t('error.accent')}
          sub={t('error.sub')}
          action={
            <Btn variant="primary" onClick={() => void feed.refetch()}>
              {t('error.retry')}
            </Btn>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<span style={{ fontSize: 36 }}>🎯</span>}
          title={t('empty.title')}
          accentWord={t('empty.accent')}
          sub={t('empty.sub')}
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
