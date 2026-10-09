'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAdminSessions, useAdminRateCard } from '../../../hooks/useAdmin';
import { adminCsvUrl } from '../../../lib/api/admin';
import { Btn } from '../primitives/Btn';
import { Chip } from '../primitives/Chip';
import { IconUpload, IconClock } from '../primitives/Iconset';
import { DataTable, StatusBadge, RateCardPanel, type Column, fmtCurrency } from './index';
export function SessionsTab({
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
      render: (r) => <span style={{ color: 'var(--text-2)', fontSize: 'var(--fs-label)', fontVariantNumeric: 'tabular-nums' }}>{fmtSessionDate(r.createdAt, locale)}</span>,
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
      <div style={{ fontSize: 'var(--fs-label)', color: 'var(--disabled)', marginTop: 6 }}>
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

export function RateCardTab({ locale }: { locale: string }) {
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
      style={{ border: '1px solid var(--rule)', background: 'var(--surface)', borderRadius: 'var(--r-lg)', padding: '52px 32px' }}
    >
      <p style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-subtitle)', fontWeight: 600, color: 'var(--text)', margin: 0 }}>
        {t('error.title')}
      </p>
      <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-body)', maxWidth: 420, margin: 0 }}>{t('error.body')}</p>
      <Btn variant="primary" onClick={onRetry} icon={<IconClock size={14} />}>
        {t('error.retry')}
      </Btn>
    </div>
  );
}
