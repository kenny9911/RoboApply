'use client';

// /settings/billing/history — invoice and receipt history with download.
//
// A detail view hanging off the /settings "Plan and billing" section, not a
// destination: the back link returns to /settings#billing.
// Stripe invoices (USD) + Alipay receipts (RMB) merged, newest first.

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BillingHistoryView } from '../../../../../components/v3/account';

export default function BillingHistoryPage() {
  const t = useTranslations('settings');
  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '8px 0 48px' }}>
      <div style={{ marginBottom: 24 }}>
        <Link
          href="/settings#billing"
          style={{ fontSize: 'var(--fs-label)', color: 'var(--text-muted)', textDecoration: 'none' }}
        >
          ← {t('billing.history.back')}
        </Link>
        <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.03em', margin: '12px 0 4px' }}>
          {t('billing.history.heading')}
        </h1>
        <p style={{ color: 'var(--text-2)', fontSize: 14, margin: 0 }}>{t('billing.history.subtitle')}</p>
      </div>
      <BillingHistoryView />
    </div>
  );
}
