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

/** Format provider minor units in their original ISO currency (JPY has no cents). */
export function fmtNativeAmount(amountMinor: number | null | undefined, currency: string | null | undefined, locale: string): string {
  if (amountMinor == null || !Number.isFinite(amountMinor) || !currency) return '—';
  try {
    const formatter = getFormatter(`native:${locale}:${currency}`, () => new Intl.NumberFormat(locale, {
      style: 'currency', currency: currency.toUpperCase(), currencyDisplay: 'code',
    }));
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(amountMinor / 10 ** digits);
  } catch {
    return '—';
  }
}
