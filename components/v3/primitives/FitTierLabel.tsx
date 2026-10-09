'use client';

// FitTierLabel — the four-word fit ladder (R-09; ARCHITECTURE.md §10.2 rule 4):
// Great fit · Good fit · Possible · Unlikely. Nothing else is ever printed as
// a fit word. Pass the server's `tier`; a bare score falls back to the default
// thresholds (components/features/common/fit.ts). Unknown renders "—".

import { useTranslations } from 'next-intl';

import { cn } from '../../../lib/utils';
import { normalizeScore, tierForScore, type FitTierKey } from '../../features/common';
import styles from './primitives.module.css';

const TIER_CLASS: Record<FitTierKey, string> = {
  great: styles.tierGreat,
  good: styles.tierGood,
  possible: styles.tierPossible,
  unlikely: styles.tierUnlikely,
};

export interface FitTierLabelProps {
  tier?: FitTierKey | null;
  score?: number | null;
  className?: string;
}

/** The tier a label shows, or null when unknown. */
export function resolveTier(tier?: FitTierKey | null, score?: number | null): FitTierKey | null {
  if (tier) return tier;
  const s = normalizeScore(score);
  return s === null ? null : tierForScore(s);
}

export function FitTierLabel({ tier, score, className }: FitTierLabelProps) {
  const t = useTranslations('jobs.fit');
  const resolved = resolveTier(tier, score);
  if (!resolved) {
    return <span className={cn(styles.tier, styles.tierUnknown, className)}>—</span>;
  }
  return (
    <span className={cn(styles.tier, TIER_CLASS[resolved], className)} data-tier={resolved}>
      {t(resolved)}
    </span>
  );
}
