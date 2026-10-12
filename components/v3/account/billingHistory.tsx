'use client';

// components/v3/account/billingHistory.tsx
//
// Invoice / receipt history for billing (ST-10). Merges Stripe invoices and
// mainland receipts (Alipay, WeChat Pay) from GET /billing/history, newest
// first, a page at a time: "Show more" asks for the next page while the
// server says there is one. Each row links to a download (Stripe → hosted PDF
// redirect; a mainland order → generated receipt PDF) via the direct-open
// download URL — the browser carries the session cookie.
//
// What a row states is what the server sent:
//   - how it was paid, from `channel` (card, Alipay, WeChat Pay); a row
//     without one is read from its `kind`, as before;
//   - "Refunded" / "Partly refunded" when `refunded` is set; a refunded row
//     stays listed and downloadable;
//   - its status: paid, open (shown as pending) or uncollectible. Drafts and
//     voided invoices are not sent. A status this build does not know gets a
//     neutral chip that says so, never "Failed".

import { useTranslations, useLocale } from 'next-intl';
import { Btn } from '../primitives/Btn';
import { IconFile } from '../primitives/Iconset';
import { Panel } from './sections';
import { useBillingHistory } from '../../../hooks/useAccount';
import { accountApi, invoiceChannel, invoiceRefunded, type BillingInvoice, type InvoiceChannel } from '../../../lib/api/account';

// Each row is formatted in ITS OWN currency — a USD invoice stays "$15" and an
// Alipay receipt stays "¥19" whatever market the user is in today.
import { money } from './format';
function fmtDate(locale: string, iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** The statuses the history lists; anything else is `unknown`. `pending` is what older rows called an open invoice. */
export type InvoiceStatusKind = 'paid' | 'open' | 'uncollectible' | 'unknown';

export function invoiceStatusKind(status: string | null | undefined): InvoiceStatusKind {
  const s = (status ?? '').trim().toLowerCase();
  if (s === 'paid') return 'paid';
  if (s === 'open' || s === 'pending') return 'open';
  if (s === 'uncollectible') return 'uncollectible';
  return 'unknown';
}

type Tone = { bg: string; color: string };
const NEUTRAL: Tone = { bg: 'var(--surface-2)', color: 'var(--text-2)' };
const STATUS_TONE: Record<InvoiceStatusKind, Tone> = {
  paid: { bg: 'var(--ok-subtle)', color: 'var(--ok)' },
  open: { bg: 'var(--warn-subtle)', color: 'var(--warn)' },
  uncollectible: { bg: 'var(--danger-subtle)', color: 'var(--danger)' },
  unknown: NEUTRAL,
};

function Chip({ tone, label, testId }: { tone: Tone; label: string; testId: string }) {
  return (
    <span
      data-testid={testId}
      style={{ fontSize: 'var(--fs-label)', fontWeight: 600, padding: '3px 9px', borderRadius: 99, background: tone.bg, color: tone.color, whiteSpace: 'nowrap' }}
    >
      {label}
    </span>
  );
}

function Row({ inv }: { inv: BillingInvoice }) {
  const t = useTranslations('settings');
  const tc = useTranslations('credits.history');
  const locale = useLocale();
  const status = invoiceStatusKind(inv.status);
  const statusLabel =
    status === 'paid' ? t('billing.history.paid') : status === 'open' ? t('billing.history.pending') : status === 'uncollectible' ? tc('status.uncollectible') : tc('status.unknown');
  const channel: InvoiceChannel = invoiceChannel(inv);
  const channelLabel = channel === 'card' ? t('billing.history.card') : tc(`channel.${channel}`);
  const refunded = invoiceRefunded(inv);
  return (
    <div
      data-testid="invoice-row"
      data-invoice={inv.id}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        padding: '14px 16px', borderBottom: '1px solid var(--rule)', flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
        <span style={{ fontSize: 'var(--fs-body)', fontWeight: 600, color: 'var(--text)' }}>{inv.description}</span>
        <span style={{ fontSize: 'var(--fs-label)', color: 'var(--text-muted)' }}>
          {fmtDate(locale, inv.date)} · <span data-testid="invoice-channel">{channelLabel}</span>
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--fs-body)', fontWeight: 600, color: 'var(--text)' }}>
          {money(locale, inv.amountMinor, inv.currency)}
        </span>
        <Chip tone={STATUS_TONE[status]} label={statusLabel} testId="invoice-status" />
        {/* The marker is its own chip beside the status: the charge was paid, and all or part of it went back. */}
        {refunded ? <Chip tone={NEUTRAL} label={tc(`refunded.${refunded}`)} testId="invoice-refunded" /> : null}
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
  const t = useTranslations('settings');
  const tc = useTranslations('credits.history');
  const q = useBillingHistory();

  if (q.isLoading) {
    return <Panel><div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-body)' }}>{t('billing.history.loading')}</div></Panel>;
  }
  // Only a first page that did not load is "the history did not load"; a later page that fails keeps the rows on screen.
  if (q.isError && !q.data) {
    return <Panel><div style={{ color: 'var(--warn)', fontSize: 'var(--fs-body)' }} role="alert">{t('billing.history.error')}</div></Panel>;
  }
  // A row is listed once, even if a page boundary repeats it.
  const seen = new Set<string>();
  const invoices = (q.data?.pages ?? []).flatMap((page) => page.invoices).filter((inv) => {
    const key = `${inv.kind}:${inv.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (invoices.length === 0 && !q.hasNextPage) {
    return <Panel><div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-body)' }}>{t('billing.history.empty')}</div></Panel>;
  }
  return (
    <Panel style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--rule)', fontSize: 'var(--fs-meta)', fontWeight: 600, color: 'var(--text-2)' }}>
        {t('billing.history.title')}
      </div>
      {invoices.map((inv) => <Row key={`${inv.kind}:${inv.id}`} inv={inv} />)}
      {q.hasNextPage || q.isFetchNextPageError ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px' }}>
          <Btn disabled={q.isFetchingNextPage} aria-busy={q.isFetchingNextPage || undefined} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? tc('loadingMore') : tc('more')}
          </Btn>
          {q.isFetchNextPageError && !q.isFetchingNextPage ? (
            <span role="alert" style={{ color: 'var(--warn)', fontSize: 'var(--fs-meta)' }}>{tc('moreError')}</span>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
