'use client';

// /admin — Operator console (admin-only).
//
// A single page with a tab rail under the PageHeader: Overview · Users ·
// Sessions · Rate card. A global DateRangePicker lives in the header actions
// and is the spine of every read. Drill-downs (user / session) are separate
// routes. Renders inner content only — the (auth) shell provides sidebar/
// topbar; /admin is exempt from the ResumeGate.
//
// State order mirrors activity/page.tsx: header (+ controls) always first,
// then per-tab error → loading skeleton → empty → success.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';

import { useAuth } from '../../../lib/auth/useAuth';
import {
  useAdminOverview,
  useAdminUsers,
  useAdminSessions,
  useAdminRateCard,
} from '../../../hooks/useAdmin';
import {
  adminCsvUrl,
  type AdminUsersSort,
} from '../../../lib/api/admin';
import { PageHeader } from '../../../components/v3/primitives/PageHeader';
import { EmptyState } from '../../../components/v3/primitives/EmptyState';
import { Btn } from '../../../components/v3/primitives/Btn';
import { Chip } from '../../../components/v3/primitives/Chip';
import { Pill } from '../../../components/v3/primitives/Pill';
import {
  IconRefresh,
  IconUpload,
  IconSearch,
  IconClock,
} from '../../../components/v3/primitives/Iconset';
import {
  DateRangePicker,
  TabRail,
  KpiStrip,
  Unit,
  resolveRange,
  type RangeValue,
  type KpiCell,
  ChartCard,
  ChartLegend,
  CostBreakdownBar,
  CostRevenueArea,
  ModalityDonut,
  DataTable,
  UserCell,
  TierBadge,
  StatusBadge,
  MarginBadge,
  RateCardPanel,
  type Column,
  type SortState,
  type BreakdownItem,
  fmtCurrency,
  fmtCurrencyWhole,
  fmtCount,
  fmtPercent,
  fmtRelative,
} from '../../../components/v3/admin';

type TabId = 'overview' | 'users' | 'sessions' | 'rateCard';

const MODALITY_COLORS: Record<string, string> = {
  llm: 'var(--accent-text)',
  stt: 'var(--cyan)',
  tts: 'var(--violet)',
  image: 'var(--pink)',
  egress: 'var(--warn)',
};

const ESTIMATED_MODALITIES = new Set(['stt', 'tts', 'egress']);

export default function AdminPage() {
  const t = useTranslations('admin');
  const locale = useLocale();
  const router = useRouter();
  const { user, status } = useAuth();
  const isAdmin = !!user && user.role === 'admin';

  const [tab, setTab] = useState<TabId>('overview');
  const [range, setRange] = useState<RangeValue>({ preset: '30d' });
  const resolved = useMemo(() => resolveRange(range), [range]);

  const header = (
    <PageHeader
      eyebrow={t('eyebrow')}
      eyebrowLive
      title={t('title')}
      accentWord={t('titleAccent')}
      actions={
        <>
          <DateRangePicker value={range} onChange={setRange} />
          <Btn variant="default" icon={<IconRefresh size={15} />} onClick={() => router.refresh()}>
            {t('export.refresh')}
          </Btn>
          <Btn
            as="a"
            href={adminCsvUrl(tab === 'sessions' ? 'sessions' : 'users', resolved)}
            variant="default"
            icon={<IconUpload size={15} />}
          >
            {t('export.csv')}
          </Btn>
        </>
      }
    />
  );

  // ── Admin gate ──
  if (status === 'loading') {
    return <>{header}</>;
  }
  if (!isAdmin) {
    return (
      <>
        {header}
        <EmptyState
          icon={<span style={{ fontSize: 34 }}>🔒</span>}
          title={t('notAuthorized.title')}
          accentWord={t('notAuthorized.titleAccent')}
          sub={t('notAuthorized.sub')}
        />
      </>
    );
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: t('tabs.overview') },
    { id: 'users', label: t('tabs.users') },
    { id: 'sessions', label: t('tabs.sessions') },
    { id: 'rateCard', label: t('tabs.rateCard') },
  ];

  return (
    <>
      {header}
      <TabRail tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'overview' ? (
        <OverviewTab range={resolved} locale={locale} onResetRange={() => setRange({ preset: '30d' })} />
      ) : null}
      {tab === 'users' ? <UsersTab range={resolved} locale={locale} /> : null}
      {tab === 'sessions' ? <SessionsTab range={resolved} locale={locale} /> : null}
      {tab === 'rateCard' ? <RateCardTab locale={locale} /> : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Overview tab
// ─────────────────────────────────────────────────────────────────────

function OverviewTab({
  range,
  locale,
  onResetRange,
}: {
  range: { from: string; to: string; tz: string };
  locale: string;
  onResetRange: () => void;
}) {
  const t = useTranslations('admin');
  const q = useAdminOverview(range);

  if (q.isError) {
    return <RetryPanel onRetry={() => void q.refetch()} />;
  }
  if (q.isLoading) {
    return (
      <>
        <KpiStrip kpis={[]} loading />
        <div style={{ height: 280, borderRadius: 14, background: 'var(--surface-2)', marginBottom: 16 }} className="animate-pulse" />
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
          <div style={{ height: 320, borderRadius: 14, background: 'var(--surface-2)' }} className="animate-pulse" />
          <div style={{ height: 320, borderRadius: 14, background: 'var(--surface-2)' }} className="animate-pulse" />
        </div>
      </>
    );
  }

  const data = q.data!;
  const { kpis } = data;
  const hasActivity = kpis.sessions > 0 || kpis.totalCostUsd > 0 || kpis.activeUsers > 0;

  if (!hasActivity) {
    return (
      <EmptyState
        icon={<span style={{ fontSize: 34 }}>📉</span>}
        title={t('empty.title')}
        accentWord={t('empty.titleAccent')}
        action={
          <Btn variant="primary" onClick={onResetRange}>
            {t('empty.reset')}
          </Btn>
        }
      />
    );
  }

  // Margin tone for the gross-margin KPI cell.
  const marginPct = kpis.grossMarginPct;
  const marginTone =
    marginPct === null ? undefined : marginPct < 0 ? 'neg' : marginPct < 30 ? 'warn' : 'pos';

  const kpiCells: KpiCell[] = [
    {
      label: t('kpi.activeUsers'),
      value: fmtCount(kpis.activeUsers, locale),
      hero: true,
    },
    { label: t('kpi.sessions'), value: fmtCount(kpis.sessions, locale) },
    {
      label: t('kpi.cost'),
      value: fmtCurrency(kpis.totalCostUsd, locale),
    },
    {
      label: t('kpi.revenue'),
      value: fmtCurrencyWhole(kpis.mrrUsd, locale),
      delta: t('kpi.payingUsers', { n: fmtCount(kpis.payingUsers, locale) }),
    },
    {
      label: t('kpi.margin'),
      value: <>{fmtPercent(kpis.grossMarginPct, locale)}</>,
      tone: marginTone,
    },
    {
      label: t('kpi.costPerUser'),
      value: fmtCurrency(kpis.costPerActiveUserUsd, locale),
    },
  ];

  // Cost-by-feature rows (sorted desc by cost). Top 2 get the "top cost" pill.
  const featTotal = data.costByFeature.reduce((s, f) => s + f.costUsd, 0) || 1;
  const sortedFeat = [...data.costByFeature].sort((a, b) => b.costUsd - a.costUsd);
  const featItems: BreakdownItem[] = sortedFeat.map((f, i) => ({
    label: f.label,
    value: f.costUsd,
    valueText: fmtCurrency(f.costUsd, locale),
    pctText: fmtPercent((f.costUsd / featTotal) * 100, locale),
    badge: i < 2 ? <Pill tone="warn">{t('topCost')}</Pill> : undefined,
  }));

  // Cost-by-modality donut segments.
  const modTotal = data.costByModality.reduce((s, m) => s + m.costUsd, 0) || 1;
  const modSegments = data.costByModality.map((m) => ({
    label: m.label,
    value: m.costUsd,
    color: MODALITY_COLORS[m.modality] ?? 'var(--accent-text)',
    estimated: ESTIMATED_MODALITIES.has(m.modality),
    valueText: fmtCurrency(m.costUsd, locale),
    pctText: fmtPercent((m.costUsd / modTotal) * 100, locale),
  }));

  return (
    <>
      <KpiStrip kpis={kpiCells} />

      <div style={{ marginBottom: 16 }}>
        <ChartCard
          caption={t('chart.costVsRevenue')}
          minHeight={280}
          legend={
            <ChartLegend
              items={[
                { color: 'var(--accent-text)', label: t('chart.legend.cost') },
                { color: 'var(--violet)', label: t('chart.legend.revenue') },
              ]}
            />
          }
        >
          <CostRevenueArea points={data.costSeries} locale={locale} />
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--text-2)',
              marginTop: 12,
              paddingTop: 12,
              borderTop: '1px solid var(--rule)',
            }}
          >
            {t('chart.netMargin', {
              amount: fmtCurrency(kpis.grossMarginUsd, locale),
              pct: fmtPercent(kpis.grossMarginPct, locale),
            })}
          </div>
        </ChartCard>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 16 }}>
        <ChartCard caption={t('chart.costByFeature')} aside={`${fmtCurrency(featTotal, locale)}`}>
          {featItems.length > 0 ? (
            <CostBreakdownBar items={featItems} variant="rows" />
          ) : (
            <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>—</p>
          )}
        </ChartCard>
        <ChartCard caption={t('chart.costByModality')}>
          {modSegments.length > 0 ? (
            <>
              <ModalityDonut
                segments={modSegments}
                centerValue={fmtCurrencyWhole(kpis.totalCostUsd, locale)}
                centerLabel={t('kpi.cost')}
              />
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: '10.5px',
                  color: 'var(--muted)',
                  marginTop: 14,
                  display: 'flex',
                  gap: 6,
                }}
              >
                ⌁ {t('estimatedNote')}
              </div>
            </>
          ) : (
            <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>—</p>
          )}
        </ChartCard>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Users tab
// ─────────────────────────────────────────────────────────────────────

function UsersTab({
  range,
  locale,
}: {
  range: { from: string; to: string; tz: string };
  locale: string;
}) {
  const t = useTranslations('admin');
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tierFilter, setTierFilter] = useState<'all' | 'free' | 'premium' | 'premium_plus'>('all');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState<AdminUsersSort>>({ key: 'marginUsd', dir: 'asc' });
  const pageSize = 25;

  // Debounce the search input.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(id);
  }, [search]);

  const params = {
    ...range,
    q: debounced || undefined,
    sort: sort.key,
    dir: sort.dir,
    page,
    pageSize,
    tier: tierFilter === 'all' ? undefined : tierFilter,
  };
  const q = useAdminUsers(params);

  const columns: Column<import('../../../lib/api/admin').AdminUserRow, AdminUsersSort>[] = [
    {
      key: 'email',
      header: t('users.col.user'),
      sortable: true,
      render: (r) => (
        <UserCell
          email={r.email}
          name={r.name}
          sub={r.currentPeriodEnd ? undefined : undefined}
        />
      ),
    },
    {
      key: 'tier',
      header: t('users.col.tier'),
      sortable: true,
      render: (r) => <TierBadge tier={r.tier} />,
    },
    {
      key: 'mrrUsd',
      header: t('users.col.mrr'),
      align: 'right',
      sortable: true,
      render: (r) => fmtCurrency(r.mrrUsd, locale),
    },
    {
      key: 'periodCostUsd',
      header: t('users.col.cost'),
      align: 'right',
      sortable: true,
      render: (r) => fmtCurrency(r.periodCostUsd, locale),
    },
    {
      key: 'marginUsd',
      header: t('users.col.margin'),
      align: 'right',
      sortable: true,
      render: (r) => (
        <MarginBadge amount={r.marginUsd} revenue={r.mrrUsd} locale={locale} profitable={r.profitable} />
      ),
    },
    {
      key: 'sessions',
      header: t('users.col.sessions'),
      align: 'right',
      sortable: true,
      render: (r) => fmtCount(r.sessions, locale),
    },
    {
      key: 'lastActiveAt',
      header: t('users.col.lastActive'),
      align: 'right',
      sortable: true,
      render: (r) => (
        <span style={{ color: 'var(--text-2)' }}>{fmtRelative(r.lastActiveAt, locale)}</span>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="search" style={{ width: 260 }}>
          <IconSearch size={14} />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t('users.search')}
            style={{
              background: 'transparent',
              border: 0,
              outline: 'none',
              color: 'var(--text)',
              fontFamily: 'var(--sans)',
              fontSize: '12.5px',
              width: '100%',
            }}
          />
        </div>
        {(['all', 'free', 'premium', 'premium_plus'] as const).map((tier) => (
          <Chip
            key={tier}
            selected={tierFilter === tier}
            onClick={() => {
              setTierFilter(tier);
              setPage(1);
            }}
          >
            {tier === 'all'
              ? t('users.filter.all')
              : tier === 'premium_plus'
                ? t('users.filter.premiumPlus')
                : tier === 'premium'
                  ? t('users.filter.premium')
                  : t('users.filter.free')}
          </Chip>
        ))}
        <Btn
          as="a"
          href={adminCsvUrl('users', params)}
          variant="default"
          icon={<IconUpload size={15} />}
          className="ml-auto"
        >
          {t('export.csv')}
        </Btn>
      </div>

      <DataTable
        columns={columns}
        rows={q.data?.rows ?? []}
        rowKey={(r) => r.userId}
        loading={q.isLoading}
        error={q.isError}
        onRowClick={(r) => router.push(`/admin/users/${encodeURIComponent(r.userId)}`)}
        rowDanger={(r) => r.profitable === false}
        sort={sort}
        onSortChange={setSort}
        page={page}
        pageSize={pageSize}
        total={q.data?.total ?? 0}
        onPageChange={setPage}
        paginationLabel={(from, to, total) => t('users.pagination', { from, to, total })}
        prevLabel={t('pager.prev')}
        nextLabel={t('pager.next')}
        emptyMessage={t('users.empty', { query: debounced || '—' })}
        errorTitle={t('error.title')}
        errorBody={t('error.body')}
        retryLabel={t('error.retry')}
        onRetry={() => void q.refetch()}
        loadingLabel={t('loading')}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sessions tab
// ─────────────────────────────────────────────────────────────────────

function SessionsTab({
  range,
  locale,
}: {
  range: { from: string; to: string; tz: string };
  locale: string;
}) {
  const t = useTranslations('admin');
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'in_progress' | 'failed' | 'billed'>('all');
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const params = {
    ...range,
    status: statusFilter === 'all' ? undefined : statusFilter,
    page,
    pageSize,
  };
  const q = useAdminSessions(params);

  const money = (v: number | undefined) => fmtCurrency(v ?? 0, locale);

  type Row = import('../../../lib/api/admin').AdminSessionRow;
  const columns: Column<Row>[] = [
    {
      key: 'createdAt',
      header: t('sessions.col.date'),
      render: (r) => <span style={{ color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 12 }}>{fmtSessionDate(r.createdAt, locale)}</span>,
    },
    { key: 'user', header: t('sessions.col.user'), render: (r) => r.email ?? r.userId.slice(0, 8) },
    { key: 'role', header: t('sessions.col.role'), render: (r) => r.role ?? '—' },
    { key: 'duration', header: t('sessions.col.duration'), align: 'right', render: (r) => fmtDur(r.durationSec) },
    { key: 'blueprint', header: t('sessions.col.blueprint'), align: 'right', render: (r) => money(r.cost.blueprint) },
    { key: 'liveLlm', header: t('sessions.col.liveLlm'), align: 'right', render: (r) => money(r.cost.liveLlm) },
    {
      key: 'stt',
      header: <span>{t('sessions.col.stt')}~</span>,
      align: 'right',
      render: (r) => money(r.cost.stt),
    },
    {
      key: 'tts',
      header: <span>{t('sessions.col.tts')}~</span>,
      align: 'right',
      render: (r) => money(r.cost.tts),
    },
    { key: 'eval', header: t('sessions.col.eval'), align: 'right', render: (r) => money(r.cost.evaluation) },
    { key: 'coach', header: t('sessions.col.coach'), align: 'right', render: (r) => money(r.cost.coach) },
    {
      key: 'total',
      header: t('sessions.col.total'),
      align: 'right',
      render: (r) => (
        <span style={{ color: 'var(--text)', fontWeight: 600 }}>{fmtCurrency(r.costUsd, locale)}</span>
      ),
    },
    { key: 'status', header: t('sessions.col.status'), render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {(['all', 'completed', 'in_progress', 'failed', 'billed'] as const).map((s) => (
          <Chip
            key={s}
            selected={statusFilter === s}
            onClick={() => {
              setStatusFilter(s);
              setPage(1);
            }}
          >
            {sessionStatusChipLabel(s, t)}
          </Chip>
        ))}
        <Btn as="a" href={adminCsvUrl('sessions', params)} variant="default" icon={<IconUpload size={15} />} className="ml-auto">
          {t('export.csv')}
        </Btn>
      </div>

      <DataTable
        columns={columns}
        rows={q.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.isError}
        onRowClick={(r) => router.push(`/admin/sessions/${encodeURIComponent(r.id)}`)}
        page={page}
        pageSize={pageSize}
        total={q.data?.total ?? 0}
        onPageChange={setPage}
        paginationLabel={(from, to, total) => t('users.pagination', { from, to, total })}
        prevLabel={t('pager.prev')}
        nextLabel={t('pager.next')}
        emptyMessage={t('sessions.empty')}
        errorTitle={t('error.title')}
        errorBody={t('error.body')}
        retryLabel={t('error.retry')}
        onRetry={() => void q.refetch()}
        loadingLabel={t('loading')}
      />
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted-2)', marginTop: 6 }}>
        ⌁ {t('estimatedNote')}
      </div>
    </div>
  );
}

// Helpers shared by the Sessions tab (kept local to avoid extra imports).
function sessionStatusChipLabel(
  s: 'all' | 'completed' | 'in_progress' | 'failed' | 'billed',
  t: ReturnType<typeof useTranslations>,
): string {
  switch (s) {
    case 'all':
      return t('users.filter.all');
    case 'completed':
      return t('sessions.status.completed');
    case 'in_progress':
      return t('sessions.status.inProgress');
    case 'failed':
      return t('sessions.status.failed');
    case 'billed':
      return t('sessions.status.billed');
  }
}
function fmtSessionDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}
function fmtDur(sec: number | null): string {
  if (sec === null || sec === undefined) return '—';
  const m = Math.round(sec / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ─────────────────────────────────────────────────────────────────────
// Rate card tab
// ─────────────────────────────────────────────────────────────────────

function RateCardTab({ locale }: { locale: string }) {
  const t = useTranslations('admin');
  const q = useAdminRateCard();

  if (q.isError) {
    return <RetryPanel onRetry={() => void q.refetch()} />;
  }
  if (q.isLoading) {
    return <div style={{ height: 300, borderRadius: 14, background: 'var(--surface-2)' }} className="animate-pulse" aria-busy="true" aria-label={t('loading')} />;
  }
  const data = q.data!;
  return <RateCardPanel card={data.card} source={data.source} locale={locale} />;
}

// ─────────────────────────────────────────────────────────────────────
// Shared retry panel
// ─────────────────────────────────────────────────────────────────────

function RetryPanel({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('admin');
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-4 text-center"
      style={{ border: '1px solid var(--rule)', background: 'var(--surface)', borderRadius: 'var(--r-xl)', padding: '52px 32px' }}
    >
      <p style={{ fontFamily: 'var(--sans)', fontSize: 18, fontWeight: 600, color: 'var(--text)', margin: 0 }}>
        {t('error.title')}
      </p>
      <p style={{ color: 'var(--text-2)', fontSize: 14, maxWidth: 420, margin: 0 }}>{t('error.body')}</p>
      <Btn variant="primary" onClick={onRetry} icon={<IconClock size={14} />}>
        {t('error.retry')}
      </Btn>
    </div>
  );
}
