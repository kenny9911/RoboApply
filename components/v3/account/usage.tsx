'use client';

// components/v3/account/usage.tsx
//
// Usage section — framed as VALUE, never cost. Three pieces:
//   - ActivityHeatmap   GitHub-style CSS grid of day cells (by-date) tinted by
//                       intensity. Zero-dep (recommended by the design).
//   - UsageMeter        one row per feature: label + "X of Y used today" + a
//                       CSS allowance bar (amber ≥80%, never blocks).
//   - RecentActivityList small recent-actions list (reuses the .log timeline).
//
// Counts only. No $/margin anywhere on this surface.

import { useTranslations, useLocale } from 'next-intl';
import { CapLabel, Panel } from './sections';
import { TierBadge } from './billing';
import type {
  AccountTier,
  AccountUsageDay,
  AccountUsageFeature,
} from '../../../lib/api/account';

// ─────────────────────────────────────────────────────────────────────
// ActivityHeatmap — pure CSS grid. Intensity = quartile of the max count.
// ─────────────────────────────────────────────────────────────────────

function intensityLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

const HEAT_BG: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'var(--surface-2)',
  1: 'var(--accent-soft)',
  2: 'rgba(201,255,59,.32)',
  3: 'rgba(201,255,59,.6)',
  4: 'var(--accent-text)',
};

export function ActivityHeatmap({
  days,
  totalActions,
}: {
  days: AccountUsageDay[];
  totalActions: number;
}) {
  const t = useTranslations('account');
  const locale = useLocale();
  const max = days.reduce((m, d) => Math.max(m, d.count), 0);
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const numberFmt = new Intl.NumberFormat(locale);

  return (
    <Panel>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <CapLabel>{t('usage.byDate')}</CapLabel>
        <CapLabel style={{ color: 'var(--text-2)' }}>
          {t('usage.actionCount', { count: numberFmt.format(totalActions) })}
        </CapLabel>
      </div>

      <div
        role="img"
        aria-label={t('usage.actionCount', { count: numberFmt.format(totalActions) })}
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(Math.max(days.length, 1), 15)}, 1fr)`,
          gap: 5,
        }}
      >
        {days.map((d) => {
          const lvl = intensityLevel(d.count, max);
          const dt = new Date(d.day);
          const label = Number.isNaN(dt.getTime()) ? d.day : dateFmt.format(dt);
          return (
            <span
              key={d.day}
              title={`${label} · ${numberFmt.format(d.count)}`}
              style={{
                aspectRatio: '1 / 1',
                borderRadius: 3,
                background: HEAT_BG[lvl],
              }}
            />
          );
        })}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          justifyContent: 'flex-end',
          marginTop: 14,
          fontFamily: 'var(--mono)',
          fontSize: '10px',
          color: 'var(--muted)',
        }}
      >
        {t('usage.heatLess')}
        {([0, 1, 2, 3, 4] as const).map((lvl) => (
          <i
            key={lvl}
            aria-hidden="true"
            style={{
              width: 11,
              height: 11,
              borderRadius: 3,
              display: 'inline-block',
              background: HEAT_BG[lvl],
            }}
          />
        ))}
        {t('usage.heatMore')}
      </div>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────
// UsageMeter — feature allowance rows. Never blocks; bar turns amber ≥80%.
// ─────────────────────────────────────────────────────────────────────

function UsageMeterRow({
  feature,
  cap,
}: {
  feature: AccountUsageFeature;
  cap: number;
}) {
  const t = useTranslations('account');
  const locale = useLocale();
  const numberFmt = new Intl.NumberFormat(locale);
  const safeCap = cap > 0 ? cap : Math.max(feature.count, 1);
  const pct = Math.min(100, Math.round((feature.count / safeCap) * 100));
  const warn = pct >= 80;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 7,
        }}
      >
        <span style={{ fontSize: '13px', color: 'var(--text)' }}>{feature.label}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--text-2)' }}>
          {t('usage.meter', {
            used: numberFmt.format(feature.count),
            cap: numberFmt.format(safeCap),
          })}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={feature.count}
        aria-valuemin={0}
        aria-valuemax={safeCap}
        aria-label={feature.label}
        style={{
          height: 8,
          background: 'var(--surface-2)',
          borderRadius: '99px',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${pct}%`,
            background: warn ? 'var(--warn)' : 'var(--accent)',
            borderRadius: '99px',
          }}
        />
      </div>
    </div>
  );
}

export function UsageMeter({
  features,
  cap,
  tier,
  tierLabelText,
}: {
  features: AccountUsageFeature[];
  cap: number;
  tier: AccountTier;
  tierLabelText: string;
}) {
  const t = useTranslations('account');
  const locale = useLocale();
  const numberFmt = new Intl.NumberFormat(locale);

  return (
    <Panel>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <CapLabel>{t('usage.byFeature')}</CapLabel>
        <TierBadge tier={tier}>
          {t('usage.tierCap', { tier: tierLabelText, cap: numberFmt.format(cap) })}
        </TierBadge>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {features.map((f) => (
          <UsageMeterRow key={f.key} feature={f} cap={cap} />
        ))}
      </div>

      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: '11px',
          color: 'var(--muted)',
          marginTop: 16,
          paddingTop: 14,
          borderTop: '1px solid var(--rule)',
        }}
      >
        {t('usage.resetNote', {
          tier: tierLabelText,
          cap: numberFmt.format(cap),
        })}
      </div>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────
// RecentActivityList — reuse the .log timeline. Items derive from the most
// active recent days (the usage contract has no per-action feed, so we frame
// the by-feature counts positively as the last things the agent did).
// ─────────────────────────────────────────────────────────────────────

export interface RecentActivityItem {
  id: string;
  time: string;
  body: React.ReactNode;
}

export function RecentActivityList({ items }: { items: RecentActivityItem[] }) {
  const t = useTranslations('account');
  return (
    <Panel style={{ marginTop: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <CapLabel>{t('usage.recent')}</CapLabel>
      </div>
      <div className="log">
        {items.map((it) => (
          <div className="log-entry action" key={it.id}>
            <div className="log-time">{it.time}</div>
            <div className="log-content">{it.body}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
