'use client';

// CheckoutReturn — /settings/billing/return, where the payment page sends the
// buyer back (TASK_PLAN.md §4.1.b route shell; WP-21b). The plan changes
// only when the server has the payment (webhook), so this page re-reads the
// credit summary a few times and says plainly when it is still waiting. It
// never shows a purchase as done before the server does.
//
// What "done" means depends on what was bought (`?plan=`, set by the plan
// sheet in `next`):
//   - Pro (subscription or pass), or no plan named: the summary says Pro.
//   - A practice pack: the practice balance rose above `?practiceBefore=`
//     (the balance the plan sheet saw before checkout). Without that baseline
//     there is nothing to compare, so the page says neutrally that the
//     interviews are added when the payment clears — no polling, no warning.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useCredits, useInvalidateCredits } from '../../../hooks/shared/useCredits';
import styles from './credits.module.css';

export const RETURN_POLL_MS = 3000;
export const RETURN_POLL_ATTEMPTS = 10;

export interface CheckoutReturnProps {
  outcome: 'success' | 'cancel' | null;
  /** The plan bought (`?plan=`), when the plan sheet passed it. */
  planKey?: string | null;
  /** Practice balance before checkout (`?practiceBefore=`), for a pack. */
  practiceBefore?: number | null;
  pollMs?: number;
}

export function isPackKey(planKey: string | null | undefined): boolean {
  return !!planKey && planKey.startsWith('practice_pack_');
}

export function CheckoutReturn({ outcome, planKey = null, practiceBefore = null, pollMs = RETURN_POLL_MS }: CheckoutReturnProps) {
  const t = useTranslations('credits.return');
  const { data } = useCredits();
  const invalidate = useInvalidateCredits();
  const [attempts, setAttempts] = useState(0);

  const pack = isPackKey(planKey);
  const balance = data?.practice?.balance ?? null;
  const canTell = !pack || practiceBefore !== null;
  const active = pack
    ? practiceBefore !== null && balance !== null && balance > practiceBefore
    : data?.summary.planProfile === 'pro';
  const waiting = outcome === 'success' && canTell && !active && attempts < RETURN_POLL_ATTEMPTS;

  useEffect(() => {
    if (!waiting) return;
    const id = window.setTimeout(() => {
      setAttempts((n) => n + 1);
      void invalidate();
    }, pollMs);
    return () => window.clearTimeout(id);
  }, [waiting, attempts, invalidate, pollMs]);

  let title: string;
  let body: string;
  if (outcome === 'cancel') {
    title = t('cancelTitle');
    body = t('cancelSub');
  } else if (outcome === 'success') {
    title = t('successTitle');
    if (pack) {
      if (active && balance !== null) body = t('packActive', { n: balance });
      else if (waiting) body = t('packPending');
      else body = t('packPaid');
    } else {
      body = active ? t('successActive') : waiting ? t('successPending') : t('slow');
    }
  } else {
    title = t('unknownTitle');
    body = t('unknownSub');
  }

  return (
    <div className={styles.page} data-testid="checkout-return" data-outcome={outcome ?? 'unknown'}>
      <h1 className={styles.title}>{title}</h1>
      <div className={`${styles.notice} ${outcome === 'success' && active ? styles.ok : ''}`} role="status" aria-busy={waiting || undefined}>
        <p className={styles.body}>{body}</p>
      </div>
      <div className={styles.actions}>
        <Link href="/settings#billing" className={styles.link}>
          {t('back')}
        </Link>
      </div>
    </div>
  );
}

export default CheckoutReturn;
