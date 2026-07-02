'use client';

// components/v3/account/billingHistory.tsx
//
// Invoice / receipt history for RoboApply billing. Merges Stripe invoices (USD)
// and Alipay receipts (RMB) from GET /billing/history. Each row links to a
// download (Stripe → hosted PDF redirect; Alipay → generated receipt PDF) via
// the direct-open download URL — the browser carries the session cookie.

import { useTranslations, useLocale } from 'next-intl';
import { Btn } from '../primitives/Btn';
import { IconFile } from '../primitives/Iconset';
import { Panel } from './sections';
import { useBillingHistory } from '../../../hooks/useAccount';
import { accountApi, type BillingInvoice } from '../../../lib/api/account';

function money(locale: string, amountMinor: number, currency: string): string {
  const amount = amountMinor / 100;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: (currency || 'USD').toUpperCase(), maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency === 'CNY' ? '¥' : '$'}${amount.toFixed(2)}`;
  }
}
function fmtDate(locale: string, iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function StatusChip({ status, label }: { status: string; label: string }) {
  const s = status.toLowerCase();
  const tone = s === 'paid' ? { bg: 'var(--ok-soft)', color: 'var(--ok)' }
    : s === 'open' || s === 'pending' ? { bg: 'var(--warn-soft)', color: 'var(--warn)' }
      : { bg: 'var(--surface-2)', color: 'var(--text-2)' };
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 99, textTransform: 'uppercase', background: tone.bg, color: tone.color }}>
      {label}
    </span>
  );
}

function Row({ inv }: { inv: BillingInvoice }) {
  const t = useTranslations('account');
  const locale = useLocale();
  const statusLabel = inv.status.toLowerCase() === 'paid' ? t('billing.history.paid')
    : inv.status.toLowerCase() === 'open' || inv.status.toLowerCase() === 'pending' ? t('billing.history.pending')
      : t('billing.history.failed');
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
      padding: '14px 16px', borderBottom: '1px solid var(--rule)', flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{inv.description}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>
          {fmtDate(locale, inv.date)} · {inv.kind === 'alipay' ? 'Alipay' : t('billing.history.card')}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
          {money(locale, inv.amountMinor, inv.currency)}
        </span>
        <StatusChip status={inv.status} label={statusLabel} />
        {inv.downloadable ? (
          <Btn variant="ghost" onClick={() => window.open(accountApi.invoiceDownloadUrl(inv.id), '_blank', 'noopener')} icon={<IconFile size={14} />}>
            {t('billing.history.download')}
          </Btn>
        ) : null}
      </div>
    </div>
  );
}

export function BillingHistoryView() {
  const t = useTranslations('account');
  const q = useBillingHistory();

  if (q.isLoading) {
    return <Panel><div style={{ color: 'var(--muted)', fontSize: 14 }}>{t('billing.history.loading')}</div></Panel>;
  }
  if (q.isError) {
    return <Panel><div style={{ color: 'var(--warn)', fontSize: 14 }}>{t('billing.history.error')}</div></Panel>;
  }
  const invoices = q.data?.invoices ?? [];
  if (invoices.length === 0) {
    return <Panel><div style={{ color: 'var(--muted)', fontSize: 14 }}>{t('billing.history.empty')}</div></Panel>;
  }
  return (
    <Panel style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--rule)', fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>
        {t('billing.history.title')}
      </div>
      {invoices.map((inv) => <Row key={`${inv.kind}:${inv.id}`} inv={inv} />)}
    </Panel>
  );
}
