'use client';

// MatchCard — one row in the /jobs feed.
//
// THE GAP LEADS (ruling R2). Collapsed, the card reads:
//
//   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔  4px fit meter, full bleed — the feed's silhouette (C41)
//   [ST]  Senior Payments Engineer                        Great fit
//         Stripe · Remote · $180k–$220k · 2d ago            87 / 100
//         They ask for Kubernetes and your resume …       ← the gap, first
//         Your payments background lines up …             ← the overlap, quieter
//
// The gap is first because it is the one thing on this card a competitor
// funded by employers will never ship. It used to be line three, inside a
// collapsed section, behind a donut.
//
// THE SCORE IS NEVER THE PRIMARY ELEMENT (ruling C5). A naked 0–100 next to a
// job has exactly one folk meaning — a percentage chance of getting it — and a
// candidate who reads "87" and relaxes has made the most expensive error in a
// job search. So the tier word leads in plain language (Great fit / Good fit /
// Possible / Unlikely, the single ladder used everywhere), the number sits
// under it small and quiet, and the rubric expander carries the required
// disclaimer. The 56px ScoreDonut this replaced put the number at
// --fs-subtitle as the heaviest thing in the row.
//
// Data: `useJobScore` (lazy, cached) gives the collapsed card its score AND its
// explanation.strengths / explanation.gaps — the scorer already returns both as
// arrays, so the gap line costs no extra request. The expanded rationale comes
// from `useJobDetail(id,{resumeVariantId})`, which resolves instantly once the
// score is cached for that (job, variant) pair.
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
// Every user-facing string uses `t()` under the `jobs` namespace.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import {
  Btn,
  Markdown,
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
  scoreTier,
  type MatchTier,
} from './lib';

/** The scorer's internal tiering → the one user-facing ladder (ruling C2).
 *  `strong/stretch/longShot` are our vocabulary; Great fit / Good fit /
 *  Possible / Unlikely is the user's, and it is parallel in form so it scans
 *  as a ladder. Two of the old rungs were idioms. */
const TIER_RUNG: Record<MatchTier, 'great' | 'good' | 'possible' | 'unlikely'> = {
  strong: 'great',
  good: 'good',
  stretch: 'possible',
  longShot: 'unlikely',
};

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
  const t = useTranslations('jobs');
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

  // The tier tag is dropped from the tag row — the tier now has its own slot on
  // the right, and showing the same word twice on one card is how a four-rung
  // ladder stops being read at all.
  const tags = deriveTags(job, liveScore, {
    tier: {
      strong: t('fit.great'),
      good: t('fit.good'),
      stretch: t('fit.possible'),
      longShot: t('fit.unlikely'),
    },
    workType: {
      remote: t('work.remote'),
      hybrid: t('work.hybrid'),
      onsite: t('work.onsite'),
    },
    stretch: t('tag.possible'),
  }).filter((tg) => tg.kind !== 'tier');

  // ── Fit, in words ──
  // One ladder, four rungs, used on the card, in the filter and in the empty
  // state. Derived from `scoreTier` rather than re-cut here: a second set of
  // thresholds in the component is how the word and the meter start disagreeing.
  const tier = liveScore == null ? null : TIER_RUNG[scoreTier(liveScore)];
  const tierLabel = tier
    ? {
        great: t('fit.great'),
        good: t('fit.good'),
        possible: t('fit.possible'),
        unlikely: t('fit.unlikely'),
      }[tier]
    : null;

  // The two sentences that lead the card. The scorer returns both as arrays and
  // is explicit that "absence of evidence is a gap, not a guess", so an empty
  // gaps array is a real finding, not a blank — it gets its own string.
  const gaps = matchView?.explanation.gaps ?? [];
  const strengths = matchView?.explanation.strengths ?? [];
  const leadGap = gaps[0] ?? null;
  const leadStrength = strengths[0] ?? null;

  const statusLabel =
    status === 'applied'
      ? t('status.applied')
      : status === 'passed'
        ? t('status.notInterested')
        : t('status.saved');

  return (
    <div className={`match ${expanded ? 'expanded' : ''}`}>
      {/* The fit meter. Decorative — the same value is stated in words and
       *  digits immediately below, so it carries no information of its own and
       *  is hidden from assistive tech rather than announced twice. */}
      <div
        className="match-meter"
        data-tier={tier ?? undefined}
        style={{ ['--score' as string]: liveScore ?? 0 }}
        aria-hidden="true"
      />

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
          {tags.length ? (
            <div className="match-tags">
              {tags.map((tg, i) => (
                <Tag key={i} tone={tg.tone === 'strong' ? 'strong' : tg.tone === 'warn' ? 'warn' : 'default'}>
                  {tg.label}
                </Tag>
              ))}
            </div>
          ) : null}

          {/* The read. Gap first, overlap second — the whole point of the card.
           *  Rendered only once the score resolves; there is no skeleton here
           *  because a shimmering placeholder where a sentence about YOUR
           *  resume will appear is worse than the sentence arriving late. */}
          {leadGap || leadStrength ? (
            <div className="match-read">
              {leadGap ? (
                <p className="match-gap">{leadGap}</p>
              ) : (
                <p className="match-gap">{t('gap.none_missing')}</p>
              )}
              {leadStrength ? <p className="match-overlap">{leadStrength}</p> : null}
            </div>
          ) : null}
        </div>

        <div className="match-right">
          {tierLabel && liveScore != null ? (
            <div className="match-fit" data-tier={tier ?? undefined}>
              <div className="tier">{tierLabel}</div>
              {/* The number, second and quiet. The full explainer ("87 / 100 —
                *  how well your resume lines up with this job post") is the
                *  title, and it is spelled out in the rubric below. */}
              <div className="num" title={t('score.explainer', { score: liveScore })}>
                {t('score.unit', { score: liveScore })}
              </div>
            </div>
          ) : null}
          <div className={`match-status ${status}`}>{statusLabel}</div>
        </div>
      </div>

      {expanded ? (
        <div className="match-expanded" onClick={(e) => e.stopPropagation()}>
          {/* No avatar slot: the reasoning has no speaker (D4/C9). It states
            *  what the posting asks for and what the résumé shows. */}
          <div className="why-fits">
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

          {/* Everything they ask for that the résumé does not mention. The
            *  label is mandatory (ruling C17): three bare words in pill shapes
            *  read as FEATURES — tags are positive by default — which is the
            *  exact inverse of what these are. */}
          {gaps.length ? (
            <div className="gap-block">
              <div className="lbl">{t('gap.missing_label')}</div>
              <div className="gap-chips">
                {gaps.slice(0, 6).map((g, i) => (
                  <span className="gap-chip" key={i}>
                    {g}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {/* The rubric, published. The scorer's weights are the most credible
            *  artifact the product owns — bidirectional seniority penalties,
            *  "absence of evidence is a gap, not a guess", and a parseOutput
            *  that throws rather than persisting a flattering fallback — and
            *  they were visible only as a donut. Stated in sentences, not the
            *  prompt's own nouns (domain / stack / trajectory mean nothing
            *  cold). The disclaimer lives here because this is where someone
            *  comes to ask what the number means. */}
          <details className="rubric">
            <summary>{t('score.rubric_title')}</summary>
            <ul>
              <li>{t('score.rubric.title_level')}</li>
              <li>{t('score.rubric.skills')}</li>
              <li>{t('score.rubric.industry')}</li>
              <li>{t('score.rubric.location_pay_visa')}</li>
              <li>{t('score.rubric.career_moves')}</li>
            </ul>
            <p className="disclaimer">{t('score.disclaimer')}</p>
          </details>

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

