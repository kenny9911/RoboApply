'use client';

// NoRenewalNotice — what /cancel shows on GoApply (PRODUCT F-BILL-03 cn).
//
// GoApply sells passes that are paid once and never renew, and it has no
// email-link sign-in for a cancellation, so the RoboApply flow ("enter your
// email, we send a cancel link") describes something that does not exist
// here. This page says the true thing instead: there is nothing to cancel,
// a pass ends by itself, and where the prices and the user's own pass are.
// No form, no email field, no request.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useAuth } from '../../../lib/auth/useAuth';
import styles from './billingCn.module.css';

export function NoRenewalNotice() {
  const t = useTranslations('billingCn.noRenewal');
  const { status } = useAuth();
  return (
    <section className={styles.notice} aria-labelledby="cn-no-renewal" data-testid="cn-no-renewal">
      <h1 id="cn-no-renewal" className={styles.noticeTitle}>
        {t('title')}
      </h1>
      <p className={styles.noticeBody}>{t('body')}</p>
      <p className={styles.noticeBody}>{t('ends')}</p>
      <p className={styles.noticeLinks}>
        <Link href="/pricing" className={styles.noticeLink}>
          {t('pricingLink')}
        </Link>
        {status === 'authenticated' ? (
          <Link href="/settings#billing" className={styles.noticeLink}>
            {t('settingsLink')}
          </Link>
        ) : null}
      </p>
    </section>
  );
}

export default NoRenewalNotice;
