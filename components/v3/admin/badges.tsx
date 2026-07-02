'use client';

// components/v3/admin/badges.tsx
//
// The small signal primitives for the admin console:
//   - TierBadge       free | premium | premium_plus pill
//   - StatusBadge     completed | in_progress | failed | billed (Tag-tone pill)
//   - EstimatedMarker the "~" + dotted-underline "modeled cost" affordance
//   - MarginBadge     the profitability cell — sign-prefixed mono number +
//                     a thin vertical magnitude tick, green/red
//   - MarginBar       the drill-down hero stacked revenue/cost/margin bar
//
// Margin uses a DEDICATED green/red pair (--ok / --danger) used nowhere else
// in the app, so it reads instantly and never competes with the lime accent.
// Color is never the ONLY signal — the +/− sign carries polarity too.

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { fmtSignedCurrency, fmtCurrency } from './format';

// ── TierBadge ───────────────────────────────────────────────────────────

const TIER_STYLE: Record<
  string,
  { bg: string; color: string; border: string }
> = {
  free: { bg: 'var(--surface-2)', color: 'var(--text-2)', border: 'var(--rule)' },
  premium: { bg: 'var(--accent-soft)', color: 'var(--accent-text)', border: 'var(--accent-text)' },
  premium_plus: { bg: 'var(--violet-soft)', color: 'var(--violet)', border: 'var(--violet)' },
};

function normalizeTier(tier: string): 'free' | 'premium' | 'premium_plus' {
  if (tier === 'premium' || tier === 'premium_plus') return tier;
  return 'free';
}

export function TierBadge({
  tier,
  size = 'md',
}: {
  tier: string;
  size?: 'sm' | 'md';
}) {
  const t = useTranslations('admin');
  const key = normalizeTier(tier);
  const s = TIER_STYLE[key];
  const label =
    key === 'premium_plus'
      ? t('users.filter.premiumPlus')
      : key === 'premium'
        ? t('users.filter.premium')
        : t('users.filter.free');
  return (
    <span
      style={{
        fontFamily: 'var(--mono)',
        fontSize: size === 'sm' ? '9.5px' : '10px',
        fontWeight: 600,
        padding: size === 'sm' ? '2px 8px' : '3px 9px',
        borderRadius: '99px',
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
        background: s.bg,
        color: s.color,
        border: `1px solid ${s.border}`,
        whiteSpace: 'nowrap',
        display: 'inline-block',
      }}
    >
      {label}
    </span>
  );
}

// ── StatusBadge ─────────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  completed: { bg: 'var(--ok-soft)', color: 'var(--ok)' },
  billed: { bg: 'var(--accent-soft)', color: 'var(--accent-text)' },
  in_progress: { bg: 'var(--violet-soft)', color: 'var(--violet)' },
  failed: { bg: 'var(--danger-soft)', color: 'var(--danger)' },
};

function statusI18nKey(status: string): string {
  switch (status) {
    case 'completed':
      return 'sessions.status.completed';
    case 'billed':
      return 'sessions.status.billed';
    case 'in_progress':
    case 'in-progress':
    case 'inProgress':
      return 'sessions.status.inProgress';
    case 'failed':
      return 'sessions.status.failed';
    default:
      return 'sessions.status.completed';
  }
}

export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('admin');
  const norm =
    status === 'in-progress' || status === 'inProgress' ? 'in_progress' : status;
  const s = STATUS_STYLE[norm] ?? {
    bg: 'var(--surface-2)',
    color: 'var(--text-2)',
  };
  return (
    <span
      style={{
        fontFamily: 'var(--mono)',
        fontSize: '10px',
        fontWeight: 600,
        padding: '3px 9px',
        borderRadius: '99px',
        textTransform: 'uppercase',
        background: s.bg,
        color: s.color,
        whiteSpace: 'nowrap',
        display: 'inline-block',
      }}
    >
      {t(statusI18nKey(norm))}
    </span>
  );
}

// ── EstimatedMarker ───────────────────────────────────────────────────────

export function EstimatedMarker({
  children,
  note,
}: {
  children?: ReactNode;
  note?: string;
}) {
  const t = useTranslations('admin');
  return (
    <span
      title={note ?? t('estimatedNote')}
      style={{
        color: 'var(--muted)',
        borderBottom: '1px dotted var(--muted-2)',
        cursor: 'help',
        fontFamily: 'var(--mono)',
        fontSize: '10px',
      }}
    >
      {children ?? `~ ${t('estimated')}`}
    </span>
  );
}

// ── MarginBadge ───────────────────────────────────────────────────────────
//
// Renders the profitability cell. `amount` is the margin in dollars; `revenue`
// scales the magnitude tick (tick height ∝ |margin| / revenue). For free-tier
// users (revenue 0) we still show the cost-driven negative margin with a small
// tick. When `profitable` is explicitly null (no data), render an n/a dash.

export function MarginBadge({
  amount,
  revenue,
  currency = 'USD',
  locale,
  profitable,
}: {
  amount: number;
  revenue: number;
  currency?: string;
  locale: string;
  profitable?: boolean | null;
}) {
  if (profitable === null && amount === 0) {
    return (
      <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>—</span>
    );
  }
  const pos = amount >= 0;
  // Magnitude tick: scale |margin| against revenue (fallback to |margin| itself
  // when revenue is 0, capped) to a 4..22px height.
  const base = revenue > 0 ? Math.abs(amount) / revenue : Math.min(1, Math.abs(amount) / 20);
  const tickH = Math.max(4, Math.min(22, Math.round(base * 22)));
  const color = pos ? 'var(--ok)' : 'var(--danger)';
  const glow = pos ? 'var(--ok-soft)' : 'var(--danger-soft)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        justifyContent: 'flex-end',
        fontFamily: 'var(--mono)',
        fontVariantNumeric: 'tabular-nums',
        fontWeight: 600,
        fontSize: 13,
        color,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 3,
          height: tickH,
          borderRadius: 2,
          display: 'inline-block',
          background: color,
          boxShadow: `0 0 6px ${glow}`,
        }}
      />
      {fmtSignedCurrency(amount, locale, currency)}
    </span>
  );
}

// ── MarginBar ─────────────────────────────────────────────────────────────
//
// Full-width stacked bar for the drill-down hero. Revenue is the track; cost is
// overlaid in accent-soft and the margin remainder in green. When the user is
// underwater (cost > revenue) the cost segment fills the whole bar and a red
// "underwater" overflow segment is appended past the revenue line.

export function MarginBar({
  revenue,
  cost,
  currency = 'USD',
  locale,
}: {
  revenue: number;
  cost: number;
  currency?: string;
  locale: string;
}) {
  const t = useTranslations('admin');
  const margin = revenue - cost;
  const underwater = cost > revenue;
  // When solvent: scale against revenue. When underwater: scale against cost so
  // the red overflow is visible.
  const denom = Math.max(1e-6, underwater ? cost : revenue || cost || 1);
  const costPct = Math.min(100, (Math.min(cost, denom) / denom) * 100);
  const marginPct = underwater ? 0 : Math.max(0, 100 - costPct);
  const overflowPct = underwater ? Math.min(100, ((cost - revenue) / denom) * 100) : 0;

  return (
    <div>
      <div
        role="img"
        aria-label={`${t('detail.lifetimeRevenue')} ${fmtCurrency(
          revenue,
          locale,
          currency,
        )}, cost ${fmtCurrency(cost, locale, currency)}`}
        style={{
          height: 14,
          borderRadius: 99,
          background: 'var(--surface-2)',
          overflow: 'hidden',
          display: 'flex',
          marginTop: 18,
          maxWidth: 520,
          border: '1px solid var(--rule)',
        }}
      >
        <span
          style={{
            width: `${costPct}%`,
            background: 'var(--accent-soft)',
            borderRight: '1px solid var(--accent)',
          }}
        />
        {marginPct > 0 ? (
          <span
            style={{
              width: `${marginPct}%`,
              background: 'linear-gradient(90deg, var(--ok-soft), var(--ok))',
            }}
          />
        ) : null}
        {overflowPct > 0 ? (
          <span
            style={{
              width: `${overflowPct}%`,
              background: 'var(--danger)',
            }}
          />
        ) : null}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 18,
          marginTop: 10,
          fontFamily: 'var(--mono)',
          fontSize: '10.5px',
          color: 'var(--muted)',
          flexWrap: 'wrap',
        }}
      >
        <LegendDot color="var(--accent-soft)" label={`${t('detail.periodCost')} ${fmtCurrency(cost, locale, currency)}`} />
        <LegendDot
          color={underwater ? 'var(--danger)' : 'var(--ok)'}
          label={`${t('users.col.margin')} ${fmtSignedCurrency(margin, locale, currency)}`}
        />
        <LegendDot color="var(--surface-2)" label={`${t('detail.lifetimeRevenue')} ${fmtCurrency(revenue, locale, currency)}`} />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span>
      <i
        style={{
          display: 'inline-block',
          width: 9,
          height: 9,
          borderRadius: 2,
          marginRight: 6,
          verticalAlign: -1,
          background: color,
        }}
      />
      {label}
    </span>
  );
}
