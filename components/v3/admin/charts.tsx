'use client';

// components/v3/admin/charts.tsx
//
// PURE CSS / SVG charts for the admin console — no recharts, no chart deps.
// Each mirrors the "CSS-only fallback" column from ui-design.md §8:
//
//   - ChartCard          mono caption + legend + reserved-height body wrapper
//   - CostBreakdownBar   horizontal bar list ('rows') OR stacked single bar
//   - CostRevenueArea    SVG area (cost) + line (revenue) over date buckets
//   - ColumnChart        CSS column chart for a time series
//   - Sparkline          inline SVG polyline/area (drill-down daily cost)
//   - ModalityDonut      SVG donut with a center total + legend
//
// Series colors come from the existing logo-color ramp / token set: accent
// (cost), violet (revenue), cyan / pink / warn for modality segments.

import type { CSSProperties, ReactNode } from 'react';
import { EstimatedMarker } from './badges';

// ── ChartCard ─────────────────────────────────────────────────────────────

export function ChartCard({
  caption,
  legend,
  aside,
  minHeight,
  children,
  ariaLabel,
}: {
  caption: string;
  legend?: ReactNode;
  /** Right-aligned secondary caption (e.g. "$1,284.50 total"). */
  aside?: ReactNode;
  minHeight?: number;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <section
      aria-label={ariaLabel ?? caption}
      style={{
        border: '1px solid var(--rule)',
        background: 'var(--surface)',
        borderRadius: 14,
        padding: 20,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <span style={CAP_STYLE}>{caption}</span>
        {legend ? <span>{legend}</span> : aside ? <span style={{ ...CAP_STYLE, color: 'var(--text-2)' }}>{aside}</span> : null}
      </header>
      <div style={minHeight ? { minHeight } : undefined}>{children}</div>
    </section>
  );
}

const CAP_STYLE: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  color: 'var(--muted)',
  fontWeight: 600,
};

export function ChartLegend({
  items,
}: {
  items: { color: string; label: string }[];
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        gap: 14,
        alignItems: 'center',
        fontFamily: 'var(--mono)',
        fontSize: '10.5px',
        color: 'var(--text-2)',
      }}
    >
      {items.map((it) => (
        <span key={it.label}>
          <i
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              borderRadius: 3,
              marginRight: 6,
              verticalAlign: -1,
              background: it.color,
            }}
          />
          {it.label}
        </span>
      ))}
    </span>
  );
}

// ── CostBreakdownBar ──────────────────────────────────────────────────────

export interface BreakdownItem {
  label: string;
  value: number;
  /** Pre-formatted "$X" string for the value. */
  valueText: string;
  /** Pre-formatted "%" string. */
  pctText: string;
  color?: string;
  estimated?: boolean;
  /** Optional pill (e.g. "top cost") rendered next to the label. */
  badge?: ReactNode;
}

export function CostBreakdownBar({
  items,
  variant = 'rows',
}: {
  items: BreakdownItem[];
  variant?: 'rows' | 'stacked';
}) {
  const total = items.reduce((s, it) => s + Math.max(0, it.value), 0) || 1;
  const max = items.reduce((m, it) => Math.max(m, it.value), 0) || 1;

  if (variant === 'stacked') {
    return (
      <div>
        <div
          style={{
            display: 'flex',
            height: 16,
            borderRadius: 99,
            overflow: 'hidden',
            border: '1px solid var(--rule)',
            background: 'var(--surface-2)',
          }}
        >
          {items.map((it, i) => {
            const pct = (Math.max(0, it.value) / total) * 100;
            if (pct <= 0) return null;
            return (
              <span
                key={it.label + i}
                title={`${it.label} · ${it.valueText}`}
                style={{ width: `${pct}%`, background: it.color ?? 'var(--accent)' }}
              />
            );
          })}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 16 }}>
          {items.map((it, i) => (
            <div
              key={it.label + i}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '12.5px',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--text-2)' }}>
                <span
                  aria-hidden="true"
                  style={{ width: 9, height: 9, borderRadius: 3, background: it.color ?? 'var(--accent)' }}
                />
                {it.label}
                {it.estimated ? <EstimatedMarker>~est</EstimatedMarker> : null}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: '11.5px', color: 'var(--text-2)' }}>
                <b style={{ color: 'var(--text)' }}>{it.valueText}</b> · {it.pctText}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 'rows'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {items.map((it, i) => (
        <div key={it.label + i} style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span
              style={{
                fontSize: '13px',
                color: 'var(--text)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {it.label}
              {it.estimated ? <EstimatedMarker>~est</EstimatedMarker> : null}
              {it.badge}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--text-2)' }}>
              <b style={{ color: 'var(--text)' }}>{it.valueText}</b> · {it.pctText}
            </span>
          </div>
          <div
            style={{
              height: 7,
              background: 'var(--surface-2)',
              borderRadius: 99,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.max(2, (it.value / max) * 100)}%`,
                background: it.color ?? 'var(--accent-soft)',
                borderRight: `2px solid ${it.color ? it.color : 'var(--accent-text)'}`,
                borderRadius: 99,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── CostRevenueArea ─────────────────────────────────────────────────────────
//
// SVG area (cost, accent gradient fill + accent stroke) + line (revenue,
// violet) over date buckets. preserveAspectRatio="none" so it stretches to the
// card width; a separate tiny axis-label strip below.

export function CostRevenueArea({
  points,
  locale,
}: {
  points: { day: string; costUsd: number; revenueRunRateUsd: number }[];
  locale: string;
}) {
  const W = 920;
  const H = 240;
  const pad = 8;
  if (points.length === 0) {
    return <div style={{ height: H, minHeight: H }} />;
  }
  const maxVal =
    Math.max(
      1e-6,
      ...points.map((p) => Math.max(p.costUsd, p.revenueRunRateUsd)),
    ) * 1.1;

  const x = (i: number) =>
    points.length === 1 ? W / 2 : (i / (points.length - 1)) * W;
  const y = (v: number) => H - pad - (v / maxVal) * (H - pad * 2);

  const costLine = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.costUsd)}`).join(' ');
  const costArea = `${costLine} L${x(points.length - 1)},${H} L${x(0)},${H} Z`;
  const revLine = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.revenueRunRateUsd)}`)
    .join(' ');

  // Axis labels: first / mid / last day.
  const labelAt = (i: number) => fmtAxisDate(points[i]?.day, locale);
  const lastIdx = points.length - 1;
  const midIdx = Math.floor(lastIdx / 2);

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
        role="img"
        aria-label="Cost versus revenue over time"
      >
        <defs>
          <linearGradient id="ra-cost-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <g>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line
              key={f}
              x1="0"
              y1={H * f}
              x2={W}
              y2={H * f}
              stroke="var(--rule-soft)"
              strokeWidth="1"
            />
          ))}
        </g>
        <path d={costArea} fill="url(#ra-cost-grad)" />
        <path d={costLine} fill="none" stroke="var(--accent-text)" strokeWidth="2" />
        <path d={revLine} fill="none" stroke="var(--violet)" strokeWidth="2.5" />
        <circle cx={x(lastIdx)} cy={y(points[lastIdx].revenueRunRateUsd)} r="4" fill="var(--violet)" />
        <circle cx={x(lastIdx)} cy={y(points[lastIdx].costUsd)} r="4" fill="var(--accent)" />
      </svg>
      <svg viewBox={`0 0 ${W} 16`} width="100%" height="16" style={{ display: 'block', marginTop: 4 }}>
        <text x="0" y="12" fontFamily="var(--mono)" fontSize="10" fill="var(--muted)">
          {labelAt(0)}
        </text>
        <text x={W / 2} y="12" textAnchor="middle" fontFamily="var(--mono)" fontSize="10" fill="var(--muted)">
          {labelAt(midIdx)}
        </text>
        <text x={W} y="12" textAnchor="end" fontFamily="var(--mono)" fontSize="10" fill="var(--muted)">
          {labelAt(lastIdx)}
        </text>
      </svg>
    </div>
  );
}

function fmtAxisDate(day: string | undefined, locale: string): string {
  if (!day) return '';
  const d = new Date(day);
  if (Number.isNaN(d.getTime())) return day;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
}

// ── Sparkline ───────────────────────────────────────────────────────────────
//
// The drill-down daily-cost sparkline. CSS-column bars (mirrors the .spark
// slot) so it reads as a tiny equalizer; takes a raw number series.

export function Sparkline({
  points,
  color = 'var(--accent-text)',
  height = 46,
}: {
  points: number[];
  color?: string;
  height?: number;
}) {
  const max = points.reduce((m, v) => Math.max(m, v), 0) || 1;
  return (
    <div
      style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height }}
      role="img"
      aria-label="Daily cost sparkline"
    >
      {points.map((v, i) => (
        <span
          key={i}
          style={{
            flex: 1,
            background: 'var(--accent-soft)',
            borderTop: `2px solid ${color}`,
            borderRadius: '2px 2px 0 0',
            minHeight: 3,
            height: `${Math.max(6, (v / max) * 100)}%`,
          }}
        />
      ))}
    </div>
  );
}

// ── ColumnChart ───────────────────────────────────────────────────────────
//
// A labelled CSS column chart for a time series of {label, value}. Used when a
// fuller column view is wanted than the bare sparkline.

export function ColumnChart({
  data,
  color = 'var(--accent-text)',
  height = 140,
  valueFormatter,
}: {
  data: { label: string; value: number }[];
  color?: string;
  height?: number;
  valueFormatter?: (v: number) => string;
}) {
  const max = data.reduce((m, d) => Math.max(m, d.value), 0) || 1;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height, width: '100%' }} role="img" aria-label="Time series column chart">
      {data.map((d, i) => (
        <div key={d.label + i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div
            title={`${d.label} · ${valueFormatter ? valueFormatter(d.value) : d.value}`}
            style={{
              height: `${Math.max(3, (d.value / max) * 100)}%`,
              background: 'var(--accent-soft)',
              borderTop: `2px solid ${color}`,
              borderRadius: '2px 2px 0 0',
              minHeight: 3,
            }}
          />
        </div>
      ))}
    </div>
  );
}

// ── ModalityDonut ───────────────────────────────────────────────────────────
//
// SVG donut (stroke-dasharray segments) with a center total + a legend list.
// `segments` are pre-colored; the center shows the formatted total.

export function ModalityDonut({
  segments,
  centerValue,
  centerLabel,
}: {
  segments: { label: string; value: number; color: string; estimated?: boolean; valueText: string; pctText: string }[];
  centerValue: string;
  centerLabel: string;
}) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;
  // Build cumulative offsets on a 100-unit circumference (r = 15.915).
  let acc = 0;
  const arcs = segments.map((seg) => {
    const pct = (Math.max(0, seg.value) / total) * 100;
    const dash = `${pct} ${100 - pct}`;
    // dashoffset positions the start of the arc; SVG starts at 3 o'clock, we
    // rotate -90 so it starts at 12. Offset moves the segment counterclockwise.
    const offset = 25 - acc; // 25 aligns the first segment to the top
    acc += pct;
    return { ...seg, dash, offset };
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
      <div style={{ position: 'relative', width: 160, height: 160 }}>
        <svg viewBox="0 0 42 42" width="160" height="160" role="img" aria-label="Cost by modality">
          <circle cx="21" cy="21" r="15.915" fill="none" stroke="var(--surface-2)" strokeWidth="6" />
          {arcs.map((a, i) => (
            <circle
              key={a.label + i}
              cx="21"
              cy="21"
              r="15.915"
              fill="none"
              stroke={a.color}
              strokeWidth="6"
              strokeDasharray={a.dash}
              strokeDashoffset={a.offset}
              transform="rotate(-90 21 21)"
            />
          ))}
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
          <div>
            <div className="robo-tnum" style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>
              {centerValue}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '9.5px', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--muted)' }}>
              {centerLabel}
            </div>
          </div>
        </div>
      </div>
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {segments.map((seg, i) => (
          <div key={seg.label + i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12.5px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--text-2)' }}>
              <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 3, background: seg.color }} />
              {seg.label}
              {seg.estimated ? <EstimatedMarker>~est</EstimatedMarker> : null}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '11.5px', color: 'var(--text-2)' }}>
              <b style={{ color: 'var(--text)' }}>{seg.valueText}</b> · {seg.pctText}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
