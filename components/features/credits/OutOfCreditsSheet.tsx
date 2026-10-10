'use client';

// OutOfCreditsSheet — opens when an action has no credits left, with three
// equal options (PRODUCT_PLAN.md §6.4 "Credit runs out"):
//
//   Get Pro            only when the server says a sellable plan raises the
//                      cap (`upgradable`)
//   Wait until {time}  the server's reset time in the account's time zone,
//                      with the day it means ("tomorrow 12:00 AM")
//   Continue without it  closes the sheet; everything else keeps working
//
// Practice interview credits are a balance, not a daily window: they do not
// refill on Free. So the practice sheet says "You have no practice
// interviews left", offers "Get practice credits" only when a practice pack
// is actually on sale (or the server says Pro helps), and offers "Wait" only
// when the server sent a refill time. Every claim here is the server's.
//
// Mounted ONCE in the app layout (no props) and fed by `useOutOfCredits()`
// (hooks/shared/useCreditGate.ts): every credit-spending action reports a
// `402 credits_exhausted` there. It never blocks a non-metered action: it is
// a dismissible sheet, the options are equal buttons (no preselected upsell),
// and nothing waits on it.
//
// Each time it opens it records one `upgrade_viewed` product event
// (`from: 'out_of_credits'`, with the bucket): the admin System panel's "Ran
// out of credits" row counts those. Only the bucket name is sent.

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';

import { Sheet } from '../../v3/primitives/Sheet';
import { useOutOfCredits } from '../../../hooks/shared/useCreditGate';
import { bucketSummary, useCredits } from '../../../hooks/shared/useCredits';
import { usePlans, visiblePlans } from '../../../hooks/credits/usePlans';
import { useFlag } from '../../../lib/flags';
import { track } from '../../../lib/analytics';
import { bucketLabelKey, knownTimeZone, parseDate, refillLabel } from './labels';
import styles from './credits.module.css';

export type OutOfCreditsSheetProps = Record<string, never>;

export const PLANS_HREF = '/settings/billing#plans';

/** The plan sheet with that pack selected. */
export function packHref(planKey: string): string {
  return `/settings/billing?plan=${encodeURIComponent(planKey)}#plans`;
}

export function OutOfCreditsSheet(_props: OutOfCreditsSheetProps = {}) {
  const { info, dismiss } = useOutOfCredits();
  const t = useTranslations('credits.outOfCredits');
  const tc = useTranslations('credits');
  const locale = useLocale();
  const appTimeZone = useTimeZone();
  const studentEnabled = useFlag('student');
  const isPractice = info?.bucket === 'practice';
  const { data } = useCredits({ enabled: info !== null && !isPractice });
  const plansQ = usePlans({ enabled: isPractice });
  // Once per open: recorded when the sheet goes from closed to open. A
  // re-render, a refetch or a second report while it is still open records
  // nothing more; closing and opening again is a new view.
  const open = info !== null;
  const openBucket = info?.bucket ?? null;
  const tracked = useRef(false);
  useEffect(() => {
    if (!open) {
      tracked.current = false;
      return;
    }
    if (tracked.current || !openBucket) return;
    tracked.current = true;
    track('upgrade_viewed', { from: 'out_of_credits', bucket: openBucket });
  }, [open, openBucket]);
  if (!info) return null;

  const window = bucketSummary(data?.summary, info.bucket)?.window ?? null;
  const resets = parseDate(info.resetsAt);
  const when = resets
    ? refillLabel({ at: resets, now: new Date(), locale, timeZone: knownTimeZone(data?.summary?.timezone, appTimeZone) })
    : null;
  // Practice: a pack that is on sale right now (GoApply sells none before
  // CN_PAYMENTS_ENABLED), else Pro only when the server says it helps.
  const pack = isPractice
    ? (visiblePlans(plansQ.data?.plans, { studentEnabled }).find((p) => p.kind === 'pack' && p.sellable) ?? null)
    : null;
  const title = isPractice ? t('practiceTitle') : window ? t('title', { window }) : t('titleUnknown');
  const showWait = !isPractice || when !== null;

  return (
    <Sheet open onClose={dismiss} title={title} description={tc(bucketLabelKey(info.bucket))}>
      <div className={styles.choices} data-testid="out-of-credits-options">
        {pack ? (
          <Link href={packHref(pack.key)} className={styles.choice} onClick={dismiss}>
            <span className={styles.choiceTitle}>{t('getPack')}</span>
            <span className={styles.muted}>{t('getPackSub')}</span>
          </Link>
        ) : info.upgradable ? (
          <Link href={PLANS_HREF} className={styles.choice} onClick={dismiss}>
            <span className={styles.choiceTitle}>{t('getPro')}</span>
            <span className={styles.muted}>{isPractice ? t('getProPracticeSub') : t('getProSub')}</span>
          </Link>
        ) : null}
        {showWait ? (
          <button type="button" className={styles.choice} onClick={dismiss}>
            <span className={styles.choiceTitle}>{when ? t('wait', { when }) : t('waitUnknown')}</span>
            <span className={styles.muted}>{t('waitSub')}</span>
          </button>
        ) : null}
        <button type="button" className={styles.choice} onClick={dismiss}>
          <span className={styles.choiceTitle}>{t('continue')}</span>
          <span className={styles.muted}>{t('continueSub')}</span>
        </button>
      </div>
    </Sheet>
  );
}

export default OutOfCreditsSheet;
