'use client';

// PaymentFailedBanner — shown while the last renewal payment failed
// (PRODUCT_PLAN.md §6.5: banner + email, automatic retries by Stripe, Pro
// drops to Free after the last retry, granted credits are kept). Rendered at
// the top of /settings#billing; INT may also mount it in the app layout.
// Status comes from `/billing/plan` (Stripe past_due / unpaid / incomplete);
// renders nothing otherwise, and goes away through the normal refetch once
// the status is good again. Its button opens the payment portal straight on
// "update payment method" (`flow: 'payment_method_update'`; ST-7,
// MARKET_STRATEGY §5.1 "Dunning and SCA"); "Manage payment" on the billing
// view opens the portal's home page instead.

import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { usePaymentPortal } from '../../../hooks/credits/useBillingActions';
import { useSubscriptionState } from '../../../hooks/credits/useSubscriptionState';
import styles from './credits.module.css';

export interface PaymentFailedBannerProps {
  navigate?: (url: string) => void;
}

export function PaymentFailedBanner({ navigate = (url) => window.location.assign(url) }: PaymentFailedBannerProps = {}) {
  const t = useTranslations('credits.paymentFailed');
  const sub = useSubscriptionState();
  const portal = usePaymentPortal();
  if (!sub.paymentFailed) return null;
  return (
    <div className={styles.banner} role="alert" data-testid="payment-failed">
      <div className={styles.bannerText}>
        <strong className={styles.h3}>{t('title')}</strong>
        <p className={styles.body}>{t('body')}</p>
        {portal.isError ? <p className={styles.error}>{t('portalError')}</p> : null}
      </div>
      {sub.hasPortal ? (
        <Btn variant="primary" disabled={portal.isPending} onClick={() => portal.mutate({ flow: 'payment_method_update' }, { onSuccess: (r) => navigate(r.url) })}>
          {t('action')}
        </Btn>
      ) : null}
    </div>
  );
}

export default PaymentFailedBanner;
