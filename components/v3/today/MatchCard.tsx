'use client';

// MatchCard — one row in the Today match feed. Collapsed: logo bubble, title,
// company · location · salary · posted line, derived tags, ScoreDonut + status.
// Expanded (click the row): AI reasoning (rationale, rendered via the Markdown
// primitive — sanitized), a 3-up facet strip, and the action row
// (Apply now / Schedule auto-apply / Pass / View JD), or an applied/passed
// banner.
//
// Score: the collapsed donut shows the deterministic score from `useJobScore`
// (lazily computed + cached). The expanded reasoning comes from
// `useJobDetail(id,{resumeVariantId})` which resolves instantly once the score
// is cached for that (job, variant) pair.
//
// Every user-facing string uses `t()` under the `today` namespace.

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import {
  Btn,
  Markdown,
  ScoreDonut,
  Tag,
  IconBolt,
  IconClock,
  IconCheck,
} from '../primitives';
import { useJobDetail } from '../../../hooks/useJobDetail';
import { useJobScore } from '../../../hooks/useTodayMatches';
import type { RAJobListItem } from '../../../lib/api/v2';
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
  /** Local-dismiss "pass". */
  onPass: () => void;
  /** Undo a local pass. */
  onUndoPass: () => void;
  /** Apply mutation state from the parent (one shared mutation). */
  applying: boolean;
  onApply: (jobId: string, resumeVariantId: string | null) => void;
  /** Client-local "passed" flag (the feed owns dismissals). */
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

  // Status: applied (from tracker or optimistic) | passed (local) | queued.
  const trackerStatus = detail.data?.trackerEntry?.status ?? null;
  const status: 'applied' | 'passed' | 'queued' = appliedNow
    ? 'applied'
    : passed
      ? 'passed'
      : cardStatusFromTracker(trackerStatus);

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
        ? t('status.passed')
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
                <span style={{ color: 'var(--muted)' }}>{t('thinking')}</span>
              ) : matchView ? (
                <Markdown>{matchView.explanation.rationale}</Markdown>
              ) : (
                <span style={{ color: 'var(--muted)' }}>{t('noReasoning')}</span>
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
              <div className="applied-banner">
                <span className="ic">
                  <IconCheck size={12} strokeWidthValue={3} />
                </span>
                {t('appliedBanner')}
              </div>
            ) : status === 'passed' ? (
              <>
                <div
                  className="applied-banner"
                  style={{
                    background: 'var(--surface-2)',
                    color: 'var(--muted)',
                    borderColor: 'var(--rule)',
                  }}
                >
                  {t('passedBanner')}
                </div>
                <Btn variant="ghost" onClick={onUndoPass}>
                  {t('actions.undo')}
                </Btn>
              </>
            ) : (
              <>
                <Btn
                  variant="primary"
                  icon={<IconBolt size={14} />}
                  disabled={applying}
                  onClick={() => onApply(job.id, resumeVariantId)}
                >
                  {applying ? t('actions.applying') : t('actions.applyNow')}
                </Btn>
                <Btn icon={<IconClock size={13} />}>
                  {t('actions.schedule')}
                </Btn>
                <Btn variant="ghost" onClick={onPass}>
                  {t('actions.pass')}
                </Btn>
                {/* V3 folds job detail into this inline expand — the old
                    /jobs/[id] route was removed, so there's no "View JD"
                    link target. The expanded card IS the detail. */}
              </>
            )}
          </div>
        </div>
      ) : null}
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
