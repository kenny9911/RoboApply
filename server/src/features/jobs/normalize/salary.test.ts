// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { annualize, currencyFromText, normalizeSalary, parseSalaryText, payFromDescription, payPlausible, periodFromLabel, periodFromText, statesAmount } from './salary.js';

describe('parseSalaryText', () => {
  type Row = [string, { country?: string; market?: 'intl' | 'cn' }, Partial<{ min: number | null; max: number | null; currency: string | null; period: string | null; months: number | null; negotiable: boolean }> | null];
  const rows: Row[] = [
    ['$120,000 - $150,000 per year', { country: 'US' }, { min: 120000, max: 150000, currency: 'USD', period: 'year' }],
    ['$50/hr', { country: 'US' }, { min: 50, max: 50, currency: 'USD', period: 'hour' }],
    ['$38 - $46 per hour', { country: 'US' }, { min: 38, max: 46, period: 'hour' }],
    ['USD 100k–130k annually', {}, { min: 100000, max: 130000, currency: 'USD', period: 'year' }],
    ['£45,000 - £55,000 a year', {}, { min: 45000, max: 55000, currency: 'GBP', period: 'year' }],
    ['€60k p.a.', {}, { min: 60000, max: 60000, currency: 'EUR', period: 'year' }],
    ['Up to $150k', { country: 'US' }, { min: null, max: 150000, currency: 'USD' }],
    ['From $25/hour', { country: 'US' }, { min: 25, max: null, period: 'hour' }],
    ['$100k+', { country: 'US' }, { min: 100000, max: null }],
    ['C$80,000-95,000/year', {}, { currency: 'CAD', min: 80000, max: 95000 }],
    ['$90,000 - $110,000', { country: 'CA' }, { currency: 'CAD', period: null }],
    ['$90,000 - $110,000', {}, { currency: null, min: 90000 }],
    // Taiwan
    ['月薪 NT$ 55,000 ~ 75,000', { country: 'TW' }, { min: 55000, max: 75000, currency: 'TWD', period: 'month' }],
    ['月薪 40,000~60,000元', { country: 'TW' }, { min: 40000, max: 60000, currency: 'TWD', period: 'month' }],
    ['年薪 80萬~120萬', { country: 'TW' }, { min: 800000, max: 1200000, currency: 'TWD', period: 'year' }],
    ['時薪 190元', { country: 'TW' }, { min: 190, max: 190, currency: 'TWD', period: 'hour' }],
    ['月薪 4萬~5萬', { country: 'TW' }, { min: 40000, max: 50000, currency: 'TWD' }],
    ['待遇面議', { country: 'TW' }, { negotiable: true, min: null, max: null }],
    ['待遇面議（經常性薪資達4萬元或以上）', { country: 'TW' }, { negotiable: true, min: null, max: null, currency: null }],
    ['面議 (經常性薪資達 40,000 元或以上)', { country: 'TW' }, { negotiable: true, min: null }],
    ['依公司規定', { country: 'TW' }, { negotiable: true }],
    ['月薪 45,000~55,000元（面議）', { country: 'TW' }, { min: 45000, max: 55000, negotiable: false }],
    // Mainland China
    ['15-25K·14薪', { market: 'cn' }, { min: 15000, max: 25000, currency: 'CNY', period: 'month', months: 14 }],
    ['15k-25k·13薪', { country: 'CN' }, { min: 15000, max: 25000, months: 13, period: 'month' }],
    ['1-1.5万/月', { market: 'cn' }, { min: 10000, max: 15000, currency: 'CNY', period: 'month' }],
    ['200-300元/天', { market: 'cn' }, { min: 200, max: 300, currency: 'CNY', period: 'day' }],
    ['30-50万/年', { market: 'cn' }, { min: 300000, max: 500000, period: 'year' }],
    ['年薪30-50w', { country: 'CN' }, { min: 300000, max: 500000, period: 'year' }],
    ['8000-12000元/月', { market: 'cn' }, { min: 8000, max: 12000, currency: 'CNY', period: 'month' }],
    ['¥8000-12000/月', { country: 'CN' }, { currency: 'CNY' }],
    ['¥6,000,000 per year', { country: 'JP' }, { currency: 'JPY', period: 'year' }],
    ['薪资面议', { market: 'cn' }, { negotiable: true }],
    ['15-25K 14薪', { market: 'cn' }, { period: 'month', months: 14, min: 15000 }],
    ['$200 - $100 per hour', { country: 'US' }, { min: 100, max: 200 }],
    // Not pay
    ['2-3', {}, null],
    ['15-20w', {}, null],
    ['面议 2-3', {}, { negotiable: true, min: null }],
    ['Competitive salary', {}, { negotiable: true }],
    ['Great benefits', {}, null],
    ['base3000+补贴600', { market: 'intl' }, null],
    ['', {}, null],
  ];
  it.each(rows)('%s %j', (text, opts, expected) => {
    const p = parseSalaryText(text, opts);
    if (expected === null) expect(p).toBeNull();
    else expect(p).toMatchObject(expected);
  });

  it('keeps the verbatim phrase (max 80 chars)', () => {
    expect(parseSalaryText('待遇面議')?.text).toBe('待遇面議');
    expect(parseSalaryText(`$50/hr ${'x'.repeat(200)}`)?.text).toHaveLength(80);
    expect(parseSalaryText(null)).toBeNull();
  });
});

describe('period and currency helpers', () => {
  it.each([
    ['YEAR', 'year'],
    ['per hour', 'hour'],
    ['MONTHLY', 'month'],
    ['weekly', 'week'],
    ['DAY', 'day'],
    ['yearly', 'year'],
    ['bogus', null],
    ['--', null],
    ['', null],
    [null, null],
  ])('label %s → %s', (label, expected) => {
    expect(periodFromLabel(label as string | null)).toBe(expected);
  });

  it('finds periods in text', () => {
    expect(periodFromText('$20 an hour')).toBe('hour');
    expect(periodFromText('200元/天')).toBe('day');
    expect(periodFromText('$900 per week')).toBe('week');
    expect(periodFromText('15-25K·14薪')).toBe('month');
    expect(periodFromText('年薪 50萬')).toBe('year');
    expect(periodFromText('Salary: $100k, Philadelphia, PA')).toBeNull();
  });

  it('resolves "$", "¥" and "元" with the country and never guesses USD', () => {
    expect(currencyFromText('$100', 'US')).toBe('USD');
    expect(currencyFromText('$100', 'SG')).toBe('SGD');
    expect(currencyFromText('$100', 'FR')).toBeNull();
    expect(currencyFromText('$100', null)).toBeNull();
    expect(currencyFromText('NT$100', null)).toBe('TWD');
    expect(currencyFromText('HK$100', null)).toBe('HKD');
    expect(currencyFromText('¥100', 'JP')).toBe('JPY');
    expect(currencyFromText('¥100', 'CN')).toBe('CNY');
    expect(currencyFromText('100元', 'TW')).toBe('TWD');
    expect(currencyFromText('100元', 'HK')).toBe('HKD');
    expect(currencyFromText('100元', null, 'cn')).toBe('CNY');
    expect(currencyFromText('100元', 'US')).toBeNull();
    expect(currencyFromText('₹12,00,000', null)).toBe('INR');
    expect(currencyFromText('100 CHF', null)).toBe('CHF');
    expect(currencyFromText('100', null)).toBeNull();
  });

  it('annualizes in the same currency', () => {
    expect(annualize(50, 'hour')).toBe(104000);
    expect(annualize(300, 'day')).toBe(78000);
    expect(annualize(1000, 'week')).toBe(52000);
    expect(annualize(20000, 'month')).toBe(240000);
    expect(annualize(20000, 'month', 14)).toBe(280000);
    expect(annualize(20000, 'month', 40)).toBe(240000);
    expect(annualize(150000, 'year')).toBe(150000);
    expect(annualize(150000, null)).toBeNull();
    expect(annualize(null, 'year')).toBeNull();
    expect(annualize(5_000_000_000, 'year')).toBeNull();
  });
});

describe('payFromDescription', () => {
  it('reads only pay lines that give a range or a period', () => {
    const desc = [
      'We offer a $2,000 learning stipend and a $5,000 sign-on bonus.',
      'Salary: depends on 2-3 years of experience.',
      'The annual base salary range for this role is $165,000 - $210,000.',
    ].join('\n');
    expect(payFromDescription(desc, { country: 'US' })).toMatchObject({ min: 165000, max: 210000, currency: 'USD', period: 'year' });
  });

  it('falls back to a negotiable statement, else null', () => {
    expect(payFromDescription('工作內容：開發\n待遇：待遇面議（經常性薪資達4萬元或以上）', { country: 'TW' })).toMatchObject({ negotiable: true, text: '待遇面議(經常性薪資達4萬元或以上)' });
    expect(payFromDescription('Great team. Salary: $5,000 bonus', { country: 'US' })).toBeNull();
    expect(payFromDescription('No pay words here', {})).toBeNull();
    expect(payFromDescription(null)).toBeNull();
  });
});

describe('normalizeSalary', () => {
  it('keeps structured provider pay and annualizes it', () => {
    expect(normalizeSalary({ min: 165000, max: 210000, currency: 'usd', period: 'YEAR' })).toEqual({
      salaryMin: 165000,
      salaryMax: 210000,
      salaryCurrency: 'USD',
      salaryPeriod: 'year',
      salarySource: 'provider',
      salaryAnnualMin: 165000,
      salaryAnnualMax: 210000,
      salaryMonths: null,
      salaryDisclosed: true,
      salaryText: null,
    });
  });

  it('keeps a single stated bound single, swaps a reversed range and rounds hourly decimals', () => {
    expect(normalizeSalary({ min: '25.5', period: 'hour', currency: 'USD' })).toMatchObject({ salaryMin: 26, salaryMax: null, salaryAnnualMin: 53040, salaryAnnualMax: null });
    expect(normalizeSalary({ min: 150000, currency: 'USD', period: 'year' })).toMatchObject({ salaryMin: 150000, salaryMax: null, salaryAnnualMax: null, salaryDisclosed: true });
    expect(normalizeSalary({ max: 60, currency: 'USD', period: 'hour' })).toMatchObject({ salaryMin: null, salaryMax: 60, salaryAnnualMin: null, salaryAnnualMax: 124800 });
    expect(normalizeSalary({ min: 200, max: 100, currency: 'USD', period: 'hour' })).toMatchObject({ salaryMin: 100, salaryMax: 200 });
  });

  it('takes the currency from the posting only when the posting states the same figures', () => {
    const description = 'Pay: $38 - $46 per hour.';
    expect(normalizeSalary({ min: 38, max: 46, period: 'HOUR', description, country: 'US' }).salaryCurrency).toBe('USD');
    expect(normalizeSalary({ min: 40, max: 50, period: 'HOUR', description, country: 'US' }).salaryCurrency).toBeNull();
  });

  it('uses CN N薪 from text alongside structured amounts', () => {
    expect(normalizeSalary({ min: 15000, max: 25000, currency: 'CNY', text: '15-25K·14薪', market: 'cn' })).toMatchObject({
      salaryPeriod: 'month',
      salaryMonths: 14,
      salaryAnnualMin: 210000,
      salaryAnnualMax: 350000,
      salaryText: '15-25K·14薪',
    });
  });

  it('parses provider pay text, then description pay lines, as posting_text', () => {
    expect(normalizeSalary({ text: '15-25K·14薪', market: 'cn' })).toMatchObject({ salarySource: 'posting_text', salaryMin: 15000, salaryDisclosed: true });
    expect(normalizeSalary({ description: 'Compensation: £45,000 - £55,000 a year', country: 'GB' })).toMatchObject({ salarySource: 'posting_text', salaryCurrency: 'GBP', salaryAnnualMax: 55000 });
  });

  it('TW-03: 面議 is not disclosed pay; the verbatim text is kept and nothing is estimated', () => {
    const r = normalizeSalary({ text: '待遇面議（經常性薪資達4萬元或以上）', country: 'TW' });
    expect(r).toMatchObject({ salaryDisclosed: false, salaryMin: null, salaryMax: null, salaryAnnualMin: null, salarySource: null });
    expect(r.salaryText).toBe('待遇面議(經常性薪資達4萬元或以上)');
  });

  it('returns no pay when nothing states it', () => {
    expect(normalizeSalary({})).toMatchObject({ salaryDisclosed: false, salaryMin: null, salaryText: null });
    expect(normalizeSalary({ min: 'abc', max: -5 })).toMatchObject({ salaryDisclosed: false });
    expect(normalizeSalary({ min: 120000, currency: 'US Dollars' })).toMatchObject({ salaryCurrency: null, salaryPeriod: null, salaryAnnualMin: null, salaryDisclosed: true });
    expect(normalizeSalary({ min: 10000, currency: 'RMB', period: 'month' }).salaryCurrency).toBe('CNY');
    expect(normalizeSalary({ min: 40000, currency: 'NTD', period: 'month' }).salaryCurrency).toBe('TWD');
  });
});

describe('FIX-3: figures that cannot be pay, and words that are not pay text', () => {
  it('"$60,000K-$90,000K" an hour (60 million dollars an hour) is not stored as an amount; the words are kept', () => {
    // What the provider sent for "Jr. Software Developer": structured fields and the typo they came from.
    const fromFields = normalizeSalary({ min: 60_000_000, max: 90_000_000, currency: 'USD', period: 'hour', text: '$60,000K-$90,000K', country: 'US' });
    expect(fromFields).toMatchObject({ salaryMin: null, salaryMax: null, salaryAnnualMin: null, salaryAnnualMax: null, salaryDisclosed: false, salaryText: '$60,000K-$90,000K' });
    const fromText = normalizeSalary({ text: '$60,000K-$90,000K an hour', country: 'US' });
    expect(fromText).toMatchObject({ salaryMin: null, salaryMax: null, salaryAnnualMax: null, salaryDisclosed: false });
  });

  it.each([
    [{ min: 60_000_000, max: 90_000_000, currency: 'USD', period: 'hour' }, false],
    [{ min: 60_000, max: 90_000, currency: 'USD', period: 'hour' }, false], // $60,000 an hour
    [{ min: 15, max: 15, currency: 'USD', period: 'year' }, false], // $15 a year
    [{ min: 20, max: 65_000, currency: 'USD', period: 'year' }, false], // an hourly and a yearly figure as one range
    [{ min: 60_000, max: 90_000, currency: 'USD', period: 'year' }, true],
    [{ min: 30, max: 45, currency: 'USD', period: 'hour' }, true],
    [{ min: 450, max: 450, currency: 'USD', period: 'hour' }, true], // a senior contractor's rate
    [{ min: 18_000, max: 28_000, currency: 'CNY', period: 'month', months: 15 }, true],
    [{ min: 200, max: 300, currency: 'CNY', period: 'day' }, true],
    [{ min: 40_000, max: 50_000, currency: 'TWD', period: 'month' }, true],
    [{ min: 6_000_000, max: 9_000_000, currency: 'JPY', period: 'year' }, true],
    [{ min: 50_000_000, max: 80_000_000, currency: 'KRW', period: 'year' }, true],
    [{ min: 15_000_000, max: 30_000_000, currency: 'VND', period: 'month' }, true],
    [{ min: 1_200_000, max: 1_200_000, currency: 'INR', period: 'year' }, true],
    [{ min: 120_000, max: null, currency: null, period: null }, true], // unknown currency and period: not judged
    [{ min: 90_000_000_000, max: null, currency: null, period: null }, false],
    [{ min: null, max: null, currency: 'USD', period: 'year' }, true],
  ])('payPlausible(%j) → %s', (pay, expected) => {
    expect(payPlausible(pay)).toBe(expected);
  });

  it('"Competitive Pay and Benefits, …" in a description keeps only the words about pay, and is not a stated amount', () => {
    const desc = 'About the role.\nCompetitive Pay and Benefits, including medical, dental, vision and a 401k match with 15 days of PTO.';
    const parsed = payFromDescription(desc, { country: 'US' });
    expect(parsed).toMatchObject({ negotiable: true, text: 'Competitive Pay' });
    expect(statesAmount(parsed!.text)).toBe(false);
    // Rows stored before this rule: the benefits sentence is not a figure either.
    expect(statesAmount('Competitive Pay and Benefits, including medical, dental, vision and a 401k match')).toBe(false);
    expect(statesAmount('面議')).toBe(false);
    expect(statesAmount('Competitive')).toBe(false);
  });

  it.each(['$60,000K-$90,000K', '$90k–$110k a year', '18-28K·15薪', '待遇面議(經常性薪資達4萬元或以上)', '月薪四萬元以上', '200-300元/天', 'USD 120,000'])('statesAmount(%s) is true', (text) => {
    expect(statesAmount(text)).toBe(true);
  });

  it('a description pay line is kept without its own label (the row is already labelled: "薪资 薪资:18-28K·15薪")', () => {
    expect(payFromDescription('岗位职责：开发\n薪资：18-28K·15薪', { market: 'cn', country: 'CN' })).toMatchObject({ min: 18000, max: 28000, months: 15, text: '18-28K·15薪' });
    expect(normalizeSalary({ description: '任职要求：本科\n薪资：18-28K·15薪', market: 'cn', country: 'CN' }).salaryText).toBe('18-28K·15薪');
    expect(payFromDescription('Salary range: $90,000 - $110,000 a year', { country: 'US' })!.text).toBe('$90,000 - $110,000 a year');
    // A provider's own pay field is kept as given.
    expect(normalizeSalary({ text: '薪资：18-28K·15薪', market: 'cn', country: 'CN' }).salaryText).toBe('薪资:18-28K·15薪');
  });
});

describe('review regressions: no pay from benefit lines (D3)', () => {
  it.each([
    ['Benefits: competitive salary, 401k matching, annual bonus.', 'US'],
    ['We pay a $5,000 signing bonus and annual salary review.', 'US'],
    ['Salary: 3-5 years of experience required, paid annually.', 'US'],
    ['Great team. Salary: $5,000 bonus', 'US'],
    ['Pay: we match your 401(k) and 403b up to 6% annually.', 'US'],
    ['Salary reviews every year; $2,000 monthly housing allowance.', 'US'],
    ['年终奖2-4个月薪资', 'CN'],
    ['薪资：试用期3个月，转正后另议', 'CN'],
  ])('%s → no figure', (description, country) => {
    const r = normalizeSalary({ description, country, market: country === 'CN' ? 'cn' : 'intl' });
    expect(r).toMatchObject({ salaryMin: null, salaryMax: null, salaryAnnualMin: null, salaryAnnualMax: null, salaryDisclosed: false });
  });

  it('still reads real pay clauses, without the bonus or equity clause that follows', () => {
    expect(payFromDescription('Salary: $120k-$150k plus annual bonus', { country: 'US' })).toMatchObject({ min: 120000, max: 150000, currency: 'USD', period: null, text: '$120k-$150k' });
    expect(payFromDescription('Base pay between $90,000 and $110,000 per year, with equity.', { country: 'US' })).toMatchObject({ min: 90000, max: 110000, period: 'year' });
    expect(payFromDescription('USD 150,000 - 180,000 annual base salary', { country: 'US' })).toMatchObject({ min: 150000, max: 180000, currency: 'USD', period: 'year' });
    expect(payFromDescription('岗位职责…\n薪资范围 20-30K，五险一金，年终奖2-4个月', { country: 'CN', market: 'cn' })).toMatchObject({ min: 20000, max: 30000, currency: 'CNY' });
    expect(payFromDescription('待遇：月薪35,000元以上', { country: 'CN' })).toMatchObject({ min: 35000, max: null, period: 'month', currency: 'CNY' });
  });

  it('needs a currency or (in Chinese) a pay unit on the figure, near the pay word', () => {
    expect(payFromDescription('Salary range: 120,000 - 150,000 per year', { country: 'US' })).toBeNull();
    expect(payFromDescription('Salary is reviewed by a committee that meets twice and decides on $90,000 - $110,000 ranges for other teams', { country: 'US' })).toBeNull();
  });

  it('TW-03: the legal-floor scrub never eats the end of a real figure', () => {
    expect(parseSalaryText('面議，年薪 104萬以上', { country: 'TW' })).toMatchObject({ min: 1_040_000, max: null, currency: 'TWD', period: 'year', negotiable: false });
    expect(parseSalaryText('面議，月薪 140,000以上', { country: 'TW' })).toMatchObject({ min: 140_000, period: 'month', negotiable: false });
    expect(parseSalaryText('待遇面議（經常性薪資達4萬元或以上）', { country: 'TW' })).toMatchObject({ min: null, max: null, negotiable: true });
    expect(normalizeSalary({ text: '面議，年薪 104萬以上', country: 'TW' })).toMatchObject({ salaryMin: 1_040_000, salaryMax: null, salaryAnnualMin: 1_040_000, salaryAnnualMax: null });
  });
});

describe('mainland pay as posted (PAR-7; MARKET_STRATEGY §1.5)', () => {
  it("'1.5-2.5万' reads as 15,000-25,000 CNY a month", () => {
    expect(parseSalaryText('1.5-2.5万', { market: 'cn' })).toMatchObject({ min: 15000, max: 25000, currency: 'CNY', period: 'month', months: null });
    expect(normalizeSalary({ text: '1.5-2.5万', market: 'cn', country: 'CN' })).toMatchObject({
      salaryMin: 15000,
      salaryMax: 25000,
      salaryCurrency: 'CNY',
      salaryPeriod: 'month',
      salaryAnnualMin: 180000,
      salaryAnnualMax: 300000,
      salaryDisclosed: true,
      salaryText: '1.5-2.5万',
      salarySource: 'posting_text',
    });
    // The same rule for a mainland posting read by its country alone, and for a K figure on a pay line.
    expect(parseSalaryText('1.5-2.5万', { country: 'CN' })).toMatchObject({ period: 'month', currency: 'CNY' });
    expect(normalizeSalary({ description: '薪资：15-25K', market: 'cn', country: 'CN' })).toMatchObject({ salaryMin: 15000, salaryMax: 25000, salaryPeriod: 'month', salaryCurrency: 'CNY' });
  });

  it("'K·N薪' keeps its months and is shown as posted", () => {
    expect(normalizeSalary({ text: '18-28K·15薪', market: 'cn' })).toMatchObject({
      salaryMin: 18000,
      salaryMax: 28000,
      salaryPeriod: 'month',
      salaryMonths: 15,
      salaryAnnualMin: 270000,
      salaryAnnualMax: 420000,
      salaryText: '18-28K·15薪',
    });
  });

  it('a stated period always wins, and a large 万 figure with no period keeps none (it may be a year)', () => {
    expect(parseSalaryText('30-50万/年', { market: 'cn' })).toMatchObject({ period: 'year' });
    expect(parseSalaryText('30-50万', { market: 'cn' })).toMatchObject({ min: 300000, max: 500000, period: null });
    expect(normalizeSalary({ text: '30-50万', market: 'cn' })).toMatchObject({ salaryMin: 300000, salaryMax: 500000, salaryPeriod: null, salaryAnnualMin: null, salaryAnnualMax: null });
    expect(parseSalaryText('200-300元/天', { market: 'cn' })).toMatchObject({ period: 'day' });
  });

  it.each([
    ['5-8万', 50000, 80000],
    ['6万-9万', 60000, 90000],
    ['8-10万', 80000, 100000],
    // The boundary: a top of exactly 50,000 keeps no period.
    ['3-5万', 30000, 50000],
    ['30-50K', 30000, 50000],
  ])('a figure whose top is 50,000 or more with no period keeps none (it may be a year): %s', (text, min, max) => {
    expect(parseSalaryText(text, { market: 'cn', country: 'CN' })).toMatchObject({ min, max, currency: 'CNY', period: null });
    expect(normalizeSalary({ text, market: 'cn', country: 'CN' })).toMatchObject({ salaryMin: min, salaryMax: max, salaryPeriod: null, salaryAnnualMin: null, salaryAnnualMax: null, salaryText: text });
  });

  it('just under the boundary is still a month, and a stated period decides above it', () => {
    expect(parseSalaryText('3-4.9万', { market: 'cn' })).toMatchObject({ min: 30000, max: 49000, period: 'month' });
    expect(parseSalaryText('5-8万/月', { market: 'cn' })).toMatchObject({ min: 50000, max: 80000, period: 'month' });
    expect(parseSalaryText('年薪5-8万', { market: 'cn' })).toMatchObject({ min: 50000, max: 80000, period: 'year' });
  });

  it("a bare '15-25K' on a mainland row is yuan a month, with no Chinese word in it", () => {
    expect(parseSalaryText('15-25K', { market: 'cn', country: 'CN' })).toMatchObject({ min: 15000, max: 25000, currency: 'CNY', period: 'month' });
    expect(parseSalaryText('15-25K', { market: 'cn' })).toMatchObject({ currency: 'CNY', period: 'month' });
    expect(parseSalaryText('15-25K', { country: 'CN' })).toMatchObject({ currency: 'CNY', period: 'month' });
    // A currency the text names always wins.
    expect(parseSalaryText('USD 15-25K', { market: 'cn', country: 'CN' })).toMatchObject({ currency: 'USD', period: null });
  });

  it('the monthly convention is mainland-only: the same text elsewhere keeps no period', () => {
    expect(parseSalaryText('1.5-2.5万', { market: 'intl', country: 'TW' })).toMatchObject({ currency: 'TWD', period: null });
    expect(parseSalaryText('15-25K', { market: 'intl', country: 'US' })).toMatchObject({ period: null });
  });

  it('a bare number with no unit is not filterable: it is never stored as pay we can compare', () => {
    expect(parseSalaryText('15000-25000', { market: 'cn', country: 'CN' })).toBeNull();
    expect(normalizeSalary({ text: '15000-25000', market: 'cn', country: 'CN' })).toMatchObject({ salaryMin: null, salaryAnnualMin: null, salaryAnnualMax: null, salaryDisclosed: false });
    // Bare provider figures (an ATS field with no currency or period) keep the numbers as stated but no annual figure.
    expect(normalizeSalary({ min: 15000, max: 25000, market: 'cn', country: 'CN' })).toMatchObject({ salaryMin: 15000, salaryMax: 25000, salaryCurrency: null, salaryPeriod: null, salaryAnnualMin: null, salaryAnnualMax: null });
  });

  it('no pay text means salary null: never 面议 unless the posting says it', () => {
    const none = normalizeSalary({ description: '负责后端服务开发。', market: 'cn', country: 'CN' });
    expect(none).toMatchObject({ salaryMin: null, salaryMax: null, salaryDisclosed: false, salaryText: null });
    expect(normalizeSalary({ text: '面议', market: 'cn' })).toMatchObject({ salaryDisclosed: false, salaryText: '面议', salaryMin: null });
  });
});

// ── MKT-1C / JT-1 (MARKET_STRATEGY §1.3, §1.5; JOB_SOURCES_TW §4, §6 items 1 and 6) ──

/** The 台灣就業通 open-data wording for "no figure" (`SALARYCD` when `NT_L` / `NT_U` are '-'). */
const TW_OPEN_DATA_NO_FIGURE = '依學經歷、證照核薪(每月經常性薪資達4萬元以上)';
const TW_OPEN_DATA_NO_FIGURE_FULL_WIDTH = '依學經歷、證照核薪（每月經常性薪資達4萬元以上）';
const NO_PAY = { salaryDisclosed: false, salaryMin: null, salaryMax: null, salaryAnnualMin: null, salaryAnnualMax: null, salaryCurrency: null, salaryPeriod: null, salarySource: null };

describe('JT-1: 台灣就業通 "pay by education and experience" wording is negotiable pay, never a figure', () => {
  it.each([TW_OPEN_DATA_NO_FIGURE, TW_OPEN_DATA_NO_FIGURE_FULL_WIDTH])('%s parses to no figure, negotiable, verbatim text', (text) => {
    expect(parseSalaryText(text, { country: 'TW' })).toEqual({
      min: null,
      max: null,
      currency: null,
      period: null,
      months: null,
      negotiable: true,
      text: TW_OPEN_DATA_NO_FIGURE,
    });
    const r = normalizeSalary({ text, country: 'TW' });
    expect(r).toMatchObject(NO_PAY);
    expect(r.salaryText).toBe(TW_OPEN_DATA_NO_FIGURE);
  });

  it.each(['依學經歷、證照核薪', '依學經歷', '核薪', '依學經歷核薪', '依学经历', '依学经历、证照核薪', '依經歷核薪', '按公司規定'])('"%s" alone is negotiable with no figure', (text) => {
    expect(parseSalaryText(text, { country: 'TW' })).toEqual({ min: null, max: null, currency: null, period: null, months: null, negotiable: true, text });
    expect(normalizeSalary({ text, country: 'TW' })).toMatchObject({ ...NO_PAY, salaryText: text });
  });

  it('a real figure next to the wording is still the pay', () => {
    expect(parseSalaryText('月薪 45,000~60,000，依學經歷核薪', { country: 'TW' })).toMatchObject({ min: 45000, max: 60000, currency: 'TWD', period: 'month', negotiable: false });
    expect(normalizeSalary({ text: '月薪 45,000~60,000，依學經歷核薪', country: 'TW' })).toMatchObject({
      salaryDisclosed: true,
      salaryMin: 45000,
      salaryMax: 60000,
      salaryCurrency: 'TWD',
      salaryPeriod: 'month',
      salaryAnnualMin: 540000,
      salaryAnnualMax: 720000,
    });
    // The open-data adapter (MKT-3E) hands numeric NT_L / NT_U as min / max: they win over the words.
    expect(normalizeSalary({ min: 42000, max: 48000, currency: 'TWD', period: 'month', text: '月薪', country: 'TW' })).toMatchObject({ salaryDisclosed: true, salaryMin: 42000, salaryMax: 48000, salarySource: 'provider' });
  });

  it('核薪 inside another word is not wording about this job\'s pay (核薪方式, 核薪作業, 審核薪資, 考核薪酬)', () => {
    expect(parseSalaryText('核薪方式：月薪', { country: 'TW' })).toBeNull();
    expect(parseSalaryText('經人事審核薪資後通知', { country: 'TW' })).toBeNull();
    expect(parseSalaryText('绩效考核薪资另计', { market: 'cn' })).toBeNull();
    expect(payFromDescription('工作內容：出納\n薪資：經人事審核薪資後通知', { country: 'TW' })).toBeNull();
    expect(parseSalaryText('核薪方式：月薪 38,000元', { country: 'TW' })).toMatchObject({ min: 38000, max: 38000, currency: 'TWD', period: 'month', negotiable: false });
    // Payroll work and pay reviews, in a pay field too.
    for (const text of ['負責員工核薪作業與薪資計算', '核薪人員', '主管負責部門人員考核薪酬調整', '審核薪水', '稽核薪資', '複核薪資', '负责公司绩效考核薪酬体系搭建']) {
      expect(parseSalaryText(text, { country: 'TW' }), text).toBeNull();
      expect(parseSalaryText(text, { market: 'cn' }), text).toBeNull();
    }
  });

  // Review finding: bare 核薪 is also a payroll duty. A job description that lists it as work says nothing about
  // this job's pay, so no pay text is stored for it (D3): before, these gave { negotiable: true, text: '核薪' }.
  it.each([
    '1. 負責每月薪資核算、核薪、勞健保加退保',
    '負責員工核薪作業與薪資計算',
    '主管負責部門人員考核薪酬調整。',
    '人資將審核薪水並核薪',
    '负责公司绩效考核薪酬体系搭建',
    '協助薪資結算與核薪，並維護出勤紀錄',
    '工作內容：核薪、算薪、發薪',
  ])('a duties line is not a pay statement: %s', (description) => {
    for (const opts of [{ country: 'TW' }, { country: 'CN', market: 'cn' as const }, {}]) {
      expect(payFromDescription(description, opts), description).toBeNull();
      expect(normalizeSalary({ description, ...opts }), description).toMatchObject({ ...NO_PAY, salaryText: null });
    }
  });

  it('in a description bare 核薪 counts only on a labelled pay line; the 依學經歷…核薪 phrase counts anywhere', () => {
    for (const line of ['薪資：核薪', '待遇：核薪', '● 待遇：核薪', '2. 薪資：核薪', '- 薪資: 核薪']) {
      expect(payFromDescription(`工作內容：出納\n${line}\n需輪班`, { country: 'TW' }), line).toMatchObject({ negotiable: true, min: null, max: null, text: '核薪' });
    }
    expect(payFromDescription('工作內容：倉儲\n依學經歷核薪\n需輪班', { country: 'TW' })).toMatchObject({ negotiable: true, text: '依學經歷核薪' });
    expect(payFromDescription('工作內容：倉儲\n依學經歷、證照核薪\n需輪班', { country: 'TW' })).toMatchObject({ negotiable: true, text: '依學經歷、證照核薪' });
    // A duties line beside a real pay line: the pay line is read, the duty is not.
    expect(payFromDescription('負責薪資核算、核薪\n待遇：面議', { country: 'TW' })).toMatchObject({ negotiable: true, text: '面議' });
    expect(payFromDescription('負責薪資核算、核薪\n月薪：NT$ 42,000 ~ 48,000', { country: 'TW' })).toMatchObject({ min: 42000, max: 48000, negotiable: false });
    // A duty and the real wording on one line: the stored words are the wording.
    expect(payFromDescription('協助薪資核算與核薪，待遇面議', { country: 'TW' })).toMatchObject({ negotiable: true, text: '待遇面議' });
    // In a pay field (the provider's own pay text) bare 核薪 is the wording.
    expect(parseSalaryText('核薪', { country: 'TW' })).toMatchObject({ negotiable: true, min: null });
  });

  it('in a description bare 依學經歷 counts where its own clause is about pay, not next to a pay word about something else', () => {
    for (const line of ['本公司薪資依學經歷而定', '待遇：依學經歷', '薪資依學經歷另議，享三節獎金', '月薪依學經歷敘薪']) {
      expect(payFromDescription(`工作內容：倉儲\n${line}`, { country: 'TW' }), line).toMatchObject({ negotiable: true, min: null, max: null, text: '依學經歷' });
    }
    for (const line of ['熟悉薪資作業，依學經歷分派職務', '具薪資結算經驗者佳；依學經歷安排職務', '依學經歷分派工作、協助薪資核算']) {
      expect(payFromDescription(`工作內容：人資\n${line}`, { country: 'TW' }), line).toBeNull();
      expect(normalizeSalary({ description: line, country: 'TW' }), line).toMatchObject({ ...NO_PAY, salaryText: null });
    }
  });

  it('a description line that carries the sentence reads the same way', () => {
    const desc = `工作內容：門市銷售與庫存管理\n待遇：${TW_OPEN_DATA_NO_FIGURE_FULL_WIDTH}\n工作時間：日班`;
    expect(payFromDescription(desc, { country: 'TW' })).toEqual({ min: null, max: null, currency: null, period: null, months: null, negotiable: true, text: TW_OPEN_DATA_NO_FIGURE });
    expect(normalizeSalary({ description: desc, country: 'TW' })).toMatchObject({ ...NO_PAY, salaryText: TW_OPEN_DATA_NO_FIGURE });
    // The wording alone, on a line with no other pay word.
    expect(payFromDescription('工作內容：倉儲\n依學經歷核薪\n需輪班', { country: 'TW' })).toMatchObject({ negotiable: true, min: null, max: null, text: '依學經歷核薪' });
    // A figure on another line still wins over the wording.
    expect(payFromDescription('依學經歷核薪\n月薪：NT$ 42,000 ~ 48,000', { country: 'TW' })).toMatchObject({ min: 42000, max: 48000, negotiable: false });
  });
});

describe('JT-1: the Art. 5 floor clause is recognised at any threshold', () => {
  const WORDINGS = ['待遇面議', '面議', '依公司規定', '依學經歷、證照核薪'];
  const AMOUNTS: Array<[label: string, amount: string, value: number]> = [
    ['4萬', '4萬', 40_000],
    ['5萬', '5萬', 50_000],
    ['6萬', '6萬', 60_000],
    ['7萬', '7萬', 70_000],
    ['8萬', '8萬', 80_000],
    ['9萬', '9萬', 90_000],
    ['5万 (Simplified)', '5万', 50_000],
    ['四萬', '四萬', 40_000],
    ['五萬', '五萬', 50_000],
    ['九萬', '九萬', 90_000],
    ['40,000', '40,000', 40_000],
    ['50,000', '50,000', 50_000],
    ['90,000', '90,000', 90_000],
    ['50000 (no comma)', '50000', 50_000],
    ['full-width ５萬', '５萬', 50_000],
    ['full-width ５０，０００', '５０，０００', 50_000],
  ];
  const clauses = (amount: string): string[] => [
    `（經常性薪資達${amount}元或以上）`,
    `(經常性薪資達 ${amount} 元以上)`,
    `（每月經常性薪資達${amount}元以上）`,
    `，月薪${amount}以上`,
    `（經常性薪資${amount}元（含）以上）`,
  ];

  describe.each(AMOUNTS)('threshold %s', (_label, amount, value) => {
    it.each(WORDINGS.flatMap((w) => clauses(amount).map((c) => `${w}${c}`)))('negotiable: %s has no figure', (text) => {
      const p = parseSalaryText(text, { country: 'TW' });
      expect(p).toMatchObject({ min: null, max: null, currency: null, period: null, negotiable: true });
      expect(p!.text).toBe(text.normalize('NFKC').slice(0, 80));
      expect(normalizeSalary({ text, country: 'TW' })).toMatchObject(NO_PAY);
    });

    it('not negotiable: the same amount stated as monthly pay is a disclosed minimum', () => {
      // Chinese numerals are not read as a figure by the pay parser (no digits): nothing is stored, and nothing is invented.
      const digits = /\d/.test(amount.normalize('NFKC'));
      const p = parseSalaryText(`月薪 ${amount}以上`, { country: 'TW' });
      if (digits) expect(p).toMatchObject({ min: value, max: null, currency: 'TWD', period: 'month', negotiable: false });
      else expect(p).toBeNull();
    });
  });

  it("the acceptance sentence: '待遇面議（經常性薪資達5萬元或以上）' is no figure and negotiable", () => {
    expect(parseSalaryText('待遇面議（經常性薪資達5萬元或以上）', { country: 'TW' })).toEqual({
      min: null,
      max: null,
      currency: null,
      period: null,
      months: null,
      negotiable: true,
      text: '待遇面議(經常性薪資達5萬元或以上)',
    });
  });

  it('a non-negotiable 月薪 5萬以上 stays a disclosed minimum of 50,000', () => {
    expect(parseSalaryText('月薪 5萬以上', { country: 'TW' })).toMatchObject({ min: 50_000, max: null, currency: 'TWD', period: 'month', negotiable: false });
    expect(normalizeSalary({ text: '月薪5萬以上', country: 'TW' })).toMatchObject({ salaryDisclosed: true, salaryMin: 50_000, salaryMax: null, salaryAnnualMin: 600_000 });
    expect(normalizeSalary({ text: '月薪 50,000 元以上', country: 'TW' })).toMatchObject({ salaryDisclosed: true, salaryMin: 50_000, salaryMax: null });
  });

  it('the look-behind guards: a figure that only ends like a threshold is a real figure', () => {
    expect(parseSalaryText('面議，年薪 104萬以上', { country: 'TW' })).toMatchObject({ min: 1_040_000, max: null, period: 'year', negotiable: false });
    expect(parseSalaryText('面議，年薪 105萬以上', { country: 'TW' })).toMatchObject({ min: 1_050_000, max: null, period: 'year', negotiable: false });
    expect(parseSalaryText('面議，月薪 140,000以上', { country: 'TW' })).toMatchObject({ min: 140_000, period: 'month', negotiable: false });
    expect(parseSalaryText('面議，月薪 150,000以上', { country: 'TW' })).toMatchObject({ min: 150_000, period: 'month', negotiable: false });
    expect(parseSalaryText('面議，月薪 4.5萬以上', { country: 'TW' })).toMatchObject({ min: 45_000, period: 'month', negotiable: false });
    expect(parseSalaryText('面議，月薪 45,000以上', { country: 'TW' })).toMatchObject({ min: 45_000, period: 'month', negotiable: false });
    expect(parseSalaryText('面議，年薪 十五萬以上', { country: 'TW' })).toMatchObject({ negotiable: true, min: null });
  });

  it('the top of a stated range is never taken for the clause', () => {
    expect(parseSalaryText('面議，月薪 4萬~5萬以上', { country: 'TW' })).toMatchObject({ min: 40_000, max: 50_000, period: 'month', negotiable: false });
    expect(parseSalaryText('面議，月薪 40,000~60,000以上', { country: 'TW' })).toMatchObject({ min: 40_000, max: 60_000, negotiable: false });
    expect(parseSalaryText('依公司規定，月薪 3萬至5萬以上', { country: 'TW' })).toMatchObject({ min: 30_000, max: 50_000, negotiable: false });
    // 達到 is the clause's own verb, not a range.
    expect(parseSalaryText('面議（經常性薪資達到5萬元以上）', { country: 'TW' })).toMatchObject({ min: null, max: null, negotiable: true });
  });

  it('the threshold is never a job\'s pay: no path stores it for a negotiable posting', () => {
    for (const amount of ['4萬', '5萬', '50,000', '６萬']) {
      const text = `待遇面議（經常性薪資達${amount}元或以上）`;
      for (const r of [
        normalizeSalary({ text, country: 'TW' }),
        normalizeSalary({ description: `工作內容：開發\n待遇：${text}`, country: 'TW' }),
        normalizeSalary({ text, description: `待遇：${text}`, country: 'TW', market: 'intl' }),
      ]) {
        expect(r, amount).toMatchObject(NO_PAY);
        expect(r.salaryText, amount).toBe(text.normalize('NFKC'));
      }
    }
  });

  // Review finding: the clause on its own line or sentence of a description has no wording beside it. It was
  // read as a stated minimum (NT$40,000 a month, salaryAnnualMin 480,000).
  it.each([
    ['薪資：依學經歷、證照核薪\n（每月經常性薪資達4萬元以上）', '依學經歷、證照核薪'],
    ['待遇面議。 每月經常性薪資達4萬元以上。', '待遇面議'],
    ['待遇：面議\n月薪達5萬元以上', '面議'],
    // The clause first, the wording on a later line.
    ['月薪達5萬元以上\n待遇：面議', '面議'],
    ['（每月經常性薪資達4萬元以上）\n薪資：依學經歷、證照核薪', '(每月經常性薪資達4萬元以上)'],
    // Other lines in between.
    ['待遇：面議\n工作時間：日班\n上班地點：台北市\n經常性薪資達 50,000 元以上', '面議'],
    // The clause in the same line as a second sentence, and in a clause of its own after a comma.
    ['薪資：面議；經常性薪資達4萬元以上', '面議;經常性薪資達4萬元以上'],
    ['待遇面議，月薪NT$40,000以上，享勞健保', '待遇面議,月薪NT$40,000以上'],
  ])('a description never stores the clause when it stands on its own line or sentence: %j', (description, words) => {
    expect(payFromDescription(description, { country: 'TW' })).toEqual({ min: null, max: null, currency: null, period: null, months: null, negotiable: true, text: words });
    expect(normalizeSalary({ description, country: 'TW' })).toMatchObject({ ...NO_PAY, salaryText: words });
    // The same posting on a GoApply row for a job in Taiwan.
    expect(normalizeSalary({ description, country: 'TW', market: 'cn' })).toMatchObject(NO_PAY);
  });

  it('the statute\'s own clause is "pay not listed" wherever it stands, with or without wording beside it', () => {
    for (const text of ['每月經常性薪資達4萬元以上', '（每月經常性薪資達4萬元以上）', '經常性薪資達5萬元或以上', '經常性薪資：4萬元以上', '經常性薪資達新台幣 50,000 元（含）以上']) {
      for (const opts of [{ country: 'TW' }, { country: 'TW', market: 'cn' as const }, { market: 'cn' as const }, { country: 'CN', market: 'cn' as const }, { country: 'US' }, {}]) {
        expect(parseSalaryText(text, opts), text).toMatchObject({ min: null, max: null, currency: null, period: null, negotiable: true });
        expect(normalizeSalary({ text, ...opts }), text).toMatchObject({ ...NO_PAY, salaryText: text.normalize('NFKC') });
        expect(normalizeSalary({ description: `薪資：${text}`, ...opts }), text).toMatchObject(NO_PAY);
        expect(normalizeSalary({ description: `工作內容：開發\n${text}`, ...opts }), text).toMatchObject(NO_PAY);
      }
    }
    // A real figure beside it is still the pay.
    expect(parseSalaryText('月薪 45,000~60,000（經常性薪資達4萬元以上）', { country: 'TW' })).toMatchObject({ min: 45000, max: 60000, currency: 'TWD', period: 'month', negotiable: false });
    expect(payFromDescription('月薪：NT$ 45,000 ~ 60,000\n（經常性薪資達4萬元以上）', { country: 'TW' })).toMatchObject({ min: 45000, max: 60000, negotiable: false });
  });

  // Review finding (high, M1 gate): the clause was recognised only when 以上 followed the amount directly. A
  // job board's negotiable wording with a period marker ("4萬/月含以上"), an unbracketed 含, or no 以上 at all
  // was stored as a disclosed NT$40,000 minimum (salaryAnnualMin 480,000): the claim JT-1 forbids.
  it.each([
    ['面議（經常性薪資4萬/月含以上）', '面議(經常性薪資4萬/月含以上)'],
    ['面議（經常性薪資5萬/月含以上）', '面議(經常性薪資5萬/月含以上)'],
    ['依公司規定（經常性薪資4萬/月含以上）', '依公司規定(經常性薪資4萬/月含以上)'],
    ['面議（經常性薪資達4萬元/月以上）', '面議(經常性薪資達4萬元/月以上)'],
    ['待遇面議（經常性薪資達40,000元／月（含）以上）', '待遇面議(經常性薪資達40,000元/月(含)以上)'],
    ['面議（經常性薪資達4萬元）', '面議(經常性薪資達4萬元)'],
    ['面議（經常性薪資達 40,000 元）', '面議(經常性薪資達 40,000 元)'],
  ])('the clause with a period marker, an unbracketed 含 or no 以上 is never a figure: %s', (text, words) => {
    for (const opts of [{ country: 'TW', market: 'intl' as const }, { country: 'TW', market: 'cn' as const }, { country: null, market: 'intl' as const }, { market: 'cn' as const }]) {
      expect(parseSalaryText(text, opts), JSON.stringify(opts)).toMatchObject({ min: null, max: null, currency: null, period: null, negotiable: true });
      expect(normalizeSalary({ text, ...opts }), JSON.stringify(opts)).toMatchObject({ ...NO_PAY, salaryText: words });
      expect(normalizeSalary({ description: `工作內容：開發\n【薪資待遇】${text}`, ...opts }), JSON.stringify(opts)).toMatchObject(NO_PAY);
      expect(payFromDescription(`【薪資待遇】${text}`, opts), JSON.stringify(opts)).toMatchObject({ min: null, max: null, negotiable: true });
    }
  });

  it('the statute\'s clause with a period marker stands alone as "pay not listed"; without 以上 it needs the wording beside it', () => {
    for (const text of ['經常性薪資4萬/月含以上', '每月經常性薪資達4萬元/月以上', '經常性薪資5萬元含以上']) {
      expect(parseSalaryText(text, { country: 'TW' }), text).toMatchObject({ min: null, max: null, negotiable: true });
      expect(normalizeSalary({ text, market: 'cn' }), text).toMatchObject(NO_PAY);
    }
    // No 以上 and no "pay not listed" wording: the posting states an amount, and it stays one.
    expect(parseSalaryText('經常性薪資5萬元', { country: 'TW' })).toMatchObject({ min: 50000, max: 50000, currency: 'TWD', negotiable: false });
    expect(parseSalaryText('每月經常性薪資 40,000 元', { country: 'TW' })).toMatchObject({ min: 40000, currency: 'TWD', negotiable: false });
    // A range or a longer amount that only starts like the threshold is a figure, with or without the wording.
    expect(parseSalaryText('面議，經常性薪資4萬~6萬', { country: 'TW' })).toMatchObject({ min: 40000, max: 60000, negotiable: false });
    expect(parseSalaryText('面議，經常性薪資 40,000~60,000 元', { country: 'TW' })).toMatchObject({ min: 40000, max: 60000, negotiable: false });
    expect(parseSalaryText('經常性薪資4萬至5萬元/月', { country: 'TW' })).toMatchObject({ min: 40000, max: 50000, negotiable: false });
    // "月薪4萬" with no 以上 and no statute term was never the clause and is not now.
    expect(parseSalaryText('面議，月薪4萬', { country: 'TW' })).toMatchObject({ min: 40000, negotiable: false });
    expect(parseSalaryText('面議，月薪4萬/月', { country: 'TW' })).toMatchObject({ min: 40000, negotiable: false });
  });

  // Review finding (high): the clause is decided by where the job is and by its own words, not by the market.
  // A GoHire row (market cn) for a job in Taipei, and a mainland row of unknown country, carried NT$40,000
  // (or ¥40,000 a month) as disclosed pay.
  it('where the job is decides, not the market: a Taiwan job on a GoApply row never gets the threshold as pay', () => {
    for (const text of ['待遇面議（經常性薪資達4萬元或以上）', '依學經歷、證照核薪(每月經常性薪資達4萬元以上)', '薪资面议（经常性薪资达5万元以上）']) {
      for (const opts of [
        { country: 'TW', market: 'cn' as const },
        { country: null, market: 'cn' as const },
        { country: 'CN', market: 'cn' as const },
        { country: 'TW', market: 'intl' as const },
        { country: null, market: 'intl' as const },
        { country: 'HK' },
      ]) {
        expect(parseSalaryText(text, opts), `${text} ${JSON.stringify(opts)}`).toMatchObject({ min: null, max: null, currency: null, period: null, negotiable: true });
        expect(normalizeSalary({ text, ...opts }), text).toMatchObject(NO_PAY);
      }
    }
    // A Taiwan-dollar marker: the clause in any market, next to the wording.
    for (const opts of [{ market: 'cn' as const }, { country: 'CN', market: 'cn' as const }, { country: 'TW', market: 'cn' as const }, { country: 'US' }, {}]) {
      expect(parseSalaryText('待遇面議 (月薪NT$40,000以上)', opts)).toMatchObject({ min: null, max: null, negotiable: true });
      expect(parseSalaryText('面議，月薪新台幣5萬元以上', opts)).toMatchObject({ min: null, max: null, negotiable: true });
      expect(parseSalaryText('面議，月薪台幣5萬以上', opts)).toMatchObject({ min: null, max: null, negotiable: true });
    }
    // The bare form: the clause for a job in Taiwan (in either market) and on an international row of unknown country.
    for (const opts of [{ country: 'TW' }, { country: 'TW', market: 'cn' as const }, { country: 'tw' }, {}, { country: null, market: 'intl' as const }]) {
      expect(parseSalaryText('面議，月薪5萬以上', opts), JSON.stringify(opts)).toMatchObject({ min: null, max: null, negotiable: true });
      expect(parseSalaryText('薪资面议，月薪5万以上', opts), JSON.stringify(opts)).toMatchObject({ min: null, max: null, negotiable: true });
      expect(parseSalaryText('面議，月薪 $40,000 以上', opts), JSON.stringify(opts)).toMatchObject({ min: null, max: null, negotiable: true });
    }
  });

  it('the clause is Taiwan law: a mainland posting\'s minimum next to 面议 is still its minimum', () => {
    expect(parseSalaryText('薪资面议，月薪5万以上', { market: 'cn', country: 'CN' })).toMatchObject({ min: 50_000, max: null, currency: 'CNY', period: 'month', negotiable: false });
    expect(parseSalaryText('薪资面议，月薪5万以上', { market: 'cn' })).toMatchObject({ min: 50_000, max: null, currency: 'CNY', period: 'month', negotiable: false });
    expect(parseSalaryText('薪资面议，月薪5万以上', { country: 'CN' })).toMatchObject({ min: 50_000, max: null, currency: 'CNY', period: 'month', negotiable: false });
    expect(parseSalaryText('面议，月薪 40,000 元以上', { market: 'cn' })).toMatchObject({ min: 40_000, max: null, currency: 'CNY', period: 'month', negotiable: false });
    expect(payFromDescription('待遇：面议\n月薪5万以上', { country: 'CN', market: 'cn' })).toMatchObject({ min: 50_000, currency: 'CNY', period: 'month', negotiable: false });
    // The same words on a Taiwan row are the clause.
    expect(parseSalaryText('面議，月薪5萬以上', { market: 'intl', country: 'TW' })).toMatchObject({ min: null, max: null, negotiable: true });
  });

  // Review finding: an amount in another currency, per year, or on a row known to be elsewhere cannot be the
  // clause (a month's regular wage in Taiwan dollars). These lost their figure.
  it('an amount in another currency, for another period, or for a job elsewhere is a real minimum', () => {
    expect(parseSalaryText('薪金面議，月薪 HK$40,000 以上', { country: 'HK' })).toMatchObject({ min: 40_000, max: null, currency: 'HKD', period: 'month', negotiable: false });
    expect(parseSalaryText('面議，年薪 USD 60,000 以上', { country: 'TW' })).toMatchObject({ min: 60_000, max: null, currency: 'USD', period: 'year', negotiable: false });
    expect(parseSalaryText('面議，月薪5萬以上', { country: 'HK' })).toMatchObject({ min: 50_000, max: null, currency: 'HKD', period: 'month', negotiable: false });
    // Other currencies and periods, on a Taiwan row.
    expect(parseSalaryText('面議，月薪 USD 5萬以上', { country: 'TW' })).toMatchObject({ min: 50_000, currency: 'USD', negotiable: false });
    expect(parseSalaryText('面議，月薪 US$ 5萬以上', { country: 'TW' })).toMatchObject({ min: 50_000, negotiable: false });
    expect(parseSalaryText('面議，月薪 RMB 40,000 以上', { country: 'TW' })).toMatchObject({ min: 40_000, currency: 'CNY', period: 'month', negotiable: false });
    expect(parseSalaryText('面議，月薪 HKD 50,000 以上', { country: 'TW' })).toMatchObject({ min: 50_000, currency: 'HKD', negotiable: false });
    expect(parseSalaryText('面議，月薪美金 4萬以上', { country: 'TW' })).toMatchObject({ min: 40_000, currency: 'USD', negotiable: false });
    expect(parseSalaryText('面議，年薪 90,000 以上', { country: 'TW' })).toMatchObject({ min: 90_000, currency: 'TWD', period: 'year', negotiable: false });
    expect(parseSalaryText('面議，年薪達 90,000 元以上', { country: 'TW' })).toMatchObject({ min: 90_000, period: 'year', negotiable: false });
    // Jobs known to be elsewhere: Macau, Singapore, the United States.
    expect(parseSalaryText('面議，月薪4萬以上', { country: 'MO' })).toMatchObject({ min: 40_000, currency: 'MOP', negotiable: false });
    expect(parseSalaryText('Negotiable, S$ 5萬以上', { country: 'SG' })).toMatchObject({ min: 50_000, currency: 'SGD', negotiable: false });
    expect(parseSalaryText('面議，月薪5萬以上', { country: 'US' })).toMatchObject({ min: 50_000, negotiable: false });
    // A period word earlier in the text does not shield the clause that follows the wording.
    expect(parseSalaryText('時薪面議，月薪4萬以上', { country: 'TW' })).toMatchObject({ min: null, max: null, negotiable: true });
    expect(parseSalaryText('年薪面議（經常性薪資達4萬元以上）', { country: 'TW' })).toMatchObject({ min: null, max: null, negotiable: true });
    // The Taiwan reading the item asks for is unchanged: a round monthly amount next to the wording is the clause.
    expect(parseSalaryText('面議，月薪 60,000 以上', { country: 'TW' })).toMatchObject({ min: null, max: null, negotiable: true });
  });

  it('a description line keeps the wording with its clause, whatever the threshold', () => {
    expect(payFromDescription('工作內容：開發\n待遇：待遇面議（經常性薪資達5萬元或以上）', { country: 'TW' })).toMatchObject({ negotiable: true, text: '待遇面議(經常性薪資達5萬元或以上)' });
    expect(payFromDescription('薪資：面議，經常性薪資達 50,000 元以上。其他福利另議', { country: 'TW' })).toMatchObject({ negotiable: true, min: null, text: '面議,經常性薪資達 50,000 元以上' });
  });
});
