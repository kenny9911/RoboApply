'use client';

// /plans — the dedicated, in-shell Subscription Plans page for job seekers.
//
// The canonical place a logged-in candidate views and changes their
// mock-interview subscription (Free / Starter / Growth). Lives inside the
// (auth) route group → inherits the V3 shell (Sidebar + Topbar) and all four
// gates (AuthGate → RoboApplyAccessGate → JobApplyingGate → ResumeGate).
//
// State order mirrors app/(auth)/account/page.tsx: header always first, then
// error → loading skeleton → success (the frame never jumps). Pricing,
// checkout, region, and credits all reuse the existing billing stack
// (hooks/useAccount.ts + components/v3/account/*). The plan grid is the shared
// <PlanCatalog mode="in-app"> — the same component the post-signup /choose-plan
// renders, so a user who skips at signup sees identical cards here later.
//
// Post-checkout return: paid CTAs pass { next:'/plans', cancelNext:'/plans' } so
// Stripe/Alipay return to THIS page; the backend appends ?billing=success|cancel,
// which we surface as a banner, refetch on, and strip (like /account).

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { PageHeader } from '../../../components/v3/primitives/PageHeader';
import { Btn } from '../../../components/v3/primitives/Btn';
import { IconCheck, IconX, IconBolt } from '../../../components/v3/primitives/Iconset';
import {
  Panel,
  PlanCatalog,
  RegionToggle,
  CurrentPlanCard,
  CreditsCard,
  BillingHistoryLink,
} from '../../../components/v3/account';
import {
  useBillingPlan,
  useCheckout,
  useAlipayCheckout,
  usePortal,
  useCancelPlan,
} from '../../../hooks/useAccount';
import { RoboApiError } from '../../../lib/api/client';

const FAQ_KEYS = ['1', '2', '3', '4', '5'] as const;

export default function PlansPage() {
  const t = useTranslations('plans');
  // account.billing.checkout.* is reused for the Stripe/Alipay return banner.
  const ta = useTranslations('account');
  const router = useRouter();
  const searchParams = useSearchParams();

  // Region override (USD ⇄ RMB). null → backend resolves from country/locale.
  const [regionOverride, setRegionOverride] = useState<'cn' | 'other' | null>(null);

  const planQ = useBillingPlan(regionOverride);
  const checkout = useCheckout();
  const alipay = useAlipayCheckout();
  const portal = usePortal();
  const cancelPlan = useCancelPlan();

  // Checkout-start failure (payment provider unreachable / rejected the order).
  const [checkoutError, setCheckoutError] = useState(false);

  // ── Stripe/Alipay-return banner (?billing=success|cancel) ──────────
  const [billingBanner, setBillingBanner] = useState<'success' | 'cancel' | null>(null);
  useEffect(() => {
    const flag = searchParams?.get('billing');
    if (flag === 'success' || flag === 'cancel') {
      setBillingBanner(flag);
      // On a successful return the subscription likely changed — refetch so the
      // now-current tier flips to a disabled "Current plan".
      if (flag === 'success') void planQ.refetch();
      // Strip the param so a refresh doesn't re-show the banner.
      router.replace('/plans');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ── Header (always first; stable frame across all states) ──────────
  const header = (
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} accentWord={t('titleAccent')} sub={t('subtitle')} />
  );

  // ── Error ──────────────────────────────────────────────────────────
  if (planQ.isError) {
    return (
      <>
        {header}
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
      </>
    );
  }

  // ── Loading skeleton ───────────────────────────────────────────────
  if (planQ.isLoading || !planQ.data) {
    return (
      <>
        {header}
        <PlansSkeleton label={t('loading')} />
      </>
    );
  }

  const plan = planQ.data;
  const busy = checkout.isPending || alipay.isPending || cancelPlan.isPending;
  const paymentsUnavailable = !plan.stripeConfigured && !plan.alipayConfigured;

  // Subscribe to a paid tier. Stripe (USD) or Alipay (RMB) by resolved region.
  // success → /plans (the ?billing=success banner + refetch land here).
  // cancelNext → /plans is the STRIPE cancel return; Alipay has no separate
  // cancel URL (one-time pass), so it ignores cancelNext — harmless to pass.
  const onSelectPaid = (tier: 'starter' | 'growth') => {
    setCheckoutError(false);
    const useAlipay = plan.region.method === 'alipay';
    const mutation = useAlipay ? alipay : checkout;
    mutation.mutate(
      { tier, next: '/plans', cancelNext: '/plans' },
      {
        onSuccess: (res) => { window.location.href = res.url; },
        // The provider was unreachable or rejected the order (e.g. a 502 from
        // the Alipay worker). Surface it instead of failing silently.
        onError: () => setCheckoutError(true),
      },
    );
  };

  const onManageBilling = () => {
    portal.mutate(undefined, {
      onSuccess: (res) => { window.location.href = res.url; },
      onError: (err) => {
        // 409 no_customer — gracefully do nothing visible beyond logging.
        if (err instanceof RoboApiError && err.code === 'not_found') return;
      },
    });
  };

  // ── Success ─────────────────────────────────────────────────────────
  return (
    <>
      {header}

      {billingBanner ? (
        <div
          role="status"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, marginBottom: 20,
            padding: '12px 16px', borderRadius: 'var(--r-md)',
            border: `1px solid ${billingBanner === 'success' ? 'var(--ok)' : 'var(--rule)'}`,
            background: billingBanner === 'success' ? 'var(--ok-soft)' : 'var(--surface)',
            color: billingBanner === 'success' ? 'var(--ok)' : 'var(--text-2)', fontSize: '13.5px',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {billingBanner === 'success' ? <IconCheck size={16} /> : <IconX size={16} />}
            {/* Reuse the /account checkout banner copy — do not duplicate keys. */}
            {billingBanner === 'success' ? ta('billing.checkout.success') : ta('billing.checkout.cancel')}
          </span>
          <button
            type="button"
            aria-label={ta('billing.checkout.dismiss')}
            onClick={() => setBillingBanner(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'grid' }}
          >
            <IconX size={15} />
          </button>
        </div>
      ) : null}

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

      {/* Current-plan context: where the user is today. */}
      <CurrentPlanCard
        plan={plan}
        onManageBilling={onManageBilling}
        onCancel={() => cancelPlan.mutate()}
        managing={portal.isPending}
        canceling={cancelPlan.isPending}
      />
      <div style={{ marginTop: 16 }}>
        <CreditsCard credits={plan.credits} />
      </div>

      {/* Region toggle sits right above the grid whose prices it controls. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 22 }}>
        <RegionToggle region={plan.region.market} onChange={setRegionOverride} />
      </div>

      {paymentsUnavailable ? (
        <p
          role="status"
          style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}
        >
          {t('notice.paymentsUnavailable')}
        </p>
      ) : null}

      {/* The shared catalog — identical cards to /choose-plan. */}
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

      <BillingHistoryLink />

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
      <div style={{ ...shimmer(), height: 120, marginBottom: 16 }} />
      <div style={{ ...shimmer(), height: 96, marginBottom: 22 }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <div style={{ ...shimmer(), width: 150, height: 30, borderRadius: 99 }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 28 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ ...shimmer(), height: 360 }} />
        ))}
      </div>
      <div style={{ ...shimmer(), height: 72, marginBottom: 16 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ ...shimmer(), height: 44 }} />
        ))}
      </div>
    </div>
  );
}
