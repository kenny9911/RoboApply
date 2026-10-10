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
