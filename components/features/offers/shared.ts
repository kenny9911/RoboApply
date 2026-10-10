'use client';

// Shared helpers of the offers area (WP-64): the offer form state ↔ request
// body, money formatting, and the plain-language key for an AI error.

import { useFormatter } from 'next-intl';

import { apiErrorCode, apiErrorDetails, type In } from '../../../lib/api/contracts/wire';
import type * as OF from '../../../lib/api/contracts/offers';

export type OfferBody = In<typeof OF.PutOfferBodySchema>;
export type OfferPeriodValue = 'year' | 'month' | 'hour';

/** Every input is a string while editing; the body is built on save. */
export interface OfferFormState {
  base: string;
  currency: string;
  period: OfferPeriodValue;
  hoursPerWeek: string;
  bonus: string;
  bonusAmount: string;
  signingBonus: string;
  equity: string;
  location: string;
  startDate: string;
  deadline: string;
  notes: string;
  salaryMonths: string;
  yearEndBonus: string;
  socialInsuranceBase: string;
  housingFundPercent: string;
  hukou: '' | 'yes' | 'no';
}

const str = (v: number | string | undefined | null) => (v === undefined || v === null ? '' : String(v));

/** Default currency for a new offer: the offer's own, else the market's (zh-TW → TWD). */
export function defaultCurrency(market: 'intl' | 'cn', locale: string): string {
  if (market === 'cn') return 'CNY';
  return locale === 'zh-TW' ? 'TWD' : 'USD';
}

export function formFrom(offer: OF.OfferInput | null | undefined, defaults: { market: 'intl' | 'cn'; currency: string }): OfferFormState {
  return {
    base: str(offer?.base),
    currency: offer?.currency ?? defaults.currency,
    period: offer?.period ?? (defaults.market === 'cn' ? 'month' : 'year'),
    hoursPerWeek: str(offer?.hoursPerWeek),
    bonus: offer?.bonus ?? '',
    bonusAmount: str(offer?.bonusAmount),
    signingBonus: str(offer?.signingBonus),
    equity: offer?.equity ?? '',
    location: offer?.location ?? '',
    startDate: offer?.startDate ?? '',
    deadline: offer?.deadline ?? '',
    notes: offer?.notes ?? '',
    salaryMonths: str(offer?.cn?.salaryMonths),
    yearEndBonus: offer?.cn?.yearEndBonus ?? '',
    socialInsuranceBase: str(offer?.cn?.socialInsuranceBase),
    housingFundPercent: str(offer?.cn?.housingFundPercent),
    hukou: offer?.cn?.hukou === undefined ? '' : offer.cn.hukou ? 'yes' : 'no',
  };
}

export type OfferFormError = 'base' | 'currency' | 'number' | 'salary_months' | 'housing_fund_percent' | 'hours';

function num(s: string): number | undefined | null {
  const t = s.replace(/[,\s，]/g, '');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The PUT body, or the first problem. Empty optional fields are left out;
 * GoApply fields are sent only on the cn market.
 */
export function bodyFrom(f: OfferFormState, market: 'intl' | 'cn'): { body: OfferBody } | { error: OfferFormError } {
  const base = num(f.base);
  if (base === undefined || base === null || base <= 0) return { error: 'base' };
  const currency = f.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { error: 'currency' };
  const body: OfferBody = { base, currency, period: f.period };
  const numbers: Array<[keyof OfferBody, string]> = [
    ['bonusAmount', f.bonusAmount],
    ['signingBonus', f.signingBonus],
  ];
  for (const [key, raw] of numbers) {
    const n = num(raw);
    if (n === null) return { error: 'number' };
    if (n !== undefined) (body as Record<string, unknown>)[key] = n;
  }
  if (f.period === 'hour') {
    const h = num(f.hoursPerWeek);
    if (h === null || (h !== undefined && (h < 1 || h > 80))) return { error: 'hours' };
    if (h !== undefined) body.hoursPerWeek = h;
  }
  for (const key of ['bonus', 'equity', 'location', 'notes'] as const) {
    const v = f[key].trim();
    if (v) body[key] = v;
  }
  if (f.startDate) body.startDate = f.startDate;
  if (f.deadline) body.deadline = f.deadline;

  if (market === 'cn') {
    const cn: NonNullable<OfferBody['cn']> = {};
    const months = num(f.salaryMonths);
    if (months === null || (months !== undefined && (!Number.isInteger(months) || months < 12 || months > 24))) return { error: 'salary_months' };
    if (months !== undefined) cn.salaryMonths = months;
    const sib = num(f.socialInsuranceBase);
    if (sib === null) return { error: 'number' };
    if (sib !== undefined) cn.socialInsuranceBase = sib;
    const pct = num(f.housingFundPercent);
    if (pct === null || (pct !== undefined && pct > 12)) return { error: 'housing_fund_percent' };
    if (pct !== undefined) cn.housingFundPercent = pct;
    if (f.yearEndBonus.trim()) cn.yearEndBonus = f.yearEndBonus.trim();
    if (f.hukou) cn.hukou = f.hukou === 'yes';
    if (Object.keys(cn).length) body.cn = cn;
  }
  return { body };
}

/** Money in its own currency, whole units (never converted). */
export function useMoney() {
  const format = useFormatter();
  return (value: number | null | undefined, currency: string): string => {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    try {
      return format.number(value, { style: 'currency', currency, maximumFractionDigits: value % 1 === 0 ? 0 : 2 });
    } catch {
      return `${format.number(value)} ${currency}`;
    }
  };
}

export type OfferAiErrorKey = 'ai_unavailable' | 'ai_off' | 'unsupported_numbers' | 'content_blocked' | 'rate_limited' | 'generic';

/** One plain sentence per way an AI action can fail (nothing is retried on another model). */
export function aiErrorKey(err: unknown): OfferAiErrorKey | null {
  if (!err) return null;
  const code = apiErrorCode(err);
  const reason = apiErrorDetails<{ reason?: string }>(err)?.reason;
  if (code === 'phone_binding_required') return null; // PhoneBindingNotice handles it
  if (code === 'ai_unavailable') {
    if (reason === 'ai_off') return 'ai_off';
    if (reason === 'ai_unsupported_numbers') return 'unsupported_numbers';
    return 'ai_unavailable';
  }
  if (code === 'content_blocked') return 'content_blocked';
  if (code === 'rate_limited') return 'rate_limited';
  return 'generic';
}
