'use client';

// /account layout — the unified Account shell (Claude.ai / ChatGPT-style).
//
// One header + one route-based tab strip wrap every account sub-page:
//   Overview /account · Plans /account/plans · Billing /account/billing ·
//   Orders & Invoices /account/billing/history · Usage /account/usage ·
//   Security /account/security
//
// The Stripe/Alipay checkout-return banner lives HERE (not per-page) so a
// return to ANY sub-tab surfaces it: the backend appends ?billing=success|cancel
// to whatever `next` path the checkout passed (e.g. /account/plans). On success
// we invalidate the plan + profile caches so the now-current tier repaints, then
// strip the param. This does NOT touch the payment contract — only the client
// return path changed.

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { PageHeader } from '../../../components/v3/primitives/PageHeader';
import { IconCheck, IconX } from '../../../components/v3/primitives/Iconset';

const NAV: { href: string; labelKey: string; match: (p: string) => boolean }[] = [
  { href: '/account', labelKey: 'overview', match: (p) => p === '/account' },
  { href: '/account/plans', labelKey: 'plans', match: (p) => p === '/account/plans' },
  // Exact so it does not also light on the nested invoices route below.
  { href: '/account/billing', labelKey: 'billing', match: (p) => p === '/account/billing' },
  {
    href: '/account/billing/history',
    labelKey: 'orders',
    match: (p) => p === '/account/billing/history' || p.startsWith('/account/billing/history/'),
  },
  { href: '/account/usage', labelKey: 'usage', match: (p) => p === '/account/usage' },
  { href: '/account/security', labelKey: 'security', match: (p) => p === '/account/security' },
];

export default function AccountLayout({ children }: { children: ReactNode }) {
  const t = useTranslations('account');
  const pathname = usePathname() ?? '/account';
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();

  // ── Checkout-return banner (?billing=success|cancel) ───────────────
  const [billingBanner, setBillingBanner] = useState<'success' | 'cancel' | null>(null);
  useEffect(() => {
    const flag = searchParams?.get('billing');
    if (flag === 'success' || flag === 'cancel') {
      setBillingBanner(flag);
      if (flag === 'success') {
        // The subscription likely changed — repaint plan + profile everywhere.
        qc.invalidateQueries({ queryKey: ['account', 'plan'] });
        qc.invalidateQueries({ queryKey: ['account', 'profile'] });
        qc.invalidateQueries({ queryKey: ['account', 'credits'] });
      }
      // Strip the param (keep the current tab) so a refresh doesn't re-show it.
      router.replace(pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return (
    <>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} accentWord={t('titleAccent')} />

      {billingBanner ? (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
            marginBottom: 20,
            padding: '12px 16px',
            borderRadius: 'var(--r-md)',
            border: `1px solid ${billingBanner === 'success' ? 'var(--ok)' : 'var(--rule)'}`,
            background: billingBanner === 'success' ? 'var(--ok-soft)' : 'var(--surface)',
            color: billingBanner === 'success' ? 'var(--ok)' : 'var(--text-2)',
            fontSize: '13.5px',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {billingBanner === 'success' ? <IconCheck size={16} /> : <IconX size={16} />}
            {billingBanner === 'success' ? t('billing.checkout.success') : t('billing.checkout.cancel')}
          </span>
          <button
            type="button"
            aria-label={t('billing.checkout.dismiss')}
            onClick={() => setBillingBanner(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'grid' }}
          >
            <IconX size={15} />
          </button>
        </div>
      ) : null}

      {/* Route-based section tabs. */}
      <div
        role="tablist"
        aria-label={t('title')}
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '1px solid var(--rule)',
          marginBottom: 28,
          overflowX: 'auto',
        }}
      >
        {NAV.map((item) => {
          const on = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              role="tab"
              aria-selected={on}
              aria-current={on ? 'page' : undefined}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: '12px',
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: on ? 'var(--text)' : 'var(--muted)',
                textDecoration: 'none',
                padding: '12px 16px',
                whiteSpace: 'nowrap',
                boxShadow: on ? 'inset 0 -2px 0 var(--accent)' : 'none',
              }}
            >
              {t(`nav.${item.labelKey}`)}
            </Link>
          );
        })}
      </div>

      {children}
    </>
  );
}
