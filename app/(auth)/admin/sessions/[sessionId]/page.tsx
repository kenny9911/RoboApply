'use client';

// /admin/sessions/[sessionId] — single mock-interview session cost ledger
// (admin-only). The CostBreakdownPanel: a header (role · user · date ·
// duration · status), a stacked cost bar over the six stages, and a per-stage
// ledger table. Modeled rows (STT/TTS/egress) carry the estimated marker.
//
// Renders inner content only; /admin/* is ResumeGate-exempt.

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { useAuth } from '../../../../../lib/auth/useAuth';
import { useAdminSession } from '../../../../../hooks/useAdmin';
import { PageHeader } from '../../../../../components/v3/primitives/PageHeader';
import { EmptyState } from '../../../../../components/v3/primitives/EmptyState';
import { Btn } from '../../../../../components/v3/primitives/Btn';
import { IconArrow } from '../../../../../components/v3/primitives/Iconset';
import {
  ChartCard,
  CostBreakdownBar,
  StatusBadge,
  type BreakdownItem,
  fmtCurrency,
  fmtPercent,
  fmtCompact,
  fmtLongDate,
} from '../../../../../components/v3/admin';

const STAGE_COLORS: Record<string, string> = {
  blueprint: 'var(--pink)',
  liveLlm: 'var(--cyan)',
  stt: 'var(--ok)',
  tts: 'var(--warn)',
  evaluation: 'var(--violet)',
  coach: 'var(--accent-text)',
  recording: 'var(--muted)',
};
const STAGE_ESTIMATED = new Set(['stt', 'tts', 'recording']);
const STAGE_ORDER = ['blueprint', 'liveLlm', 'stt', 'tts', 'evaluation', 'coach', 'recording'];

export default function AdminSessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const t = useTranslations('admin');
  const locale = useLocale();
  const router = useRouter();
  const { sessionId } = use(params);

  const { user, status } = useAuth();
  const isAdmin = !!user && user.role === 'admin';
  const q = useAdminSession(isAdmin ? sessionId : null);

  if (status === 'loading') return <div style={{ height: 200 }} />;
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
      eyebrow={t('session.eyebrow')}
      title={t('session.title')}
      actions={
        <Btn variant="ghost" icon={<IconArrow size={15} style={{ transform: 'rotate(180deg)' }} />} onClick={() => router.back()}>
          {t('detail.back')}
        </Btn>
      }
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
        <div className="animate-pulse" aria-busy="true" aria-label={t('loading')} style={{ height: 240, borderRadius: 14, background: 'var(--surface-2)' }} />
      </>
    );
  }

  const s = q.data;
  const cb = s.costBreakdown ?? {};
  const total = s.costUsd || 0;

  const stageItems: BreakdownItem[] = STAGE_ORDER.filter(
    (k) => typeof cb[k] === 'number' && (cb[k] as number) > 0,
  ).map((k) => {
    const v = cb[k] as number;
    return {
      label: stageLabel(k, t),
      value: v,
      color: STAGE_COLORS[k] ?? 'var(--accent-text)',
      estimated: STAGE_ESTIMATED.has(k),
      valueText: fmtCurrency(v, locale),
      pctText: fmtPercent(total > 0 ? (v / total) * 100 : 0, locale),
    };
  });

  return (
    <>
      {header}

      <div
        style={{
          border: '1px solid var(--rule)',
          background: 'var(--surface)',
          borderRadius: 14,
          padding: 20,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.02em' }}>
            {s.role ?? '—'}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            {s.user.email ?? s.userId.slice(0, 8)} · {fmtLongDate(s.createdAt, locale)} · {durLabel(s.durationSec)}
          </div>
        </div>
        <StatusBadge status={s.status} />
      </div>

      <ChartCard caption={t('session.title')} aside={fmtCurrency(total, locale)}>
        {stageItems.length > 0 ? (
          <CostBreakdownBar items={stageItems} variant="stacked" />
        ) : (
          <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>—</p>
        )}
      </ChartCard>

      <div style={{ marginTop: 18 }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            border: '1px solid var(--rule)',
            borderRadius: 14,
            overflow: 'hidden',
            background: 'var(--surface)',
          }}
        >
          <thead>
            <tr>
              {[t('session.col.stage'), t('session.col.usage'), t('session.col.cost')].map((h, i) => (
                <th
                  key={h}
                  scope="col"
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--muted)',
                    fontWeight: 600,
                    textAlign: i === 0 ? 'left' : 'right',
                    padding: '13px 16px',
                    borderBottom: '1px solid var(--rule)',
                    background: 'var(--bg-2)',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stageItems.map((it) => (
              <tr key={it.label}>
                <td style={LEDGER_TD}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 3, background: it.color }} />
                    {it.label}
                  </span>
                </td>
                <td style={{ ...LEDGER_TD, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                  {it.estimated ? `~ ${it.pctText}` : it.pctText}
                </td>
                <td style={{ ...LEDGER_TD, textAlign: 'right', fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums' }}>
                  {it.valueText}
                </td>
              </tr>
            ))}
            <tr>
              <td style={{ ...LEDGER_TD, borderTop: '1px solid var(--rule)', fontWeight: 600 }}>{t('sessions.col.total')}</td>
              <td style={{ ...LEDGER_TD, borderTop: '1px solid var(--rule)' }} />
              <td
                style={{
                  ...LEDGER_TD,
                  borderTop: '1px solid var(--rule)',
                  textAlign: 'right',
                  fontFamily: 'var(--mono)',
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: 600,
                }}
              >
                {fmtCurrency(total, locale)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {s.totalTokens ? (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', marginTop: 12 }}>
          {fmtCompact(s.totalTokens, locale)} tok · {s.language ?? '—'} · {s.mode ?? '—'}
        </div>
      ) : null}
    </>
  );
}

const LEDGER_TD = {
  padding: '13px 16px',
  borderBottom: '1px solid var(--rule-soft)',
  fontSize: 13,
  color: 'var(--text)',
} as const;

function stageLabel(key: string, t: ReturnType<typeof useTranslations>): string {
  switch (key) {
    case 'blueprint':
      return t('session.stage.blueprint');
    case 'liveLlm':
      return t('session.stage.liveLlm');
    case 'stt':
      return t('session.stage.stt');
    case 'tts':
      return t('session.stage.tts');
    case 'evaluation':
      return t('session.stage.eval');
    case 'coach':
      return t('session.stage.coach');
    case 'recording':
      return t('modality.egress');
    default:
      return key;
  }
}

function durLabel(sec: number | null): string {
  if (sec === null || sec === undefined) return '—';
  const m = Math.round(sec / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
