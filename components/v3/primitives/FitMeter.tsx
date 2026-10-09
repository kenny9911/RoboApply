'use client';

// FitMeter — a fit score with its explanation (R-09; ruling C5; ARCHITECTURE.md
// §10.2 rule 4).
//
//   <FitMeter score={87} tier="great" />
//     Great fit
//     ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
//     87 / 100 — how well your resume lines up with this job post
//     This is not your chance of getting hired.
//
// The last line is ALWAYS rendered — with a score, without one, while
// loading. It cannot be turned off by a prop (F-TRUST-05). The tier word comes
// first; the number is secondary. Unknown renders "—", never 0.

import { useTranslations } from 'next-intl';

import { cn } from '../../../lib/utils';
import { normalizeScore, type FitTierKey } from '../../features/common';
import { FitTierLabel, resolveTier } from './FitTierLabel';
import { HonestyLine } from './HonestyLine';
import styles from './primitives.module.css';

export interface FitMeterProps {
  score: number | null | undefined;
  /** The server's tier; derived from the score when absent. */
  tier?: FitTierKey | null;
  /** Hide the "N / 100 — …" sentence (cards); the honesty line stays. */
  compact?: boolean;
  className?: string;
}

export function FitMeter({ score, tier, compact = false, className }: FitMeterProps) {
  const t = useTranslations('jobs.score');
  const value = normalizeScore(score);
  const resolved = resolveTier(tier, value);
  return (
    <div className={cn(styles.fit, className)} data-fit-tier={resolved ?? 'unknown'}>
      <div className={styles.fitHead}>
        <FitTierLabel tier={resolved} />
      </div>
      <div
        className={styles.fitTrack}
        role="meter"
        aria-label={t('label')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value ?? undefined}
        aria-valuetext={value === null ? '—' : t('unit', { score: value })}
      >
        {value !== null ? <span className={styles.fitFill} style={{ width: `${value}%` }} /> : null}
      </div>
      {compact ? null : (
        <span className={styles.fitScore}>{value === null ? t('empty') : t('explainer', { score: value })}</span>
      )}
      <HonestyLine kind="fit" />
    </div>
  );
}
