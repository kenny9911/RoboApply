'use client';

// A job opportunity with disclosed facts, a secondary fit score, and the
// resume evidence beside its rationale. The score describes a comparison, not
// a hiring probability. The expanded actions open the employer posting and
// record the user's application locally; Undo corrects that local record.

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
import { useJobScore, useRegenerateExplanation } from '../../../hooks/useTodayMatches';
import { raV2Api } from '../../../lib/api/v2';
import type { JobGetResponse, RAJobListItem } from '../../../lib/api/v2';
import { JobDetailModal } from './JobDetailModal';
import {
  cardStatusFromTracker,
  deriveFacets,
  deriveTags,
  postedAge,
  scoreTier,
  type MatchTier,
} from './lib';
import { CompanyIdentity, JobFacts } from './JobFacts';

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
  /** Clear the feed's optimistic application after the server acknowledges a correction. */
  onApplicationUndone: (jobId: string) => void;
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
  onApplicationUndone,
}: Props) {
  const t = useTranslations('jobs');
  const qc = useQueryClient();

  // Full-detail modal (the real posting: description / responsibilities /
  // qualifications / benefits + a link to the original listing).
  const [detailOpen, setDetailOpen] = useState(false);

  // Deterministic comparison score (lazy, cached). Sentinel values are unknown.
  const scoreQuery = useJobScore(job.id, resumeVariantId);
  const scoreCandidate = job.matchScoreCached != null && job.matchScoreCached >= 0
    ? job.matchScoreCached
    : scoreQuery.data?.matchScore.score;
  const liveScore = scoreCandidate != null && scoreCandidate >= 0 && scoreCandidate <= 100 ? scoreCandidate : null;

  // Expanded reasoning — only fetched once the row opens.
  const detail = useJobDetail(
    expanded ? job.id : null,
    resumeVariantId ? { resumeVariantId } : undefined,
  );
  const matchView = detail.data?.matchScore ?? scoreQuery.data?.matchScore ?? null;

  // Opt-in refresh for prose written in a language the user has since switched
  // away from. Bound to the button in the expanded panel — one row, one gesture.
  const regenerate = useRegenerateExplanation(job.id, resumeVariantId);

  // The employer's own posting. Only the full job record carries it
  // (`RAJobListItem` is a compact projection), so it lands with the expanded
  // detail — which is also the only place the action row renders.
  const applyUrl = detail.data?.job.applyUrl ?? null;
  const trackerEntryId = detail.data?.trackerEntry?.id ?? null;

  // Status: applied (from tracker or optimistic) | passed (local) | queued.
  const trackerStatus = detail.data?.trackerEntry?.status ?? null;
  const status: 'applied' | 'passed' | 'queued' = appliedNow
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
      // Filtering unmounts cards. Both the optimistic feed acknowledgement and
      // the shared cached record must reflect this confirmed correction before
      // a card can mount again; component-local state cannot preserve it.
      onApplicationUndone(job.id);
      qc.setQueriesData<JobGetResponse>({ queryKey: ['v2', 'job', job.id] }, (current) => current?.trackerEntry
        ? { ...current, trackerEntry: { ...current.trackerEntry, status: 'bookmarked' } }
        : current);
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
    onApply(job.id, resumeVariantId);
  };

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
  }).filter((tg) => tg.kind !== 'tier' && tg.kind !== 'workType');

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
    <article className={`match discovery-match ${expanded ? 'expanded' : ''}`}>
      {/* The collapsed header is the toggle. It lives in its own focusable
       *  region (NOT a wrapping role=button over the whole card) so the
       *  expanded action buttons aren't nested inside a button — invalid ARIA
       *  and it would swallow their accessible names. */}
      <div
        className="match-top"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={`match-evidence-${job.id}`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <CompanyIdentity name={job.companyName} logoUrl={job.companyLogoUrl} index={index} />
        <div className="match-body">
          <div className="co">
            <b>{job.companyName}</b>
            {postedLabel ? (
              <>
                <span className="dot" />
                <span>{postedLabel}</span>
              </>
            ) : null}
          </div>
          <h3>{job.title}</h3>
          <JobFacts job={job} />
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
                <p className="match-gap"><span className="discovery-evidence-label">{t('discovery.gaps')}</span>{leadGap}</p>
              ) : (
                <p className="match-gap">{t('gap.none_missing')}</p>
              )}
              {leadStrength ? <p className="match-overlap"><span className="discovery-evidence-label">{t('discovery.strengths')}</span>{leadStrength}</p> : null}
            </div>
          ) : null}
        </div>

        <div className="match-right">
          {tierLabel && liveScore != null ? (
            <div className="match-fit" data-tier={tier ?? undefined}>
              <span className="discovery-fit-label">{t('discovery.match')}</span>
              <div className="tier">{tierLabel}</div>
              {/* The number, second and quiet. The full explainer ("87 / 100 —
                *  how well your resume lines up with this job post") is the
                *  title, and it is spelled out in the rubric below. */}
              <div className="num" title={t('score.explainer', { score: liveScore })}>
                {t('score.unit', { score: liveScore })}
              </div>
            </div>
          ) : null}
          {status !== 'queued' || job.isBookmarked ? <div className={`match-status ${status}`}>{statusLabel}</div> : null}
          <span className="discovery-review"><span>{t('discovery.review')}</span><IconArrow size={15} /></span>
        </div>
      </div>

      {expanded ? (
        <div id={`match-evidence-${job.id}`} className="match-expanded" onClick={(e) => e.stopPropagation()}>
          <div className="discovery-evaluation">
          {/* No avatar slot: the reasoning has no speaker (D4/C9). It states
            *  what the posting asks for and what the résumé shows. */}
          <div className="why-fits">
            <div className="txt">
              <div className="lbl">{t('whyFits')}</div>
              {detail.isLoading && !matchView ? (
                <span style={{ color: 'var(--text-muted)' }}>{t('thinking')}</span>
              ) : matchView ? (
                <>
                  <Markdown>{matchView.explanation.rationale}</Markdown>
                  {/* The score is language-neutral and stays valid across a
                    *  language switch — only these words are in the previous
                    *  language. Re-generating costs a billed scorer call, so it
                    *  is a user gesture on ONE expanded card, never something
                    *  the feed fires for every row. See the cache gate in
                    *  server/src/roboapply/v2/routes/jobs.ts. */}
                  {matchView.explanationStale ? (
                    <button
                      type="button"
                      className="link-btn"
                      style={{
                        marginTop: 8,
                        fontSize: 'var(--fs-meta)',
                        color: 'var(--action)',
                      }}
                      disabled={regenerate.isPending}
                      onClick={() => regenerate.mutate()}
                    >
                      {regenerate.isPending
                        ? t('explanationLanguage.regenerating')
                        : t('explanationLanguage.regenerate')}
                    </button>
                  ) : null}
                </>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>{resumeVariantId ? t('noReasoning') : t('discovery.noResume')}</span>
              )}
            </div>
          </div>

          <aside className="discovery-evidence-panel">
            {strengths.length ? (
              <section className="discovery-strengths">
                <h4>{t('discovery.strengths')}</h4>
                <ul>{strengths.slice(0, 4).map((strength, i) => <li key={i}><IconCheck size={14} /><span>{strength}</span></li>)}</ul>
              </section>
            ) : null}

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

          </aside>
          </div>

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
                <div key={i} className={`facet ${i === 0 && job.salaryMin == null && job.salaryMax == null ? '' : f.tone ?? ''}`}>
                  <div className="lbl">{f.label}</div>
                  <div className="val">{i === 0 && job.salaryMin == null && job.salaryMax == null ? t('discovery.salaryUnknown') : f.value}</div>
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
        onApply={handleApplyOnSite}
      />
    </article>
  );
}
