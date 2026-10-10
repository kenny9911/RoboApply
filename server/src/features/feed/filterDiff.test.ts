// @vitest-environment node
// WP-32: deterministic filter-diff proposals per hide reason, relaxations, and the NL plan → filters mapping.

import { describe, expect, it } from 'vitest';
import { HIDE_REASONS } from './contract.js';
import { extractPayFloor, hideProposal, planToFilters, relaxations, toDiff, type HideJobFacts } from './filterDiff.js';

const job: HideJobFacts = {
  title: 'Sales Engineer',
  companyName: 'Acme Inc.',
  seniority: 'senior',
  salaryDisclosed: true,
  salaryMin: 90000,
  salaryMax: 110500,
  salaryCurrency: 'USD',
  salaryPeriod: 'year',
};

describe('hide proposals (one per reason)', () => {
  it('covers every reason deterministically', () => {
    const out = Object.fromEntries(HIDE_REASONS.map((r) => [r, hideProposal(r, job, { seniority: ['mid', 'senior'] })]));
    expect(out).toMatchSnapshot();
  });

  it('company → excludedCompanies; title → excludedTitles', () => {
    expect(hideProposal('company', job, {}).after).toEqual({ excludedCompanies: ['Acme Inc.'] });
    expect(hideProposal('wrong_title', job, { excludedTitles: ['Recruiter'] }).after).toEqual({ excludedTitles: ['Recruiter', 'Sales Engineer'] });
  });

  it('wrong level removes the job level (all levels but it when none is set); unknown level opens the editor', () => {
    expect(hideProposal('wrong_level', job, {}).after?.seniority).toEqual(['intern_newgrad', 'entry', 'mid', 'lead_staff', 'director_exec']);
    expect(hideProposal('wrong_level', { ...job, seniority: null }, {})).toEqual({ after: null, editor: 'seniority' });
    expect(hideProposal('wrong_level', job, { seniority: ['senior'] })).toEqual({ after: null, editor: 'seniority' });
  });

  it('pay too low raises the floor above this job (tidy step); undisclosed pay offers "only jobs that list pay"', () => {
    expect(hideProposal('pay_too_low', job, {}).after?.salaryMin).toEqual({ amount: 111000, currency: 'USD', period: 'year' });
    expect(hideProposal('pay_too_low', { ...job, salaryPeriod: 'month', salaryMax: 15000, salaryCurrency: 'CNY' }, {}).after?.salaryMin).toEqual({ amount: 15100, currency: 'CNY', period: 'month' });
    expect(hideProposal('pay_too_low', { ...job, salaryDisclosed: false }, {}).after).toEqual({ includeUndisclosedPay: false });
    expect(hideProposal('pay_too_low', job, { salaryMin: { amount: 200000, currency: 'USD', period: 'year' } }).after).toBeNull();
  });

  it('location opens the location editor; not interested / other / already applied change nothing', () => {
    expect(hideProposal('wrong_location', job, {})).toEqual({ after: null, editor: 'location' });
    for (const r of ['not_interested', 'other', 'already_applied'] as const) expect(hideProposal(r, job, {})).toEqual({ after: null, editor: null });
  });
});

describe('toDiff', () => {
  it('list items become add/remove ops, scalars set, removals null; the patch carries whole fields', () => {
    const d = toDiff({ excludedCompanies: ['A'], salaryMin: { amount: 1, currency: 'USD', period: 'year' }, excludeAgencies: true }, { excludedCompanies: ['A', 'B'], postedWithinDays: 7 });
    expect(d.ops).toEqual([
      { op: 'set', path: 'postedWithinDays', value: 7 },
      { op: 'set', path: 'salaryMin', value: null },
      { op: 'add', path: 'excludedCompanies', value: 'B' },
      { op: 'set', path: 'excludeAgencies', value: null },
    ]);
    expect(d.patch).toEqual({ excludedCompanies: ['A', 'B'], postedWithinDays: 7, salaryMin: null, excludeAgencies: null });
  });
});

describe('relaxations', () => {
  it('one candidate per active SQL filter; the view filter and boosts are skipped', () => {
    const r = relaxations({ workModels: ['remote'], country: 'US', fitTier: 'great', preferredCompanies: ['X'], includeUndisclosedPay: false, excludeAgencies: true });
    expect(r.map((x) => x.field).sort()).toEqual(['country', 'excludeAgencies', 'includeUndisclosedPay', 'workModels']);
    expect(r.find((x) => x.field === 'workModels')?.relaxed).toEqual({ country: 'US', fitTier: 'great', preferredCompanies: ['X'], includeUndisclosedPay: false, excludeAgencies: true });
    expect(r.find((x) => x.field === 'includeUndisclosedPay')?.relaxed.includeUndisclosedPay).toBeUndefined();
  });
});

describe('NL plan → filters', () => {
  it('"remote data jobs in Berlin paying over €70k"', () => {
    const { patch, unmatched } = planToFilters(
      { queries: ['Data Analyst'], location: 'Berlin', country: 'de', remote: true, unverifiedPreferences: ['paying over €70k', 'friendly team culture'] },
      'remote data jobs in Berlin paying over €70k',
      'intl',
    );
    expect(patch).toMatchObject({
      titles: ['Data Analyst'],
      country: 'DE',
      workModels: ['remote'],
      salaryMin: { amount: 70000, currency: 'EUR', period: 'year' },
    });
    expect(patch.locations?.[0]).toMatchObject({ label: 'Berlin', city: 'Berlin', country: 'DE', radiusKm: 40 });
    expect(unmatched).toEqual(['friendly team culture']);
  });

  it('sponsorship and agency exclusions are mapped; GoApply drops intl-only fields', () => {
    const intl = planToFilters({ queries: ['Nurse'], unverifiedPreferences: ['needs visa sponsorship', 'no staffing agencies'] }, 'nurse', 'intl');
    expect(intl.patch).toMatchObject({ needsSponsorship: true, excludeAgencies: true });
    const cn = planToFilters({ queries: ['产品经理'], unverifiedPreferences: ['需要签证担保'] }, '产品经理 月薪2万以上', 'cn');
    expect(cn.patch.needsSponsorship).toBeUndefined();
    expect(cn.patch.salaryMin).toEqual({ amount: 20000, currency: 'CNY', period: 'month' });
  });

  it('date posted and employment types', () => {
    const { patch } = planToFilters({ queries: ['Designer'], datePosted: 'week', employmentTypes: ['contract'], unverifiedPreferences: [] }, 'designer', 'intl');
    expect(patch).toMatchObject({ postedWithinDays: 7, jobTypes: ['contract'] });
  });

  it('pay extraction ignores numbers that are not pay', () => {
    expect(extractPayFloor('3 years of Python', 'intl')).toBeNull();
    expect(extractPayFloor('at least $180,000 a year', 'intl')).toEqual({ amount: 180000, currency: 'USD', period: 'year' });
    expect(extractPayFloor('$45 per hour or more', 'intl')).toEqual({ amount: 45, currency: 'USD', period: 'hour' });
    expect(extractPayFloor('salary 90k', 'intl')).toBeNull();
    expect(extractPayFloor('salary 90k USD', 'intl')).toEqual({ amount: 90000, currency: 'USD', period: 'year' });
    expect(extractPayFloor('at least 3 years', 'intl')).toBeNull();
    expect(extractPayFloor('$5,000 monthly', 'intl')).toEqual({ amount: 5000, currency: 'USD', period: 'month' });
    expect(extractPayFloor('$300 a day', 'intl')).toEqual({ amount: 78000, currency: 'USD', period: 'year' });
  });

  it('GoApply: a number is pay only with a pay word or money marker; experience and days are not pay', () => {
    expect(extractPayFloor('至少3年经验', 'cn')).toBeNull();
    expect(extractPayFloor('每周至少4天', 'cn')).toBeNull();
    expect(extractPayFloor('8000以上', 'cn')).toBeNull();
    expect(extractPayFloor('至少3个月', 'cn')).toBeNull();
    expect(extractPayFloor('薪资8000以上', 'cn')).toEqual({ amount: 8000, currency: 'CNY', period: 'month' });
    expect(extractPayFloor('月薪2万以上', 'cn')).toEqual({ amount: 20000, currency: 'CNY', period: 'month' });
    expect(extractPayFloor('15k/month', 'cn')).toEqual({ amount: 15000, currency: 'CNY', period: 'month' });
    expect(extractPayFloor('年薪30万', 'cn')).toEqual({ amount: 300000, currency: 'CNY', period: 'year' });
    expect(extractPayFloor('20万年薪', 'cn')).toEqual({ amount: 200000, currency: 'CNY', period: 'year' });
    expect(extractPayFloor('8000元/月', 'cn')).toEqual({ amount: 8000, currency: 'CNY', period: 'month' });
    // Below a believable monthly wage: not a floor.
    expect(extractPayFloor('月薪300', 'cn')).toBeNull();
    // A day rate is a 元/天 floor on GoApply, not a monthly one.
    expect(extractPayFloor('日薪200以上', 'cn')).toBeNull();
  });

  it('GoApply: experience and intern days reach `unmatched`; a day rate becomes the 元/天 filter', () => {
    const { patch, unmatched } = planToFilters(
      { queries: ['数据分析实习生'], unverifiedPreferences: ['至少3年经验', '每周至少4天', '日薪200以上'] },
      '数据分析实习生 至少3年经验 每周至少4天 日薪200以上',
      'cn',
    );
    expect(patch.salaryMin).toBeUndefined();
    expect(patch.dailyPay).toEqual({ min: 200 });
    expect(unmatched).toEqual(['至少3年经验', '每周至少4天']);
    const raw = planToFilters({ queries: ['实习生'], unverifiedPreferences: [] }, '实习生 200元/天', 'cn');
    expect(raw.patch.dailyPay).toEqual({ min: 200 });
    expect(planToFilters({ queries: ['实习生'], unverifiedPreferences: [] }, '实习生 至少3年经验', 'cn').patch.salaryMin).toBeUndefined();
  });
});
