'use client';

// /account/billing — Billing tab: manage the current subscription.
//
// CurrentPlanCard (tier · price · status · renewal + Manage/Cancel via the
// Stripe customer portal) + the credit balance + a nudge into the Plans tab to
// upgrade/compare + a link to Orders & Invoices. Choosing a NEW plan lives on
// the Plans tab; this tab is about the subscription you already have.
//
// The shared layout owns the header, tabs, and checkout-return banner.

import { useTranslations } from 'next-intl';
import Link from 'next/link';

import { Panel } from '../../../../components/v3/account';
import { Btn } from '../../../../components/v3/primitives/Btn';
import {
  CurrentPlanCard,
  CreditsCard,
  BillingHistoryLink,
} from '../../../../components/v3/account';
import {
  useBillingPlan,
  usePortal,
  useCancelPlan,
} from '../../../../hooks/useAccount';
import { RoboApiError } from '../../../../lib/api/client';

export default function AccountBillingPage() {
  const t = useTranslations('account');

  // Region resolved by the backend here (price changes live on the Plans tab).
  const planQ = useBillingPlan(null);
  const portal = usePortal();
  const cancelPlan = useCancelPlan();

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
    return <BillingSkeleton label={t('loading')} />;
  }

  const plan = planQ.data;

  const onManageBilling = () => {
    portal.mutate(undefined, {
      onSuccess: (res) => { window.location.href = res.url; },
      onError: (err) => {
        // 409 no_customer — gracefully do nothing visible beyond logging.
        if (err instanceof RoboApiError && err.code === 'not_found') return;
      },
    });
  };

  // Tier-aware "compare/upgrade plans" nudge into the Plans tab.
  const isMax = plan.current.tier === 'growth';
  const k = (base: string) => `billing.explore.${base}${isMax ? 'Max' : ''}`;

  return (
    <>
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

      <Panel style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 3 }}>{t(k('title'))}</div>
          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{t(k('sub'))}</div>
        </div>
        <Link href="/account/plans" style={{ textDecoration: 'none' }}>
          <Btn variant="primary">{t(k('cta'))}</Btn>
        </Link>
      </Panel>

      <BillingHistoryLink />
    </>
  );
}

function BillingSkeleton({ label }: { label: string }) {
  const shimmer = (): React.CSSProperties => ({ background: 'var(--surface-2)', borderRadius: 8 });
  return (
    <div className="animate-pulse" aria-busy="true" aria-label={label}>
      <div style={{ ...shimmer(), height: 120, marginBottom: 16 }} />
      <div style={{ ...shimmer(), height: 96, marginBottom: 16 }} />
      <div style={{ ...shimmer(), height: 72 }} />
    </div>
  );
}
