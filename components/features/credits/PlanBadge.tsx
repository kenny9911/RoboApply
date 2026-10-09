'use client';

// PlanBadge — the plan line under the nav: "Free · See Pro", "Pro · Renews
// 12 Oct", "Practice plan" (PRODUCT_PLAN.md §3.3; GoApply 会员 badge).
// Mounted by the Sidebar (variant 'rail') and the mobile More sheet
// (variant 'sheet'). Plan facts come from the entitlement summary
// (`/auth/me.entitlements`, cached by hooks/shared/useCredits); nothing
// renders until the summary is known, and nothing is guessed. Links to
// /settings#billing. No countdowns, no offers (PRODUCT §6.4).
//
// "Renews {date}" is a claim, so it shows only when the subscription is known
// NOT to be cancelled: from `summary.cancelAtPeriodEnd` (requested from
// WP-21a) or, until that ships, the billing plan's cancel-at-period-end — read
// only for renewing Pro users. A cancelled subscription reads "Until {date}";
// while the answer is unknown the date is left out.

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { useBrand } from '../../../lib/brand/BrandProvider';
import { useCredits } from '../../../hooks/shared/useCredits';
import { summaryCancelAtPeriodEnd } from '../../../hooks/credits/useSubscriptionState';
import { useBillingPlan } from '../../../hooks/useAccount';
import { cn } from '../../../lib/utils';
import { parseDate } from './labels';
import styles from './credits.module.css';

export interface PlanBadgeProps {
  variant?: 'rail' | 'sheet';
}

export function PlanBadge({ variant = 'rail' }: PlanBadgeProps = {}) {
  const t = useTranslations('credits.badge');
  const format = useFormatter();
  const brand = useBrand();
  const { data } = useCredits();
  const summary = data?.summary;
  const isPro = summary?.planProfile === 'pro';
  const renewing = summary?.interval === 'week' || summary?.interval === 'month' || summary?.interval === 'quarter';
  const fromSummary = summaryCancelAtPeriodEnd(summary);
  const legacyPlan = useBillingPlan(undefined, { enabled: !!summary && isPro && renewing && fromSummary === undefined });
  if (!summary) return null;

  const plan = summary.legacyPlan ? t('legacy') : isPro ? (brand.market === 'cn' ? t('member') : t('pro')) : t('free');
  const end = parseDate(summary.periodEnd);
  const date = end ? format.dateTime(end, { month: 'short', day: 'numeric' }) : null;
  const cancelled = fromSummary ?? (legacyPlan.data ? legacyPlan.data.current.cancelAtPeriodEnd === true : undefined);
  let meta: string | null = null;
  if (isPro && date) {
    if (!renewing || cancelled === true) meta = t('until', { date });
    else if (cancelled === false) meta = t('renews', { date });
  }
  const showUpgrade = !isPro && summary.upgradable;

  return (
    <Link
      href="/settings#billing"
      className={cn(styles.badge)}
      data-variant={variant}
      data-plan={summary.planProfile}
      aria-label={t('aria', { plan })}
    >
      <span>
        <span className={styles.badgePlan}>{plan}</span>
        {meta ? <span className={styles.badgeMeta}> · {meta}</span> : null}
      </span>
      {showUpgrade ? <span className={styles.badgeCta}>{t('seePro')}</span> : null}
    </Link>
  );
}

export default PlanBadge;
