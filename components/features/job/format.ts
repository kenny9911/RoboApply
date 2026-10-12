// components/features/job/format.ts — pure display helpers for job detail (WP-34).

import type { JobPay } from '../../../lib/api/contracts/jobs/detail';

/** Money without invented precision: the posting's own numbers, the posting's currency. */
export function formatMoney(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString(locale)}`;
  }
}

export type PayLine =
  | { kind: 'exact'; amount: string; period: JobPay['period'] }
  | { kind: 'range'; min: string; max: string; period: JobPay['period'] }
  | { kind: 'from'; min: string; period: JobPay['period'] }
  | { kind: 'upTo'; max: string; period: JobPay['period'] };

/** Null when there is nothing numeric to show ("Pay not listed"). */
export function payLine(pay: JobPay | null | undefined, locale: string): PayLine | null {
  if (!pay) return null;
  const min = pay.min != null && pay.min > 0 ? formatMoney(pay.min, pay.currency, locale) : null;
  const max = pay.max != null && pay.max > 0 ? formatMoney(pay.max, pay.currency, locale) : null;
  if (min && max) return min === max ? { kind: 'exact', amount: min, period: pay.period } : { kind: 'range', min, max, period: pay.period };
  if (min) return { kind: 'from', min, period: pay.period };
  if (max) return { kind: 'upTo', max, period: pay.period };
  return null;
}

/** The job's full page (`/jobs/[id]`). */
export function jobDetailHref(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}`;
}

export function validDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Initial for a missing logo (decorative). */
export function initialOf(name: string): string {
  const t = name.trim();
  return t ? Array.from(t)[0]!.toUpperCase() : '·';
}

/**
 * The line under a shared job's title: the place, then the pay exactly as the
 * posting lists it ("上海 · 15-25K·14薪"). A part we do not have is left out
 * (never "0", never a guess); with neither, null and the caller's default
 * line is used.
 */
export function shareDescription(parts: { location: string | null | undefined; payAsListed: string | null | undefined }): string | null {
  const out = [parts.location, parts.payAsListed].map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean);
  return out.length ? out.join(' · ') : null;
}
