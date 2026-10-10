// server/src/features/offers/compute.ts — deterministic offer totals and the
// side-by-side comparison (WP-64). Pure: no I/O, no clock, no market data.
//
// Rules:
//   - Only the user's own numbers are added up. Text fields (bonus as written,
//     年终, equity, 户口) are shown and listed as "not counted".
//   - Every factor used is stated as an assumption: months a year (薪数 or
//     12), hours a week (entered or 40) × 52, the 公积金 company match, the
//     signing bonus counted in the first year only, pre-tax.
//   - No currency conversion: offers in different currencies are compared row
//     by row, and no "highest" is named.

import {
  DEFAULT_HOURS_PER_WEEK,
  DEFAULT_SALARY_MONTHS,
  WEEKS_PER_YEAR,
  type OfferAssumption,
  type OfferComparison,
  type OfferComparisonRow,
  type OfferExcludedPart,
  type OfferInput,
  type OfferPosition,
  type OfferRowKey,
  type OfferTotals,
  type OfferView,
} from './contract.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Pay periods a posting may state, with the yearly factor (same factors as jobs/normalize). */
export const PERIOD_FACTOR: Record<string, number> = { hour: 2080, day: 260, week: 52, month: 12, year: 1 };

/** Months of base pay a year for a monthly offer. */
export function salaryMonthsOf(offer: OfferInput): number {
  return offer.cn?.salaryMonths ?? DEFAULT_SALARY_MONTHS;
}

/** Hours a week for an hourly offer. */
export function hoursPerWeekOf(offer: OfferInput): number {
  return offer.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK;
}

/** Base pay for a year, from the entered base and the stated factor. */
export function baseAnnualOf(offer: OfferInput): number {
  switch (offer.period) {
    case 'month':
      return round2(offer.base * salaryMonthsOf(offer));
    case 'hour':
      return round2(offer.base * hoursPerWeekOf(offer) * WEEKS_PER_YEAR);
    default:
      return round2(offer.base);
  }
}

/**
 * 公积金 company part a year: the fund base × % × 12. The fund base is the
 * 五险一金 base the user entered; without it nothing is computed.
 */
export function housingFundAnnualOf(offer: OfferInput): number | null {
  const base = offer.cn?.socialInsuranceBase;
  const pct = offer.cn?.housingFundPercent;
  if (base === undefined || pct === undefined || pct <= 0) return null;
  return round2((base * pct * 12) / 100);
}

export function totalsFor(trackerEntryId: string, offer: OfferInput): OfferTotals {
  const baseAnnual = baseAnnualOf(offer);
  const bonusAnnual = offer.bonusAmount ?? null;
  const housingFundAnnual = housingFundAnnualOf(offer);
  const signingBonus = offer.signingBonus ?? null;
  const recurringAnnual = round2(baseAnnual + (bonusAnnual ?? 0) + (housingFundAnnual ?? 0));
  const firstYear = round2(recurringAnnual + (signingBonus ?? 0));
  const excluded: OfferExcludedPart[] = [];
  if (offer.bonus) excluded.push('bonus_text');
  if (offer.equity) excluded.push('equity');
  if (offer.cn?.yearEndBonus) excluded.push('year_end_text');
  if (offer.cn?.hukou) excluded.push('hukou');
  return { trackerEntryId, currency: offer.currency, baseAnnual, bonusAnnual, housingFundAnnual, signingBonus, recurringAnnual, firstYear, excluded };
}

/** The assumptions behind a set of totals (each names the offers it applies to). */
export function assumptionsFor(offers: readonly OfferView[]): OfferAssumption[] {
  const out: OfferAssumption[] = [{ code: 'pre_tax' }];
  const idsWhere = (pred: (o: OfferInput) => boolean) => offers.filter((o) => pred(o.offer)).map((o) => o.trackerEntryId);

  const byMonths = new Map<number, string[]>();
  for (const o of offers) {
    if (o.offer.period !== 'month') continue;
    const m = salaryMonthsOf(o.offer);
    byMonths.set(m, [...(byMonths.get(m) ?? []), o.trackerEntryId]);
  }
  for (const [months, ids] of byMonths) out.push({ code: 'month_times_months', params: { months }, trackerEntryIds: ids });

  const byHours = new Map<number, string[]>();
  for (const o of offers) {
    if (o.offer.period !== 'hour') continue;
    const h = hoursPerWeekOf(o.offer);
    byHours.set(h, [...(byHours.get(h) ?? []), o.trackerEntryId]);
  }
  for (const [hours, ids] of byHours) out.push({ code: 'hour_times_hours', params: { hours, weeks: WEEKS_PER_YEAR }, trackerEntryIds: ids });

  const fund = idsWhere((o) => housingFundAnnualOf(o) !== null);
  if (fund.length) out.push({ code: 'housing_fund_company_match', trackerEntryIds: fund });
  const signing = idsWhere((o) => o.signingBonus !== undefined && o.signingBonus > 0);
  if (signing.length) out.push({ code: 'signing_first_year_only', trackerEntryIds: signing });
  const bonusText = idsWhere((o) => Boolean(o.bonus) && o.bonusAmount === undefined);
  if (bonusText.length) out.push({ code: 'bonus_text_not_counted', trackerEntryIds: bonusText });
  const yearEnd = idsWhere((o) => Boolean(o.cn?.yearEndBonus));
  if (yearEnd.length) out.push({ code: 'year_end_text_not_counted', trackerEntryIds: yearEnd });
  const equity = idsWhere((o) => Boolean(o.equity));
  if (equity.length) out.push({ code: 'equity_not_valued', trackerEntryIds: equity });
  if (new Set(offers.map((o) => o.offer.currency)).size > 1) out.push({ code: 'no_currency_conversion' });
  return out;
}

const INTL_ROWS: OfferRowKey[] = ['base', 'bonusAmount', 'bonus', 'signingBonus', 'equity', 'location', 'startDate', 'deadline'];
const CN_ROWS: OfferRowKey[] = ['base', 'salaryMonths', 'yearEndBonus', 'socialInsuranceBase', 'housingFundPercent', 'hukou', 'signingBonus', 'equity', 'location', 'startDate', 'deadline'];

function rowValue(offer: OfferInput, key: OfferRowKey): string | number | boolean | null {
  switch (key) {
    case 'salaryMonths':
      return offer.cn?.salaryMonths ?? null;
    case 'yearEndBonus':
      return offer.cn?.yearEndBonus ?? null;
    case 'socialInsuranceBase':
      return offer.cn?.socialInsuranceBase ?? null;
    case 'housingFundPercent':
      return offer.cn?.housingFundPercent ?? null;
    case 'hukou':
      return offer.cn?.hukou ?? null;
    default:
      return (offer[key] as string | number | undefined) ?? null;
  }
}

/** Rows for the table: the market's field set, only those at least one offer filled in. */
export function rowsFor(offers: readonly OfferView[], market: 'intl' | 'cn'): OfferComparisonRow[] {
  const keys = market === 'cn' ? CN_ROWS : INTL_ROWS;
  const rows: OfferComparisonRow[] = [];
  for (const key of keys) {
    const values = offers.map((o) => rowValue(o.offer, key));
    if (values.some((v) => v !== null)) rows.push({ key, values });
  }
  return rows;
}

function maxIds(totals: readonly OfferTotals[], pick: (t: OfferTotals) => number): string[] {
  const best = Math.max(...totals.map(pick));
  return totals.filter((t) => pick(t) === best).map((t) => t.trackerEntryId);
}

/** The full comparison for offers in the order given. */
export function compareOffers(offers: readonly OfferView[], market: 'intl' | 'cn'): OfferComparison {
  const totals = offers.map((o) => totalsFor(o.trackerEntryId, o.offer));
  const sameCurrency = new Set(offers.map((o) => o.offer.currency)).size <= 1;
  return {
    offers: [...offers],
    totals,
    rows: rowsFor(offers, market),
    annualized: totals.map((t) => ({ trackerEntryId: t.trackerEntryId, value: t.recurringAnnual, currency: t.currency })),
    assumptions: assumptionsFor(offers),
    sameCurrency,
    highest: sameCurrency && totals.length > 0 ? { recurringAnnual: maxIds(totals, (t) => t.recurringAnnual), firstYear: maxIds(totals, (t) => t.firstYear) } : null,
  };
}

/** The offer's base expressed in another pay period (stated factors); null for an unknown period. */
export function baseInPeriod(offer: OfferInput, period: string): number | null {
  const target = PERIOD_FACTOR[period];
  if (!target) return null;
  if (period === offer.period) return offer.base;
  return round2(baseAnnualOf(offer) / target);
}

/** Where a value sits against a p25–p75 band. */
export function positionAgainst(value: number, low: number, high: number): OfferPosition {
  if (value < low) return 'below';
  if (value > high) return 'above';
  return 'within';
}

/** Percent difference of `a` against `b`, rounded to a whole number (for the AI's allowed numbers). */
export function percentDiff(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return Math.round(((a - b) / b) * 100);
}
