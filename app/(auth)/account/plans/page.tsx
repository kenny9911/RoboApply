'use client';

// /account/plans — Plans / Upgrade tab.
//
// The catalogue where a candidate views and changes their mock-interview
// subscription (Free / Starter / Growth). The plan grid is the shared
// <PlanCatalog mode="in-app"> — the same component /choose-plan renders — so a
// user who skips at signup sees identical cards here. Region toggle (USD ⇄ RMB)
// controls the prices; the catalog marks the current tier as "Current plan".
//
// Pricing/checkout reuse the existing billing stack (hooks/useAccount.ts). Paid
// CTAs pass { next:'/account/plans', cancelNext:'/account/plans' } so
// Stripe/Alipay return to THIS tab; the shared layout catches the resulting
// ?billing=success|cancel and shows the return banner. The payment contract
// (routes, worker wire, callback) is unchanged — only the return path moved.

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Panel } from '../../../../components/v3/account';
import { Btn } from '../../../../components/v3/primitives/Btn';
import { IconX, IconBolt } from '../../../../components/v3/primitives/Iconset';
import {
  PlanCatalog,
  RegionToggle,
} from '../../../../components/v3/account';
import {
  useBillingPlan,
  useCheckout,
  useAlipayCheckout,
  useCancelPlan,
} from '../../../../hooks/useAccount';

const FAQ_KEYS = ['1', '2', '3', '4', '5'] as const;

export default function AccountPlansPage() {
  const t = useTranslations('plans');
  const ta = useTranslations('account');

  // Region override (USD ⇄ RMB). null → backend resolves from country/locale.
  const [regionOverride, setRegionOverride] = useState<'cn' | 'other' | null>(null);

  const planQ = useBillingPlan(regionOverride);
  const checkout = useCheckout();
  const alipay = useAlipayCheckout();
  const cancelPlan = useCancelPlan();

  const [checkoutError, setCheckoutError] = useState(false);

  if (planQ.isError) {
    return (
      <div
        role="alert"
        className="flex flex-col items-center gap-4 text-center"
        style={{ border: '1px solid var(--rule)', background: 'var(--surface)', borderRadius: 'var(--r-xl)', padding: '52px 32px' }}
      >
        <p style={{ fontFamily: 'var(--sans)', fontSize: '18px', fontWeight: 600, color: 'var(--text)', margin: 0 }}>
          {t('error.title')}
        </p>
        <p style={{ color: 'var(--text-2)', fontSize: '14px', maxWidth: 420, margin: 0 }}>{t('error.body')}</p>
        <Btn variant="primary" onClick={() => void planQ.refetch()}>{t('error.retry')}</Btn>
      </div>
    );
  }

  if (planQ.isLoading || !planQ.data) {
    return <PlansSkeleton label={t('loading')} />;
  }

  const plan = planQ.data;
  const busy = checkout.isPending || alipay.isPending || cancelPlan.isPending;
  const paymentsUnavailable = !plan.stripeConfigured && !plan.alipayConfigured;

  // Subscribe to a paid tier. Stripe (USD) or Alipay (RMB) by resolved region.
  // success + cancel both return to /account/plans; the layout catches the
  // ?billing flag. Alipay (one-time pass) ignores cancelNext — harmless to pass.
  const onSelectPaid = (tier: 'starter' | 'growth') => {
    setCheckoutError(false);
    const useAlipay = plan.region.method === 'alipay';
    const mutation = useAlipay ? alipay : checkout;
    mutation.mutate(
      { tier, next: '/account/plans', cancelNext: '/account/plans' },
      {
        onSuccess: (res) => { window.location.href = res.url; },
        onError: () => setCheckoutError(true),
      },
    );
  };

  return (
    <>
      {checkoutError ? (
        <div
          role="alert"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, marginBottom: 20,
            padding: '12px 16px', borderRadius: 'var(--r-md)', border: '1px solid var(--warn)',
            background: 'var(--warn-soft)', color: 'var(--warn)', fontSize: '13.5px',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <IconX size={16} />
            {t('checkout.failed')}
          </span>
          <button
            type="button"
            aria-label={ta('billing.checkout.dismiss')}
            onClick={() => setCheckoutError(false)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'grid' }}
          >
            <IconX size={15} />
          </button>
        </div>
      ) : null}

      {/* Region toggle sits right above the grid whose prices it controls. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <RegionToggle region={plan.region.market} onChange={setRegionOverride} />
      </div>

      {paymentsUnavailable ? (
        <p role="status" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>
          {t('notice.paymentsUnavailable')}
        </p>
      ) : null}

      {/* The shared catalog — identical cards to /choose-plan; marks current tier. */}
      <PlanCatalog
        plan={plan}
        busy={busy}
        mode="in-app"
        onSelectPaid={onSelectPaid}
        onSelectFree={() => { /* no-op in-app; downgrade handled per-card via onCancel */ }}
        onCancel={() => cancelPlan.mutate()}
      />

      {/* How credits work (the rule, not the live balance). */}
      <Panel style={{ marginTop: 28, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ color: 'var(--accent-text)', flexShrink: 0, marginTop: 2 }}><IconBolt size={18} /></span>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{t('credits.title')}</div>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 }}>{t('credits.explainer')}</p>
        </div>
      </Panel>

      {/* FAQ — native <details> for free keyboard + AT support. */}
      <Panel style={{ marginTop: 28, padding: 0 }}>
        <div style={{ padding: '18px 20px 6px', fontSize: 15, fontWeight: 600 }}>{t('faq.title')}</div>
        {FAQ_KEYS.map((k) => (
          <details key={k} className="ra-plans-faq">
            <summary
              style={{
                cursor: 'pointer', listStyle: 'none', padding: '14px 20px', fontSize: 14, fontWeight: 600,
                color: 'var(--text)', borderTop: '1px solid var(--rule)', display: 'flex', justifyContent: 'space-between', gap: 12,
              }}
            >
              <span>{t(`faq.q${k}`)}</span>
              <span aria-hidden="true" style={{ color: 'var(--muted)' }}>＋</span>
            </summary>
            <p style={{ margin: 0, padding: '0 20px 16px', fontSize: 13, color: 'var(--text-2)', lineHeight: 1.65 }}>
              {t(`faq.a${k}`)}
            </p>
          </details>
        ))}
      </Panel>
    </>
  );
}

function PlansSkeleton({ label }: { label: string }) {
  const shimmer = (): React.CSSProperties => ({ background: 'var(--surface-2)', borderRadius: 8 });
  return (
    <div className="animate-pulse" aria-busy="true" aria-label={label}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <div style={{ ...shimmer(), width: 150, height: 30, borderRadius: 99 }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 28 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ ...shimmer(), height: 360 }} />
        ))}
      </div>
      <div style={{ ...shimmer(), height: 72 }} />
    </div>
  );
}
