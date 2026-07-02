'use client';

// components/v3/admin/controls.tsx
//
// Header / navigation controls for the admin console:
//   - DateRangePicker  segmented Today / 7d / 30d / Custom (+ a custom Modal)
//   - TabRail          horizontal segmented tab control (mono labels)
//   - KpiStrip         the 6-up StatStrip extension for the overview KPI row
//
// The DateRangePicker resolves a preset to an explicit {from, to} ISO range so
// every downstream query carries concrete dates (the spine of the whole page).

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '../primitives/Modal';
import { Btn } from '../primitives/Btn';

export type RangePreset = 'today' | '7d' | '30d' | 'custom';

export interface RangeValue {
  preset: RangePreset;
  from?: string; // ISO date (YYYY-MM-DD)
  to?: string; // ISO date
}

/** Resolve a preset/value into concrete {from, to} ISO date strings + tz. */
export function resolveRange(value: RangeValue): { from: string; to: string; tz: string } {
  const tz =
    typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      : 'UTC';
  const now = new Date();
  const toISODate = (d: Date) => d.toISOString().slice(0, 10);
  const to = toISODate(now);
  if (value.preset === 'custom' && value.from && value.to) {
    return { from: value.from, to: value.to, tz };
  }
  const days = value.preset === 'today' ? 0 : value.preset === '7d' ? 6 : 29;
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - days);
  return { from: toISODate(fromDate), to, tz };
}

export function DateRangePicker({
  value,
  onChange,
}: {
  value: RangeValue;
  onChange: (v: RangeValue) => void;
}) {
  const t = useTranslations('admin');
  const [customOpen, setCustomOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(value.from ?? '');
  const [draftTo, setDraftTo] = useState(value.to ?? '');

  const presets: { id: RangePreset; label: string }[] = [
    { id: 'today', label: t('range.today') },
    { id: '7d', label: t('range.7d') },
    { id: '30d', label: t('range.30d') },
    { id: 'custom', label: t('range.custom') },
  ];

  function pick(id: RangePreset) {
    if (id === 'custom') {
      setDraftFrom(value.from ?? '');
      setDraftTo(value.to ?? '');
      setCustomOpen(true);
      return;
    }
    onChange({ preset: id });
  }

  return (
    <>
      <div
        style={{
          display: 'inline-flex',
          background: 'var(--surface)',
          border: '1px solid var(--rule)',
          borderRadius: 9,
          padding: 3,
          gap: 2,
        }}
      >
        {presets.map((p) => {
          const on = value.preset === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => pick(p.id)}
              aria-pressed={on}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: '11.5px',
                fontWeight: 600,
                letterSpacing: '0.02em',
                textTransform: 'uppercase',
                border: 0,
                padding: '6px 12px',
                borderRadius: 7,
                cursor: 'pointer',
                background: on ? 'var(--accent)' : 'transparent',
                color: on ? 'var(--accent-ink)' : 'var(--muted)',
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <Modal
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        title={t('range.customTitle')}
        maxWidth="sm"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setCustomOpen(false)}>
              {t('setPlan.cancel')}
            </Btn>
            <Btn
              variant="primary"
              onClick={() => {
                if (draftFrom && draftTo) {
                  onChange({ preset: 'custom', from: draftFrom, to: draftTo });
                  setCustomOpen(false);
                }
              }}
            >
              {t('range.apply')}
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={FIELD_LABEL}>
            {t('range.from')}
            <input
              type="date"
              value={draftFrom}
              max={draftTo || undefined}
              onChange={(e) => setDraftFrom(e.target.value)}
              style={DATE_INPUT}
            />
          </label>
          <label style={FIELD_LABEL}>
            {t('range.to')}
            <input
              type="date"
              value={draftTo}
              min={draftFrom || undefined}
              onChange={(e) => setDraftTo(e.target.value)}
              style={DATE_INPUT}
            />
          </label>
        </div>
      </Modal>
    </>
  );
}

const FIELD_LABEL = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 6,
  fontFamily: 'var(--mono)',
  fontSize: '11px',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.1em',
  color: 'var(--muted)',
  fontWeight: 600,
};

const DATE_INPUT = {
  background: 'var(--bg-2)',
  border: '1px solid var(--rule)',
  borderRadius: 9,
  padding: '9px 12px',
  color: 'var(--text)',
  fontFamily: 'var(--sans)',
  fontSize: '14px',
  colorScheme: 'dark' as const,
};

// ── TabRail ─────────────────────────────────────────────────────────────────

export function TabRail<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        gap: 4,
        borderBottom: '1px solid var(--rule)',
        marginBottom: 28,
        overflowX: 'auto',
      }}
    >
      {tabs.map((tab) => {
        const on = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(tab.id)}
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '12px',
              fontWeight: 600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: on ? 'var(--text)' : 'var(--muted)',
              background: 'transparent',
              border: 0,
              padding: '12px 16px',
              cursor: 'pointer',
              position: 'relative',
              whiteSpace: 'nowrap',
              boxShadow: on ? 'inset 0 -2px 0 var(--accent)' : 'none',
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ── KpiStrip ──────────────────────────────────────────────────────────────
//
// A 6-up grid extension of StatStrip. Each cell renders a mono caption, big
// value, and an optional delta. `tone` colors the value + a top-rule (only
// used for the Gross Margin cell, per the profitability rule).

export type KpiTone = 'pos' | 'warn' | 'neg';

export interface KpiCell {
  label: string;
  value: ReactNode;
  /** Optional small unit suffix de-emphasized one step (e.g. "%"). */
  delta?: ReactNode;
  deltaDown?: boolean;
  hero?: boolean;
  tone?: KpiTone;
}

export function KpiStrip({ kpis, loading }: { kpis: KpiCell[]; loading?: boolean }) {
  if (loading) {
    return (
      <div style={KPI_GRID} className="animate-pulse" aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ ...STAT_BASE }}>
            <div style={{ background: 'var(--surface-2)', height: 10, width: '60%', borderRadius: 4, marginBottom: 12 }} />
            <div style={{ background: 'var(--surface-2)', height: 26, width: '70%', borderRadius: 6 }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={KPI_GRID}>
      {kpis.map((k, i) => {
        const toneColor =
          k.tone === 'pos' ? 'var(--ok)' : k.tone === 'warn' ? 'var(--warn)' : k.tone === 'neg' ? 'var(--danger)' : undefined;
        const heroStyle = k.hero
          ? {
              background: 'var(--grad-brand)',
              borderColor: 'var(--accent-text)',
              boxShadow: '0 6px 26px -10px var(--accent-glow)',
            }
          : {};
        const topRule = toneColor ? { borderTop: `2px solid ${toneColor}` } : {};
        return (
          <div key={k.label + i} style={{ ...STAT_BASE, ...heroStyle, ...topRule }}>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: '9.5px',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                color: k.hero ? 'var(--accent-ink)' : 'var(--muted)',
                marginBottom: 9,
                fontWeight: 600,
              }}
            >
              {k.label}
            </div>
            <div
              className="robo-tnum"
              style={{
                fontSize: 27,
                lineHeight: 1,
                letterSpacing: '-0.03em',
                fontWeight: 600,
                color: k.hero ? 'var(--accent-ink)' : toneColor ?? 'var(--text)',
                display: 'flex',
                alignItems: 'baseline',
                gap: 6,
              }}
            >
              {k.value}
            </div>
            {k.delta ? (
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: '10.5px',
                  fontWeight: 500,
                  letterSpacing: 0,
                  marginTop: 8,
                  display: 'block',
                  color: k.hero
                    ? 'var(--accent-ink)'
                    : k.deltaDown
                      ? 'var(--danger)'
                      : 'var(--ok)',
                  opacity: k.hero ? 0.78 : 1,
                }}
              >
                {k.delta}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const KPI_GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: 12,
  marginBottom: 24,
};

const STAT_BASE = {
  border: '1px solid var(--rule)',
  background: 'var(--surface)',
  borderRadius: 14,
  padding: 16,
  position: 'relative' as const,
  overflow: 'hidden' as const,
};

/** A de-emphasized unit suffix span (the "$" / "%" one step down). */
export function Unit({ children }: { children: ReactNode }) {
  return <span style={{ fontSize: 15, color: 'var(--muted)', fontWeight: 500 }}>{children}</span>;
}
