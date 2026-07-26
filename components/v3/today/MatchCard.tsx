'use client';

// MatchCard — one row in the Today match feed. Collapsed: logo bubble, title,
// company · location · salary · posted line, derived tags, ScoreDonut + status.
// Expanded (click the row): AI reasoning (rationale, rendered via the Markdown
// primitive — sanitized), a 3-up facet strip, and the action row
// (Apply on company site / Not interested / View detail), or an
// applied / not-interested banner.
//
// Score: the collapsed donut shows the deterministic score from `useJobScore`
// (lazily computed + cached). The expanded reasoning comes from
// `useJobDetail(id,{resumeVariantId})` which resolves instantly once the score
// is cached for that (job, variant) pair.
//
// THE APPLY FLOW (rulings R1 + C11). We do not submit anything to an employer
// and never claim to. The primary action opens the employer's own posting in a
// new tab and, in the same click, records the application locally — because
// C11 says never instruct where you can act, and the alternative ("remember to
// come back and mark this applied") is an instruction the user will not follow.
// We cannot observe what happens on the employer's site, so the record is a
// claim the user can correct: the applied state carries an inline
// "I didn't apply" that patches the tracker row back to `bookmarked`.
//
// Every user-facing string uses `t()` under the `today` namespace.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import {
  Btn,
  Markdown,
  ScoreDonut,
  Tag,
  IconArrow,
  IconCheck,
  IconFile,
} from '../primitives';
import { useJobDetail } from '../../../hooks/useJobDetail';
import { useJobScore } from '../../../hooks/useTodayMatches';
import { raV2Api } from '../../../lib/api/v2';
import type { RAJobListItem } from '../../../lib/api/v2';
import { JobDetailModal } from './JobDetailModal';
import {
  cardStatusFromTracker,
  deriveFacets,
  deriveTags,
  formatSalary,
  logoColor,
  logoLetter,
  postedAge,
} from './lib';

interface Props {
  job: RAJobListItem;
  /** Color index for the logo bubble (row position). */
  index: number;
  /** Resume variant the match scores against. */
  resumeVariantId: string | null;
  expanded: boolean;
  onToggle: () => void;
  /** Local-dismiss "not interested". */
  onPass: () => void;
  /** Undo a local dismiss. */
  onUndoPass: () => void;
  /** Apply mutation state from the parent (one shared mutation). */
  applying: boolean;
  onApply: (jobId: string, resumeVariantId: string | null) => void;
  /** Client-local "not interested" flag (the feed owns dismissals). */
  passed: boolean;
  /** Set when this card's apply just succeeded (optimistic). */
  appliedNow: boolean;
}

export function MatchCard({
  job,
  index,
  resumeVariantId,
  expanded,
  onToggle,
  onPass,
  onUndoPass,
  applying,
  onApply,
  passed,
  appliedNow,
}: Props) {
  const t = useTranslations('today');
  const qc = useQueryClient();

  // Full-detail modal (the real posting: description / responsibilities /
  // qualifications / benefits + a link to the original listing).
  const [detailOpen, setDetailOpen] = useState(false);

  // Set once the user says "I didn't apply". The parent's `appliedNow` is a
  // one-way optimistic flag it never clears, so this local flag is what lets
  // the card fall back to its pre-apply state without a round trip.
  const [unapplied, setUnapplied] = useState(false);

  // Deterministic score for the donut (lazy, cached).
  const scoreQuery = useJobScore(job.id, resumeVariantId);
  const liveScore =
    job.matchScoreCached ?? scoreQuery.data?.matchScore.score ?? null;

  // Expanded reasoning — only fetched once the row opens.
  const detail = useJobDetail(
    expanded ? job.id : null,
    resumeVariantId ? { resumeVariantId } : undefined,
  );
  const matchView = detail.data?.matchScore ?? scoreQuery.data?.matchScore ?? null;

  // The employer's own posting. Only the full job record carries it
  // (`RAJobListItem` is a compact projection), so it lands with the expanded
  // detail — which is also the only place the action row renders.
  const applyUrl = detail.data?.job.applyUrl ?? null;
  const trackerEntryId = detail.data?.trackerEntry?.id ?? null;

  // Status: applied (from tracker or optimistic) | passed (local) | queued.
  const trackerStatus = detail.data?.trackerEntry?.status ?? null;
  const status: 'applied' | 'passed' | 'queued' = unapplied
    ? 'queued'
    : appliedNow
      ? 'applied'
      : passed
        ? 'passed'
        : cardStatusFromTracker(trackerStatus);

  // "I didn't apply" — walk the tracker row back to `bookmarked`. The job stays
  // saved (the user did show intent by opening it); only the applied claim is
  // withdrawn. Invalidations mirror `useApplyJob` so every surface reading this
  // row agrees.
  const undoApply = useMutation<void, Error, string>({
    mutationFn: async (entryId) => {
      await raV2Api.tracker.patch(entryId, { status: 'bookmarked' });
    },
    onSuccess: () => {
      setUnapplied(true);
      void qc.invalidateQueries({ queryKey: ['v2', 'tracker'] });
      void qc.invalidateQueries({ queryKey: ['v2', 'search'] });
      void qc.invalidateQueries({ queryKey: ['v2', 'job', job.id] });
      void qc.invalidateQueries({ queryKey: ['v2', 'home', 'jobs'] });
    },
  });

  /** Primary action. Open first — the popup blocker only trusts a window.open
   *  that happens inside the click's own task — then record the application. */
  const handleApplyOnSite = () => {
    if (!applyUrl) return;
    window.open(applyUrl, '_blank', 'noopener,noreferrer');
    setUnapplied(false);
    onApply(job.id, resumeVariantId);
  };

  const salary = formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency);
  const age = postedAge(job.postedAt);
  const postedLabel =
    age.key === 'unknown'
      ? null
      : age.key === 'justNow'
        ? t('posted.justNow')
        : age.key === 'hoursAgo'
          ? t('posted.hoursAgo', { count: age.count })
          : t('posted.daysAgo', { count: age.count });

  const tags = deriveTags(job, liveScore, {
    tier: {
      strong: t('tier.strong'),
      good: t('tier.good'),
      stretch: t('tier.stretch'),
      longShot: t('tier.longShot'),
    },
    workType: {
      remote: t('work.remote'),
      hybrid: t('work.hybrid'),
      onsite: t('work.onsite'),
    },
    stretch: t('tag.stretch'),
  });

  const statusLabel =
    status === 'applied'
      ? t('status.applied')
      : status === 'passed'
        ? t('status.notInterested')
        : t('status.queued');

  return (
    <div className={`match ${expanded ? 'expanded' : ''}`}>
      {/* The collapsed header is the toggle. It lives in its own focusable
       *  region (NOT a wrapping role=button over the whole card) so the
       *  expanded action buttons aren't nested inside a button — invalid ARIA
       *  and it would swallow their accessible names. */}
      <div
        className="match-top"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="logo" data-color={logoColor(index)}>
          {logoLetter(job.companyName)}
        </div>
        <div className="match-body">
          <h3>{job.title}</h3>
          <div className="co">
            <b>{job.companyName}</b>
            {job.location ? (
              <>
                <span className="dot" />
                <span>{job.location}</span>
              </>
            ) : null}
            {salary ? (
              <>
                <span className="dot" />
                <span>{salary}</span>
              </>
            ) : null}
            {postedLabel ? (
              <>
                <span className="dot" />
                <span>{postedLabel}</span>
              </>
            ) : null}
          </div>
          <div className="match-tags">
            {tags.map((tg, i) => (
              <Tag key={i} tone={tg.tone === 'strong' ? 'strong' : tg.tone === 'warn' ? 'warn' : 'default'}>
                {tg.label}
              </Tag>
            ))}
          </div>
        </div>
        <div className="match-right">
          {liveScore != null ? (
            <ScoreDonut value={liveScore} label={t('match')} />
          ) : (
            <ScoreDonutSkeleton />
          )}
          <div className={`match-status ${status}`}>{statusLabel}</div>
        </div>
      </div>

      {expanded ? (
        <div className="match-expanded" onClick={(e) => e.stopPropagation()}>
          <div className="ai-reasoning">
            <div className="ai-avatar" aria-hidden="true" />
            <div className="txt">
              <div className="lbl">{t('whyFits')}</div>
              {detail.isLoading && !matchView ? (
                <span style={{ color: 'var(--text-muted)' }}>{t('thinking')}</span>
              ) : matchView ? (
                <Markdown>{matchView.explanation.rationale}</Markdown>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>{t('noReasoning')}</span>
              )}
            </div>
          </div>

          {matchView ? (
            <div className="facet-strip">
              {deriveFacets(matchView, {
                salaryFit: t('facet.salaryFit'),
                salaryWithinBand: t('facet.salaryWithinBand'),
                salaryBelowBand: t('facet.salaryBelowBand'),
                skillOverlap: t('facet.skillOverlap'),
                skillValue: (pct: number) => t('facet.skillValue', { pct }),
                riskFlag: t('facet.riskFlag'),
                riskNone: t('facet.riskNone'),
              }).map((f, i) => (
                <div key={i} className={`facet ${f.tone ?? ''}`}>
                  <div className="lbl">{f.label}</div>
                  <div className="val">{f.value}</div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="match-actions">
            {status === 'applied' ? (
              <>
                {/* States only what happened: the posting opened and we wrote
                 *  it down. No cover letter, no tailored resume and no
                 *  screening answers were sent — nothing here submits. */}
                <div className="applied-banner">
                  <span className="ic">
                    <IconCheck size={12} strokeWidthValue={3} />
                  </span>
                  {t('appliedOnSiteBanner')}
                </div>
                <Btn
                  variant="ghost"
                  disabled={!trackerEntryId || undoApply.isPending}
                  onClick={() => {
                    if (trackerEntryId) undoApply.mutate(trackerEntryId);
                  }}
                >
                  {t('actions.didntApply')}
                </Btn>
              </>
            ) : status === 'passed' ? (
              <>
                <div
                  className="applied-banner"
                  style={{
                    background: 'var(--surface-2)',
                    color: 'var(--text-muted)',
                    borderColor: 'var(--rule)',
                  }}
                >
                  {t('notInterestedBanner')}
                </div>
                <Btn variant="ghost" onClick={onUndoPass}>
                  {t('actions.undo')}
                </Btn>
              </>
            ) : (
              <>
                <Btn
                  variant="primary"
                  icon={<IconArrow size={14} />}
                  disabled={applying || !applyUrl}
                  onClick={handleApplyOnSite}
                >
                  {t('actions.applyOnSite')}
                </Btn>
                <Btn variant="ghost" onClick={onPass}>
                  {t('actions.notInterested')}
                </Btn>
              </>
            )}
            {/* Always available (any status): open the full posting — real JD,
                responsibilities, qualifications, benefits + a link to the
                original listing — in a modal. */}
            <Btn
              variant="ghost"
              icon={<IconFile size={13} />}
              onClick={() => setDetailOpen(true)}
            >
              {t('actions.viewDetail')}
            </Btn>
          </div>
        </div>
      ) : null}

      <JobDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        job={detail.data?.job ?? null}
        loading={detail.isLoading}
        applied={status === 'applied'}
        applying={applying}
        onApply={() => onApply(job.id, resumeVariantId)}
      />
    </div>
  );
}

// A subtle pulsing placeholder shaped like the donut while the score computes.
function ScoreDonutSkeleton() {
  return (
    <div
      className="score-donut animate-pulse"
      style={{ width: 56, height: 56 }}
      aria-hidden="true"
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          border: '5px solid var(--surface-2)',
        }}
      />
    </div>
  );
}
