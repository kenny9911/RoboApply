'use client';

// BillingPage — the client body of /settings/billing (WP-21b): a back link to
// /settings#billing, the page title, the billing view and today's credits.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { BillingView } from './BillingView';
import { CreditsUsage } from './CreditsUsage';
import styles from './credits.module.css';

export interface BillingPageProps {
  visitorCountry: string | null;
  requestedPlan: string | null;
}

export function BillingPage({ visitorCountry, requestedPlan }: BillingPageProps) {
  const t = useTranslations('credits.page');
  return (
    <div className={styles.page}>
      <div className={styles.stack} style={{ gap: 'var(--sp-2)' }}>
        <Link href="/settings#billing" className={styles.link}>
          ← {t('back')}
        </Link>
        <h1 className={styles.title}>{t('title')}</h1>
        <p className={styles.body}>{t('sub')}</p>
      </div>
      <BillingView visitorCountry={visitorCountry} requestedPlan={requestedPlan} />
      <CreditsUsage />
    </div>
  );
}

export default BillingPage;
