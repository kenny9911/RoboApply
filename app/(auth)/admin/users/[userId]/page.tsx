'use client';

// /admin/users/[userId] — user profitability drill-down (admin-only).
//
// The emotional core of the admin page: ProfitabilitySummary hero (cost ·
// revenue → margin) + three-up cost cards + a daily-cost sparkline + a
// cost-by-feature ledger + an interview-sessions ledger. The admin "Set plan"
// action opens SetPlanModal (tier + optional custom price + REQUIRED reason)
// → useSetPlan mutation → success banner + refetch.
//
// Full route (linkable / shareable), own PageHeader, renders inner content
// only (the (auth) shell provides the chrome; /admin/* is ResumeGate-exempt).

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { useAuth } from '../../../../../lib/auth/useAuth';
import { useAdminUser, useSetPlan } from '../../../../../hooks/useAdmin';
import { RoboApiError } from '../../../../../lib/api/client';
import { PageHeader } from '../../../../../components/v3/primitives/PageHeader';
import { EmptyState } from '../../../../../components/v3/primitives/EmptyState';
import { Btn } from '../../../../../components/v3/primitives/Btn';
import { IconArrow, IconCheck } from '../../../../../components/v3/primitives/Iconset';
import {
  ChartCard,
  Sparkline,
  DataTable,
  StatusBadge,
  ProfitabilitySummary,
  SetPlanModal,
  type Column,
  fmtCurrency,
  fmtCount,
  fmtPercent,
  fmtShortDate,
} from '../../../../../components/v3/admin';
import type {
  AdminCostByFeature,
  AdminUserInterviewSession,
  AdminSetPlanBody,
} from '../../../../../lib/api/admin';

export default function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const t = useTranslations('admin');
  const locale = useLocale();
  const router = useRouter();
  const { userId } = use(params);

  const { user, status } = useAuth();
  const isAdmin = !!user && user.role === 'admin';

  const q = useAdminUser(isAdmin ? userId : null);
  const setPlan = useSetPlan(userId);

  const [planOpen, setPlanOpen] = useState(false);
  const [savedBanner, setSavedBanner] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const backBtn = (
    <Btn variant="ghost" icon={<IconArrow size={15} style={{ transform: 'rotate(180deg)' }} />} onClick={() => router.push('/admin')}>
      {t('detail.back')}
    </Btn>
  );

  // Admin gate
  if (status === 'loading') {
    return <div style={{ height: 200 }} />;
  }
  if (!isAdmin) {
    return (
      <EmptyState
        icon={<span style={{ fontSize: 34 }}>🔒</span>}
        title={t('notAuthorized.title')}
        accentWord={t('notAuthorized.titleAccent')}
        sub={t('notAuthorized.sub')}
      />
    );
  }

  const header = (
    <PageHeader
      eyebrow={t('detail.eyebrow', { email: q.data?.user.email ?? '…' })}
      title={t('title')}
      accentWord={t('detail.titleAccent')}
      actions={backBtn}
    />
  );

  if (q.isError) {
    return (
      <>
        {header}
        <div
          role="alert"
          className="flex flex-col items-center gap-4 text-center"
          style={{ border: '1px solid var(--rule)', background: 'var(--surface)', borderRadius: 'var(--r-xl)', padding: '52px 32px' }}
        >
          <p style={{ fontFamily: 'var(--sans)', fontSize: 18, fontWeight: 600, color: 'var(--text)', margin: 0 }}>{t('error.title')}</p>
          <p style={{ color: 'var(--text-2)', fontSize: 14, maxWidth: 420, margin: 0 }}>{t('error.body')}</p>
          <Btn variant="primary" onClick={() => void q.refetch()}>
            {t('error.retry')}
          </Btn>
        </div>
      </>
    );
  }

  if (q.isLoading || !q.data) {
    return (
      <>
        {header}
        <div className="animate-pulse" aria-busy="true" aria-label={t('loading')} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ height: 140, borderRadius: 14, background: 'var(--surface-2)' }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ height: 90, borderRadius: 14, background: 'var(--surface-2)' }} />
            ))}
          </div>
          <div style={{ height: 120, borderRadius: 14, background: 'var(--surface-2)' }} />
        </div>
      </>
    );
  }

  const data = q.data;
  const currency = data.subscription.currency || 'USD';
  const { profitability: p } = data;

  // Daily-cost sparkline points.
  const sparkPoints = data.dailyUsage.map((d) => d.costUsd);
  const avgDaily =
    data.dailyUsage.length > 0
      ? data.dailyUsage.reduce((s, d) => s + d.costUsd, 0) / data.dailyUsage.length
      : 0;

  // Cost-by-feature ledger.
  const featTotal = data.costByFeature.reduce((s, f) => s + f.costUsd, 0) || 1;
  const featColumns: Column<AdminCostByFeature>[] = [
    { key: 'feature', header: t('detail.col.feature'), render: (f) => f.label },
    { key: 'calls', header: t('detail.col.calls'), align: 'right', render: (f) => fmtCount(f.units, locale) },
    { key: 'cost', header: t('detail.col.cost'), align: 'right', render: (f) => fmtCurrency(f.costUsd, locale, currency) },
    {
      key: 'pct',
      header: t('detail.col.pctSpend'),
      align: 'right',
      render: (f) => fmtPercent((f.costUsd / featTotal) * 100, locale),
    },
  ];

  // Interview-sessions ledger.
  const sessionColumns: Column<AdminUserInterviewSession>[] = [
    { key: 'date', header: t('sessions.col.date'), render: (s) => <span style={{ color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 12 }}>{fmtShortDate(s.createdAt, locale)}</span> },
    { key: 'role', header: t('sessions.col.role'), render: (s) => s.role ?? '—' },
    { key: 'duration', header: t('sessions.col.duration'), align: 'right', render: (s) => durLabel(s.durationSec) },
    { key: 'cost', header: t('detail.col.cost'), align: 'right', render: (s) => fmtCurrency(s.costUsd, locale, currency) },
    {
      key: 'split',
      header: t('detail.col.split'),
      align: 'right',
      render: (s) => (
        <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11 }}>
          {splitText(s.cost.stt)}/{splitText(s.cost.tts)}/{splitText(s.cost.llm)}
        </span>
      ),
    },
    { key: 'status', header: t('sessions.col.status'), render: (s) => <StatusBadge status={s.status} /> },
  ];

  return (
    <>
      {header}

      {savedBanner ? (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            border: '1px solid var(--ok)',
            background: 'var(--ok-soft)',
            color: 'var(--ok)',
            borderRadius: 12,
            padding: '10px 14px',
            marginBottom: 16,
            fontFamily: 'var(--mono)',
            fontSize: 12.5,
          }}
        >
          <IconCheck size={14} strokeWidthValue={2.5} />
          {t('setPlan.success')}
        </div>
      ) : null}

      <ProfitabilitySummary
        cost={p.periodCostUsd}
        revenue={p.mrrUsd}
        marginPct={p.marginPct}
        profitable={p.profitable}
        tier={data.subscription.tier}
        renewsAt={data.subscription.currentPeriodEnd}
        currency={currency}
        locale={locale}
        onSetPlan={() => {
          setPlanError(null);
          setPlanOpen(true);
        }}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 18 }}>
        <SmallStat label={t('detail.lifetimeCost')} value={fmtCurrency(p.lifetimeCostUsd, locale, currency)} />
        <SmallStat label={t('detail.periodCost')} value={fmtCurrency(p.periodCostUsd, locale, currency)} />
        <SmallStat label={t('detail.lifetimeRevenue')} value={fmtCurrency(p.mrrUsd, locale, currency)} />
      </div>

      <div style={{ marginBottom: 8 }}>
        <ChartCard
          caption={t('detail.dailyCost')}
          aside={t('detail.avgDaily', { amount: fmtCurrency(avgDaily, locale, currency) })}
          minHeight={64}
        >
          {sparkPoints.length > 0 ? (
            <Sparkline points={sparkPoints} />
          ) : (
            <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>—</p>
          )}
        </ChartCard>
      </div>

      <SubHeading>{t('detail.costByFeature')}</SubHeading>
      <DataTable
        columns={featColumns}
        rows={data.costByFeature}
        rowKey={(f) => f.key}
        emptyMessage="—"
        errorTitle={t('error.title')}
      />

      <SubHeading>{t('detail.interviewSessions')}</SubHeading>
      <DataTable
        columns={sessionColumns}
        rows={data.interviewSessions}
        rowKey={(s) => s.id}
        onRowClick={(s) => router.push(`/admin/sessions/${encodeURIComponent(s.id)}`)}
        emptyMessage="—"
        errorTitle={t('error.title')}
      />

      <SetPlanModal
        open={planOpen}
        currentTier={data.subscription.tier}
        currency={currency}
        submitting={setPlan.isPending}
        errorMessage={planError}
        onClose={() => setPlanOpen(false)}
        onConfirm={(body: AdminSetPlanBody) => {
          setPlanError(null);
          setPlan.mutate(body, {
            onSuccess: () => {
              setPlanOpen(false);
              setSavedBanner(true);
              setTimeout(() => setSavedBanner(false), 4000);
            },
            onError: (err) => {
              setPlanError(err instanceof RoboApiError ? err.message : t('error.body'));
            },
          });
        }}
      />
    </>
  );
}

function SmallStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        border: '1px solid var(--rule)',
        background: 'var(--surface)',
        borderRadius: 14,
        padding: '16px 18px',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: 'var(--muted)',
          marginBottom: 9,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div className="robo-tnum" style={{ fontSize: 27, lineHeight: 1, letterSpacing: '-0.03em', fontWeight: 600, color: 'var(--text)' }}>
        {value}
      </div>
    </div>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color: 'var(--muted)',
        fontWeight: 600,
        margin: '24px 0 12px',
      }}
    >
      {children}
    </div>
  );
}

function durLabel(sec: number | null): string {
  if (sec === null || sec === undefined) return '—';
  const m = Math.round(sec / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function splitText(v: number | undefined): string {
  if (v === undefined || v === null) return '.00';
  // Show the cents-only short form ".11" used in the mockup.
  return v.toFixed(2).replace(/^0/, '');
}
