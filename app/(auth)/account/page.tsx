'use client';

// /account — Account Overview tab.
//
// The identity landing of the unified Account area: profile (avatar + inline
// name edit + email/verified/provider/member-since) plus a credit-balance
// glance. Subscription management lives on the Billing tab, the plan catalogue
// on the Plans tab — the shared shell (layout.tsx) owns the header, the section
// tabs, and the checkout-return banner, so this page renders only its body.

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';

import { Btn } from '../../../components/v3/primitives/Btn';
import {
  ProfileCard,
  CreditsCard,
} from '../../../components/v3/account';
import {
  useAccountProfile,
  useBillingPlan,
  useUpdateName,
} from '../../../hooks/useAccount';

export default function AccountOverviewPage() {
  const t = useTranslations('account');
  const locale = useLocale();

  const profileQ = useAccountProfile();
  // Region resolved by the backend for the glance; price changes live on Plans.
  const planQ = useBillingPlan(null);
  const updateName = useUpdateName();

  if (profileQ.isError || planQ.isError) {
    return (
      <ErrorPanel
        title={t('error.title')}
        body={t('error.body')}
        retry={t('error.retry')}
        onRetry={() => {
          void profileQ.refetch();
          void planQ.refetch();
        }}
      />
    );
  }

  if (profileQ.isLoading || planQ.isLoading || !profileQ.data || !planQ.data) {
    return <OverviewSkeleton label={t('loading')} />;
  }

  const profile = profileQ.data;
  const plan = planQ.data;
  const memberSinceLabel = formatMemberSince(locale, profile.memberSince, t);

  return (
    <>
      <ProfileCard
        name={profile.name}
        email={profile.email}
        provider={profile.provider}
        memberSinceLabel={memberSinceLabel}
        // No explicit verified flag in the contract; an authenticated account
        // (OAuth or confirmed-email signup) is treated as verified.
        verified={true}
        saving={updateName.isPending}
        onSaveName={(name) => updateName.mutate(name)}
      />
      <div style={{ marginTop: 16 }}>
        <CreditsCard credits={plan.credits} />
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function formatMemberSince(
  locale: string,
  iso: string,
  t: (k: string, v?: Record<string, string>) => string,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let when = '';
  try {
    when = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' }).format(d);
  } catch {
    when = d.toLocaleDateString();
  }
  return t('profile.memberSince', { date: when });
}

function ErrorPanel({
  title,
  body,
  retry,
  onRetry,
}: {
  title: string;
  body: string;
  retry: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-4 text-center"
      style={{
        border: '1px solid var(--rule)',
        background: 'var(--surface)',
        borderRadius: 'var(--r-xl)',
        padding: '52px 32px',
      }}
    >
      <p style={{ fontFamily: 'var(--sans)', fontSize: '18px', fontWeight: 600, color: 'var(--text)', margin: 0 }}>
        {title}
      </p>
      <p style={{ color: 'var(--text-2)', fontSize: '14px', maxWidth: 420, margin: 0 }}>{body}</p>
      <Btn variant="primary" onClick={onRetry}>
        {retry}
      </Btn>
    </div>
  );
}

function OverviewSkeleton({ label }: { label: string }) {
  const shimmer = (): React.CSSProperties => ({ background: 'var(--surface-2)', borderRadius: 8 });
  return (
    <div className="animate-pulse" aria-busy="true" aria-label={label}>
      <div style={{ ...shimmer(), height: 108, marginBottom: 16 }} />
      <div style={{ ...shimmer(), height: 96 }} />
    </div>
  );
}
