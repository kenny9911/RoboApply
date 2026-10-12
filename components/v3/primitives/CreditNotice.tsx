'use client';

// CreditNotice — what an AI action costs and what is left (PRODUCT_PLAN.md
// §6.1; ARCHITECTURE.md §7). Props-driven: pass the bucket summary the server
// sent (hooks/shared/useCredits `bucketSummary(...)`). The client never
// computes caps.
//
//   left > 0   "Uses 1 of your 2 left today"
//   left = 0   "None left today. More on 11 Oct." [See Pro]
//   unknown    "Credits left: —"
//
// Never "unlimited" (every plan has a cap). "See Pro" shows only when the
// server says a sellable plan raises the cap (`upgradable`) and the caller
// passes `onUpgrade` (upsell moments are a fixed list, PRODUCT §6.4).

import { useFormatter, useTranslations } from 'next-intl';

import { cn } from '../../../lib/utils';
import styles from './primitives.module.css';

export interface CreditBucketLike {
  window: 'day' | 'week' | 'month';
  remaining: number;
  grantRemaining?: number;
  resetsAt: string;
}

export interface CreditNoticeProps {
  bucket: CreditBucketLike | null | undefined;
  /** Credits this action uses (default 1). */
  cost?: number;
  upgradable?: boolean;
  onUpgrade?: () => void;
  className?: string;
}

/** Credits usable now (window allowance + bonus), or null when unknown. */
export function creditsLeftOf(bucket: CreditBucketLike | null | undefined): number | null {
  if (!bucket || !Number.isFinite(bucket.remaining)) return null;
  return Math.max(0, bucket.remaining) + Math.max(0, bucket.grantRemaining ?? 0);
}

export function CreditNotice({ bucket, cost = 1, upgradable = false, onUpgrade, className }: CreditNoticeProps) {
  const t = useTranslations('nav.credits');
  const format = useFormatter();
  const left = creditsLeftOf(bucket);

  if (left === null || !bucket) {
    return <p className={cn(styles.credit, className)}>{t('unknown')}</p>;
  }
  if (left > 0) {
    return (
      <p className={cn(styles.credit, className)} data-credits-left={left}>
        {t('uses', { cost, left, window: bucket.window })}
      </p>
    );
  }
  const resets = new Date(bucket.resetsAt);
  const date = Number.isNaN(resets.getTime()) ? null : format.dateTime(resets, { month: 'short', day: 'numeric' });
  return (
    <p className={cn(styles.credit, styles.creditOut, className)} data-credits-left={0}>
      <span>{date ? t('none_left_until', { window: bucket.window, date }) : t('none_left', { window: bucket.window })}</span>
      {upgradable && onUpgrade ? (
        <button type="button" className={styles.creditLink} onClick={onUpgrade}>
          {t('see_pro')}
        </button>
      ) : null}
    </p>
  );
}
