'use client';

// BillingView — /settings#billing and /settings/billing (PRODUCT_PLAN.md
// F-BILL-03, §6.5; TASK_PLAN.md WP-21b): payment-failed banner, the current
// plan (renewal or end date, practice interviews left), Manage payment
// (Stripe portal), one-click Cancel with the once-only 7-day-pass link,
// "Buy another pass" for passes, the plan sheet, and the invoice history link.

import Link from 'next/link';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { usePaymentPortal } from '../../../hooks/credits/useBillingActions';
import { useSubscriptionState, type SubscriptionState } from '../../../hooks/credits/useSubscriptionState';
import { CancelSubscription } from './CancelSubscription';
import { PaymentFailedBanner } from './PaymentFailedBanner';
import { PlanPicker } from './PlanPicker';
import { parseDate, planNameKey } from './labels';
import styles from './credits.module.css';

export interface BillingViewProps {
  visitorCountry?: string | null;
  requestedPlan?: string | null;
  navigate?: (url: string) => void;
}

export function BillingView({ visitorCountry, requestedPlan, navigate }: BillingViewProps) {
  const t = useTranslations('credits');
  const sub = useSubscriptionState();
  return (
    <div className={styles.stack} data-testid="billing-view">
      <PaymentFailedBanner navigate={navigate} />
      <CurrentPlanCard sub={sub} navigate={navigate} />
      <section className={styles.card} aria-labelledby="billing-plans">
        <h2 className={styles.h2} id="billing-plans">
          {t('planSheet.title')}
        </h2>
        <p className={styles.muted}>{t('planSheet.sub')}</p>
        {/* Re-keyed on the requested plan: following "?plan=" again (the
            cancel-time pass link, "Buy another pass") selects that plan. */}
        <PlanPicker key={requestedPlan ?? ''} visitorCountry={visitorCountry} requestedPlan={requestedPlan} navigate={navigate} />
      </section>
      <div className={styles.actions}>
        <Link href="/settings/billing/history" className={styles.link}>
          {t('current.history')}
        </Link>
      </div>
    </div>
  );
}

function CurrentPlanCard({ sub, navigate = (url) => window.location.assign(url) }: { sub: SubscriptionState & { refetch: () => void }; navigate?: (url: string) => void }) {
  const t = useTranslations('credits');
  const format = useFormatter();
  const brand = useBrand();
  const portal = usePaymentPortal();
  // Set once the user cancels here, so the confirmation, the once-only pass
  // link and the optional survey stay on screen after the plan refetch
  // reports the cancellation (which hides the Cancel button itself).
  const [cancelledHere, setCancelledHere] = useState(false);

  if (sub.status === 'error') {
    return (
      <section className={styles.card} role="alert">
        <p className={styles.body}>{t('current.error')}</p>
        <div className={styles.actions}>
          <Btn onClick={sub.refetch}>{t('retry')}</Btn>
        </div>
      </section>
    );
  }
  if (sub.status === 'loading') {
    return (
      <section className={styles.card} aria-busy="true">
        <p className={styles.muted}>{t('current.loading')}</p>
      </section>
    );
  }

  const nameKey = planNameKey(brand.id, sub.planKey, sub.legacy) ?? (sub.profile === 'free' ? `plans.${brand.id}.free` : null);
  const end = parseDate(sub.periodEnd);
  const date = end ? format.dateTime(end, { dateStyle: 'medium' }) : null;
  const paid = sub.profile === 'pro' || sub.legacy;
  let line: string | null = null;
  if (paid && date) {
    if (sub.cancelAtPeriodEnd) line = t('current.endsCancelled', { date });
    else if (sub.autoRenews) line = t('current.renews', { date });
    else if (sub.isPass) line = t('current.passEnds', { date });
    else line = t('current.ends', { date });
  }
  const canCancel = sub.autoRenews && !sub.cancelAtPeriodEnd;
  const canRenewPass = sub.isPass && !sub.autoRenews;

  return (
    <section className={styles.card} aria-labelledby="billing-current" data-testid="current-plan">
      <h2 className={styles.h2} id="billing-current">
        {t('current.title')}
      </h2>
      <span className={styles.planName}>{nameKey ? t(nameKey) : '—'}</span>
      {line ? <p className={styles.body}>{line}</p> : null}
      {sub.legacy ? <p className={styles.muted}>{t('current.legacyNote')}</p> : null}
      <p className={styles.muted}>
        {sub.practiceBalance === null ? t('current.practiceUnknown') : t('current.practice', { n: sub.practiceBalance })}
      </p>
      {portal.isError ? <p className={styles.error}>{t('paymentFailed.portalError')}</p> : null}
      <div className={styles.actions}>
        {sub.hasPortal ? (
          <Btn disabled={portal.isPending} onClick={() => portal.mutate(undefined, { onSuccess: (r) => navigate(r.url) })}>
            {t('current.manage')}
          </Btn>
        ) : null}
        {canRenewPass ? (
          <Btn as="a" href={sub.planKey ? `/settings/billing?plan=${encodeURIComponent(sub.planKey)}#plans` : '/settings/billing#plans'}>
            {t('current.renew')}
          </Btn>
        ) : null}
        {sub.legacy ? (
          <Btn as="a" href="#plans">
            {t('current.switch')}
          </Btn>
        ) : null}
      </div>
      {canCancel || cancelledHere ? <CancelSubscription periodEnd={sub.periodEnd} onCancelled={() => setCancelledHere(true)} /> : null}
    </section>
  );
}

export default BillingView;
