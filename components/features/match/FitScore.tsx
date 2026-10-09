'use client';

// FitScore — the fit for one job (R-09; PRODUCT F-MATCH-01/02, F-FEED-06).
//
//   Good fit
//   ▬▬▬▬▬▬▬▬▬▬▬▬▬
//   74 / 100 — how well your resume lines up with this job post
//   This is not your chance of getting hired.        ← always (FitMeter)
//   [Quick estimate] why it is one                     ← kind 'pre'
//   Summary [AI generated on GoApply]                  ← kind 'ai'
//   "Your payments work lines up…"  (second person, no number)
//   Written with AI. Check every line before you use it.
//
// The number is never shown without its honesty line; an unknown score is
// "—", never 0.

import { useTranslations } from 'next-intl';

import { FitMeter, HonestyLine } from '../../v3/primitives';
import { AiGeneratedBadge } from '../market';
import type { MatchFitView } from '../../../lib/api/contracts/match';
import styles from './match.module.css';

export type FitScoreData = Pick<MatchFitView, 'score' | 'tier' | 'kind'> & Partial<Pick<MatchFitView, 'summary' | 'estimateReason'>>;

export interface FitScoreProps {
  fit: FitScoreData | null | undefined;
  /** Hide the "N / 100 — …" sentence (cards); the honesty line stays. */
  compact?: boolean;
  className?: string;
}

const REASONS = new Set(['ai_off', 'no_resume', 'daily_cap', 'budget', 'ai_unavailable', 'ai_failed']);

export function FitScore({ fit, compact = false, className }: FitScoreProps) {
  const t = useTranslations('fit');
  const reason = fit?.estimateReason && REASONS.has(fit.estimateReason) ? fit.estimateReason : 'default';
  return (
    <div className={[styles.score, className].filter(Boolean).join(' ')} data-fit-kind={fit?.kind ?? 'none'}>
      <FitMeter score={fit?.score ?? null} tier={fit?.tier ?? null} compact={compact} />
      {fit?.kind === 'pre' ? (
        <p className={styles.estimate}>
          <span className={styles.estimateTag}>{t('quickEstimate')}</span>
          {compact ? null : <span>{t(`quickEstimateWhy.${reason}`)}</span>}
        </p>
      ) : null}
      {fit?.kind === 'ai' && fit.summary && !compact ? (
        <div className={styles.summary}>
          <div className={styles.summaryHead}>
            <span>{t('summaryLabel')}</span>
            <AiGeneratedBadge kind="text" />
          </div>
          <p className={styles.summaryText}>{fit.summary}</p>
          <HonestyLine kind="ai_written" />
        </div>
      ) : null}
    </div>
  );
}
