'use client';

// /account/billing/history — Orders & Invoices tab.
// Stripe invoices (USD) + Alipay receipts (RMB) merged, newest first, each with
// a download. The shared /account layout owns the header + section tabs, so this
// renders just a short section intro + the history view.

import { useTranslations } from 'next-intl';
import { BillingHistoryView } from '../../../../../components/v3/account';

export default function BillingHistoryPage() {
  const t = useTranslations('account');
  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', margin: '0 0 4px' }}>
          {t('billing.history.heading')}
        </h2>
        <p style={{ color: 'var(--text-2)', fontSize: 14, margin: 0 }}>{t('billing.history.subtitle')}</p>
      </div>
      <BillingHistoryView />
    </div>
  );
}
