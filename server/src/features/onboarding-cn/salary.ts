// server/src/features/onboarding-cn/salary.ts — K/月·N薪 parsing and formatting (PRODUCT_PLAN.md §4.5 G4).
//
// Mainland postings state monthly pay as "15-25K·13薪" (15k–25k yuan a month,
// 13 months a year), "1.5-2.5万", "20K/月" or 面议 (negotiable). This module
// reads those forms and writes the one display form we use. It never invents
// a number: text it cannot read returns null. Pure; the client mirrors the
// formatter (components/features/onboarding-cn/logic.ts, parity test).

import { CN_INTERN_DAILY_OPTIONS, CN_SALARY_K_OPTIONS, CN_SALARY_MONTHS_OPTIONS } from './contract.js';

export type MonthlyKSalary =
  | { kind: 'range'; min: number; max: number; months: number | null }
  | { kind: 'negotiable' };

const NEGOTIABLE = /^(面议|面議|薪资面议|薪資面議|negotiable)$/i;

function toNumber(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Round to one decimal (8.5K stays 8.5). */
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Parse a monthly pay text into thousands of yuan (K) a month.
 *   "15-25K·13薪" → {min:15, max:25, months:13}
 *   "1.5万-2.5万" → {min:15, max:25, months:null}
 *   "20K/月" → {min:20, max:20}
 *   "面议" → {kind:'negotiable'}
 * Returns null for anything else (daily pay, yearly pay, free text).
 */
export function parseMonthlyKSalary(text: string | null | undefined): MonthlyKSalary | null {
  if (!text) return null;
  const t = text
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[～〜~—–至到]/g, '-')
    .replace(/[·•・･]/g, '·');
  if (NEGOTIABLE.test(t)) return { kind: 'negotiable' };

  let months: number | null = null;
  const monthsMatch = t.match(/[·*x×](\d{2})薪$/i) ?? t.match(/(\d{2})薪$/);
  let body = t;
  if (monthsMatch) {
    const m = Number(monthsMatch[1]);
    if (m < 12 || m > 24) return null;
    months = m;
    body = t.slice(0, monthsMatch.index).replace(/[·*x×]$/i, '');
  }
  body = body.replace(/(\/月|每月|元\/月|\/month)$/i, '');

  // "15-25K", "15K-25K", "15k-25k"
  let m = body.match(/^(\d+(?:\.\d+)?)k?-(\d+(?:\.\d+)?)k$/i);
  let scale = 1;
  if (!m) {
    // "1.5-2.5万", "1.5万-2.5万"
    m = body.match(/^(\d+(?:\.\d+)?)万?-(\d+(?:\.\d+)?)万$/);
    scale = 10;
  }
  if (m) {
    const a = toNumber(m[1]!);
    const b = toNumber(m[2]!);
    if (a === null || b === null) return null;
    const min = r1(a * scale);
    const max = r1(b * scale);
    if (min > max) return null;
    return { kind: 'range', min, max, months };
  }
  const single = body.match(/^(\d+(?:\.\d+)?)(k|万)$/i);
  if (single) {
    const v = toNumber(single[1]!);
    if (v === null) return null;
    const k = r1(v * (single[2]!.toLowerCase() === 'k' ? 1 : 10));
    return { kind: 'range', min: k, max: k, months };
  }
  return null;
}

/** "15-25K·13薪", "20K", or "面议" for the negotiable value (the bundle supplies the word on the client). */
export function formatMonthlyK(value: MonthlyKSalary | { min: number; max: number } | 'negotiable', months?: number | null, negotiableLabel = '面议'): string {
  if (value === 'negotiable' || ('kind' in value && value.kind === 'negotiable')) return negotiableLabel;
  const { min, max } = value as { min: number; max: number };
  const n = months ?? ('months' in value ? (value as { months: number | null }).months : null);
  const range = min === max ? `${min}K` : `${min}-${max}K`;
  return n ? `${range}·${n}薪` : range;
}

/** Midpoint of a monthly range in yuan (for medians). */
export function monthlyMidpointYuan(min: number | null | undefined, max: number | null | undefined): number | null {
  const lo = typeof min === 'number' && min > 0 ? min : null;
  const hi = typeof max === 'number' && max > 0 ? max : null;
  if (lo === null && hi === null) return null;
  if (lo !== null && hi !== null) return (lo + hi) / 2;
  return (lo ?? hi)!;
}

export const isSalaryKOption = (n: number) => CN_SALARY_K_OPTIONS.includes(n);
export const isSalaryMonthsOption = (n: number) => CN_SALARY_MONTHS_OPTIONS.includes(n);
export const isInternDailyOption = (n: number) => CN_INTERN_DAILY_OPTIONS.includes(n);

/** Median of a non-empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Linear-interpolated quantile (0–1) of a non-empty list. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
