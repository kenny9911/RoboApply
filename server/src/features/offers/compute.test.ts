// @vitest-environment node
//
// WP-64: totals are computed only from the user's numbers, with every factor
// stated; no currency conversion; text fields are shown, never counted.

import { describe, expect, it } from 'vitest';
import type { OfferInput, OfferView } from './contract.js';
import {
  assumptionsFor,
  baseAnnualOf,
  baseInPeriod,
  compareOffers,
  housingFundAnnualOf,
  percentDiff,
  positionAgainst,
  rowsFor,
  totalsFor,
} from './compute.js';

function view(id: string, offer: OfferInput, over: Partial<OfferView> = {}): OfferView {
  return { trackerEntryId: id, jobId: null, title: 'Data Analyst', companyName: `Co ${id}`, status: 'offer', offer, totals: totalsFor(id, offer), updatedAt: '2026-10-01T00:00:00.000Z', ...over };
}

describe('baseAnnualOf', () => {
  it('year × 1, month × 薪数 (default 12), hour × hours × 52 (default 40)', () => {
    expect(baseAnnualOf({ base: 120000, currency: 'USD', period: 'year' })).toBe(120000);
    expect(baseAnnualOf({ base: 20000, currency: 'CNY', period: 'month' })).toBe(240000);
    expect(baseAnnualOf({ base: 20000, currency: 'CNY', period: 'month', cn: { salaryMonths: 15 } })).toBe(300000);
    expect(baseAnnualOf({ base: 50, currency: 'USD', period: 'hour' })).toBe(104000);
    expect(baseAnnualOf({ base: 50, currency: 'USD', period: 'hour', hoursPerWeek: 30 })).toBe(78000);
  });
});

describe('housingFundAnnualOf', () => {
  it('base × % × 12 only when both are entered and the percent is positive', () => {
    expect(housingFundAnnualOf({ base: 1, currency: 'CNY', period: 'month', cn: { socialInsuranceBase: 20000, housingFundPercent: 12 } })).toBe(28800);
    expect(housingFundAnnualOf({ base: 1, currency: 'CNY', period: 'month', cn: { socialInsuranceBase: 20000 } })).toBeNull();
    expect(housingFundAnnualOf({ base: 1, currency: 'CNY', period: 'month', cn: { housingFundPercent: 7 } })).toBeNull();
    expect(housingFundAnnualOf({ base: 1, currency: 'CNY', period: 'month', cn: { socialInsuranceBase: 20000, housingFundPercent: 0 } })).toBeNull();
  });
});

describe('totalsFor', () => {
  it('adds base, the counted bonus and the housing fund; the signing bonus only to the first year', () => {
    const t = totalsFor('a', {
      base: 25000,
      currency: 'CNY',
      period: 'month',
      bonusAmount: 30000,
      signingBonus: 50000,
      cn: { salaryMonths: 14, socialInsuranceBase: 25000, housingFundPercent: 10, yearEndBonus: '2-4 个月', hukou: true },
      equity: '期权 1 万股',
      bonus: '看绩效',
    });
    expect(t.baseAnnual).toBe(350000);
    expect(t.housingFundAnnual).toBe(30000);
    expect(t.recurringAnnual).toBe(410000);
    expect(t.firstYear).toBe(460000);
    expect(t.excluded).toEqual(['bonus_text', 'equity', 'year_end_text', 'hukou']);
  });

  it('leaves unknown parts null (never 0) and adds nothing for them', () => {
    const t = totalsFor('b', { base: 100000, currency: 'USD', period: 'year' });
    expect(t).toMatchObject({ bonusAnnual: null, housingFundAnnual: null, signingBonus: null, recurringAnnual: 100000, firstYear: 100000, excluded: [] });
  });
});

describe('assumptionsFor', () => {
  it('states every factor and what is not counted, per offer', () => {
    const offers = [
      view('m', { base: 20000, currency: 'CNY', period: 'month', cn: { salaryMonths: 13, socialInsuranceBase: 20000, housingFundPercent: 12, yearEndBonus: '1 个月' } }),
      view('h', { base: 40, currency: 'USD', period: 'hour', bonus: '10% target', equity: '0.1%', signingBonus: 5000 }),
    ];
    const codes = assumptionsFor(offers);
    expect(codes.map((a) => a.code)).toEqual([
      'pre_tax',
      'month_times_months',
      'hour_times_hours',
      'housing_fund_company_match',
      'signing_first_year_only',
      'bonus_text_not_counted',
      'year_end_text_not_counted',
      'equity_not_valued',
      'no_currency_conversion',
    ]);
    expect(codes.find((a) => a.code === 'month_times_months')).toMatchObject({ params: { months: 13 }, trackerEntryIds: ['m'] });
    expect(codes.find((a) => a.code === 'hour_times_hours')).toMatchObject({ params: { hours: 40, weeks: 52 }, trackerEntryIds: ['h'] });
  });

  it('does not say "bonus not counted" when the amount is entered', () => {
    const codes = assumptionsFor([view('a', { base: 1, currency: 'USD', period: 'year', bonus: '10%', bonusAmount: 10000 })]).map((a) => a.code);
    expect(codes).not.toContain('bonus_text_not_counted');
  });
});

describe('compareOffers', () => {
  it('names the highest totals only when the currencies match (ties keep every id)', () => {
    const same = compareOffers(
      [view('a', { base: 100000, currency: 'USD', period: 'year', signingBonus: 20000 }), view('b', { base: 110000, currency: 'USD', period: 'year' })],
      'intl',
    );
    expect(same.sameCurrency).toBe(true);
    expect(same.highest).toEqual({ recurringAnnual: ['b'], firstYear: ['a'] });
    expect(same.annualized).toEqual([
      { trackerEntryId: 'a', value: 100000, currency: 'USD' },
      { trackerEntryId: 'b', value: 110000, currency: 'USD' },
    ]);
    const tie = compareOffers([view('a', { base: 1, currency: 'USD', period: 'year' }), view('b', { base: 1, currency: 'USD', period: 'year' })], 'intl');
    expect(tie.highest?.recurringAnnual).toEqual(['a', 'b']);

    const mixed = compareOffers([view('a', { base: 100000, currency: 'USD', period: 'year' }), view('b', { base: 3000000, currency: 'TWD', period: 'year' })], 'intl');
    expect(mixed.sameCurrency).toBe(false);
    expect(mixed.highest).toBeNull();
    expect(mixed.assumptions.map((a) => a.code)).toContain('no_currency_conversion');
  });

  it('rows: only filled rows of the market field set, values in offer order, null when not entered', () => {
    const offers = [
      view('a', { base: 20000, currency: 'CNY', period: 'month', cn: { salaryMonths: 14, hukou: true }, location: '上海' }),
      view('b', { base: 22000, currency: 'CNY', period: 'month', cn: { hukou: false } }),
    ];
    const cn = rowsFor(offers, 'cn');
    expect(cn.map((r) => r.key)).toEqual(['base', 'salaryMonths', 'hukou', 'location']);
    expect(cn.find((r) => r.key === 'salaryMonths')!.values).toEqual([14, null]);
    expect(cn.find((r) => r.key === 'hukou')!.values).toEqual([true, false]);
    const intl = rowsFor(offers, 'intl');
    expect(intl.map((r) => r.key)).toEqual(['base', 'location']);
  });

  it('empty input has no highest', () => {
    expect(compareOffers([], 'intl').highest).toBeNull();
  });
});

describe('baseInPeriod / positionAgainst / percentDiff', () => {
  it('converts with the stated factors', () => {
    const yearly: OfferInput = { base: 120000, currency: 'USD', period: 'year' };
    expect(baseInPeriod(yearly, 'year')).toBe(120000);
    expect(baseInPeriod(yearly, 'month')).toBe(10000);
    expect(baseInPeriod(yearly, 'hour')).toBeCloseTo(57.69, 2);
    expect(baseInPeriod({ base: 20000, currency: 'CNY', period: 'month', cn: { salaryMonths: 13 } }, 'month')).toBe(20000);
    expect(baseInPeriod({ base: 20000, currency: 'CNY', period: 'month', cn: { salaryMonths: 13 } }, 'year')).toBe(260000);
    expect(baseInPeriod(yearly, 'fortnight')).toBeNull();
  });

  it('positions and percent differences', () => {
    expect(positionAgainst(5, 10, 20)).toBe('below');
    expect(positionAgainst(10, 10, 20)).toBe('within');
    expect(positionAgainst(21, 10, 20)).toBe('above');
    expect(percentDiff(110, 100)).toBe(10);
    expect(percentDiff(92, 100)).toBe(-8);
    expect(percentDiff(1, 0)).toBeNull();
  });
});
