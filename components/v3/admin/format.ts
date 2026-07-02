// components/v3/admin/format.ts
//
// Locale-aware number / currency / percent formatting for the admin console.
// Per the i18n rule we never hardcode $/% glyphs in prose — these helpers wrap
// `Intl.NumberFormat`. The cache keeps formatter construction cheap across the
// many tabular cells.

const fmtCache = new Map<string, Intl.NumberFormat>();

function getFormatter(key: string, factory: () => Intl.NumberFormat): Intl.NumberFormat {
  let f = fmtCache.get(key);
  if (!f) {
    f = factory();
    fmtCache.set(key, f);
  }
  return f;
}

/** "$1,284.50" — currency, 2 decimals. */
export function fmtCurrency(
  value: number | null | undefined,
  locale: string,
  currency = 'USD',
): string {
  const n = Number.isFinite(value as number) ? (value as number) : 0;
  return getFormatter(`cur:${locale}:${currency}`, () =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  ).format(n);
}

/** "$1,284" — currency, no decimals (large KPI values). */
export function fmtCurrencyWhole(
  value: number | null | undefined,
  locale: string,
  currency = 'USD',
): string {
  const n = Number.isFinite(value as number) ? (value as number) : 0;
  return getFormatter(`curw:${locale}:${currency}`, () =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }),
  ).format(n);
}

/** Signed currency: "+$11.82" / "−$1.20" (uses the real minus sign U+2212). */
export function fmtSignedCurrency(
  value: number | null | undefined,
  locale: string,
  currency = 'USD',
): string {
  const n = Number.isFinite(value as number) ? (value as number) : 0;
  const sign = n < 0 ? '−' : '+';
  return `${sign}${fmtCurrency(Math.abs(n), locale, currency)}`;
}

/** "1,847" — integer counts. */
export function fmtCount(value: number | null | undefined, locale: string): string {
  const n = Number.isFinite(value as number) ? (value as number) : 0;
  return getFormatter(`cnt:${locale}`, () => new Intl.NumberFormat(locale)).format(n);
}

/** "69.1%" — percent from a 0..100 number (one decimal). Null → "—". */
export function fmtPercent(
  value: number | null | undefined,
  locale: string,
  decimals = 1,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return getFormatter(`pct:${locale}:${decimals}`, () =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }),
  ).format(value) + '%';
}

/** Compact token count: 412000 → "412K". */
export function fmtCompact(value: number | null | undefined, locale: string): string {
  const n = Number.isFinite(value as number) ? (value as number) : 0;
  return getFormatter(`compact:${locale}`, () =>
    new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }),
  ).format(n);
}

/** Duration in seconds → "18m" / "1h 4m". Null → "—". */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Relative "2h ago" / "just now". Locale-aware via Intl.RelativeTimeFormat. */
const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
export function fmtRelative(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const diffMs = Date.now() - then;
  let fmt = rtfCache.get(locale);
  if (!fmt) {
    fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
    rtfCache.set(locale, fmt);
  }
  const sec = Math.round(diffMs / 1000);
  if (Math.abs(sec) < 45) return fmt.format(0, 'second');
  const min = Math.round(sec / 60);
  if (Math.abs(min) < 60) return fmt.format(-min, 'minute');
  const hr = Math.round(min / 60);
  if (Math.abs(hr) < 24) return fmt.format(-hr, 'hour');
  const day = Math.round(hr / 24);
  if (Math.abs(day) < 30) return fmt.format(-day, 'day');
  const mo = Math.round(day / 30);
  if (Math.abs(mo) < 12) return fmt.format(-mo, 'month');
  return fmt.format(-Math.round(mo / 12), 'year');
}

/** Short calendar date "Jul 13" (locale-aware month). */
export function fmtShortDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(d);
}

/** Long date "Jul 14, 2026". */
export function fmtLongDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}
