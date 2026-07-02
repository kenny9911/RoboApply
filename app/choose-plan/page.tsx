'use client';

// /choose-plan — post-signup plan selection (the chromeless welcome moment). A
// new user lands here right after creating their account: pick Free / Starter /
// Growth (region-priced). Free continues straight into the product; Starter /
// Growth redirect to Stripe (USD) or Alipay (RMB) checkout and return to the
// same destination after payment.
//
// Top-level route (outside (auth)/(public)) → fullscreen, no Sidebar. Auth is
// enforced by proxy.ts (/choose-plan is in PROTECTED_PREFIXES). The plan grid is
// the SHARED <PlanCatalog mode="post-signup"> — the exact same cards the in-app
// /plans page renders, so a user who skips here sees identical pricing later.
// i18n: choosePlan.* for page chrome; account.plan.* / plans.* reused by the
// catalog for labels/features/CTAs.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useBillingPlan, useCheckout, useAlipayCheckout } from '../../hooks/useAccount';
import { useJobApplyingEnabled } from '../../lib/jobApplying';
import { RegionToggle, PlanCatalog } from '../../components/v3/account';

export default function ChoosePlanPage() {
  const t = useTranslations('choosePlan');
  const router = useRouter();

  const jobApplyingEnabled = useJobApplyingEnabled();
  // Where to land after the plan step — mirrors the signup routing.
  const nextPath = jobApplyingEnabled === false ? '/resumes' : '/onboarding';

  const [regionOverride, setRegionOverride] = useState<'cn' | 'other' | null>(null);
  const planQ = useBillingPlan(regionOverride);
  const checkout = useCheckout();
  const alipay = useAlipayCheckout();
  const busy = checkout.isPending || alipay.isPending;
  const plan = planQ.data;

  const [checkoutError, setCheckoutError] = useState(false);

  const continueFree = () => router.replace(nextPath);

  const selectPaid = (tier: 'starter' | 'growth') => {
    setCheckoutError(false);
    const mutation = plan?.region.method === 'alipay' ? alipay : checkout;
    mutation.mutate(
      { tier, next: nextPath },
      {
        onSuccess: (res) => { window.location.href = res.url; },
        // Provider unreachable / rejected the order — surface it (don't fail silent).
        onError: () => setCheckoutError(true),
      },
    );
  };

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg)', color: 'var(--text)', padding: '40px 20px 64px' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto' }}>
        {/* Header — welcome eyebrow + title + sub, region toggle right. */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 28 }}>
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--accent-text)', marginBottom: 8 }}>
              {t('welcome')}
            </div>
            <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.03em', margin: '0 0 6px' }}>{t('title')}</h1>
            <p style={{ color: 'var(--text-2)', fontSize: 15, margin: 0, maxWidth: 560 }}>{t('subtitle')}</p>
          </div>
          {plan ? <RegionToggle region={plan.region.market} onChange={setRegionOverride} /> : null}
        </div>

        {/* States */}
        {planQ.isLoading ? (
          <div aria-busy="true" aria-label={t('loading')} style={{ color: 'var(--muted)', fontSize: 14, padding: 40 }}>{t('loading')}</div>
        ) : planQ.isError || !plan ? (
          <div role="alert" style={{ color: 'var(--warn)', fontSize: 14, padding: 24 }}>
            {t('error')} ·{' '}
            <button onClick={() => planQ.refetch()} style={{ color: 'var(--accent-text)', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer' }}>
              {t('retry')}
            </button>
          </div>
        ) : (
          <>
            <PlanCatalog
              plan={plan}
              busy={busy}
              mode="post-signup"
              onSelectPaid={selectPaid}
              onSelectFree={continueFree}
              onCancel={() => { /* no active sub yet at signup */ }}
            />

            {checkoutError ? (
              <p role="alert" style={{ textAlign: 'center', marginTop: 18, fontSize: 13.5, color: 'var(--warn)' }}>
                {t('checkoutFailed')}
              </p>
            ) : null}

            <p style={{ textAlign: 'center', marginTop: 18, fontSize: 13, color: 'var(--muted)' }}>{t('creditsHint')}</p>

            <div style={{ textAlign: 'center', marginTop: 10 }}>
              <button
                onClick={continueFree}
                disabled={busy}
                style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 13.5, cursor: busy ? 'not-allowed' : 'pointer', textDecoration: 'underline' }}
              >
                {t('continueFree')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
