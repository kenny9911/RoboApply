// @vitest-environment node
// WP-32: deterministic filter-diff proposals per hide reason, relaxations, and the NL plan → filters mapping.

import { describe, expect, it } from 'vitest';
import { FEED_RELEVANCE_MAX_CHARS, FeedRelevanceSchema, HIDE_REASONS } from './contract.js';
import { RANKED_BY_MAX_CHARS, RANKED_BY_MAX_TERMS, extractPayFloor, hideProposal, isConstraintPhrase, planToFilters, relaxations, toDiff, type HideJobFacts } from './filterDiff.js';

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

describe('NL plan → rankedBy (topics a list may be ordered by, never filters; MKT-2H)', () => {
  it('"backend jobs at climate startups using Rust, salary above 150k": the topics, never the pay phrase', () => {
    const { patch, unmatched, rankedBy } = planToFilters(
      { queries: ['Backend Engineer'], unverifiedPreferences: ['climate startups', 'using Rust', 'salary above 150k'] },
      'backend jobs at climate startups using Rust, salary above 150k',
      'intl',
    );
    expect(rankedBy).toEqual(['climate startups', 'Rust']);
    // The pay phrase names no currency, so it is not a filter either: it stays unmatched, a requirement nobody checked.
    expect(patch.salaryMin).toBeUndefined();
    expect(unmatched).toEqual(['climate startups', 'using Rust', 'salary above 150k']);
  });

  it("uses the planner's own relevance terms when it gives any", () => {
    const { rankedBy, unmatched } = planToFilters(
      { queries: ['Backend Engineer'], unverifiedPreferences: ['at a climate-focused company', 'salary above 150k'], relevanceTerms: [' climate tech ', 'Rust', 'rust', ''] },
      'backend jobs',
      'intl',
    );
    expect(rankedBy).toEqual(['climate tech', 'Rust']);
    expect(unmatched).toEqual(['at a climate-focused company', 'salary above 150k']);
    // An empty list is "none given": the topics are derived.
    expect(planToFilters({ queries: ['X'], unverifiedPreferences: ['fintech'], relevanceTerms: [] }, 'x', 'intl').rankedBy).toEqual(['fintech']);
  });

  it('a phrase about pay, visa, benefits, hours, time zone or commute is a requirement, not a topic', () => {
    const constraints = [
      'salary above 150k', 'paying at least 90k', 'good equity', 'strong bonus',
      'visa sponsorship for later', 'must not need a work permit', 'H-1B transfer',
      'great benefits', 'unlimited PTO', 'health insurance', 'generous vacation',
      'flexible hours', 'no weekends', '4-day week', 'four days a week',
      'overlap with the EST time zone', 'UTC+1 timezone',
      'short commute', 'near me', '30 minutes from home', 'open to relocation',
      '薪资 20k 以上', '需要签证担保', '五险一金', '不加班 双休', '每周至少4天', '时区 UTC+8', '通勤 30 分钟以内', '地铁附近',
    ];
    for (const phrase of constraints) expect(isConstraintPhrase(phrase), phrase).toBe(true);
    const { rankedBy, unmatched } = planToFilters({ queries: ['Designer'], unverifiedPreferences: constraints.slice(0, 12) }, 'designer', 'intl');
    expect(rankedBy).toEqual([]);
    // They are still told to the user as not checked.
    expect(unmatched.length).toBeGreaterThan(0);
  });

  it('a topic is not mistaken for a requirement', () => {
    for (const phrase of ['climate startups', 'payments infrastructure', 'Rust', 'developer tools', 'series B fintech', 'open source', '新能源行业', '游戏公司', 'machine learning platform', 'estimation tooling', 'healthcare data', 'insurance companies', 'private equity', 'pension funds', "c'est une startup"]) {
      expect(isConstraintPhrase(phrase), phrase).toBe(false);
    }
  });

  it('words that are pay, hours or commute in one wording and a field of work in another are told apart', () => {
    const topics = [
      'equity research', 'equity derivatives', 'paid social', 'paid media', 'paid search campaigns', 'shift-left testing', 'schedule optimization', 'scheduling software',
      '4k video', '10k users', '弹性计算', '彈性伸縮', '融资担保', '地铁运营', '地鐵信號系統', 'adoption of the product', 'an optimised runtime', 'ahead of schedule delivery',
    ];
    for (const phrase of topics) expect(isConstraintPhrase(phrase), phrase).toBe(false);
    const requirements = [
      'well paid', 'paid internship', 'paid overtime', 'equity package', 'equity and bonus', 'some equity', 'over 120k', 'at least 90k', '150k+', '120k a year', '100-150k', 'USD 150k', '20k以上', '30万以上',
      'night shifts', 'no shifts', 'shift work', 'flexible schedule', 'a fixed work schedule', '弹性工作', '彈性工時', '弹性上班时间',
      '担保工签', '签证担保', '近地铁', '地铁口', '地鐵站附近',
    ];
    for (const phrase of requirements) expect(isConstraintPhrase(phrase), phrase).toBe(true);
    const { rankedBy } = planToFilters({ queries: ['Analyst'], unverifiedPreferences: ['equity research', 'paid social', 'good equity', 'well paid', '地铁运营'] }, 'analyst', 'intl');
    expect(rankedBy).toEqual(['equity research', 'paid social', '地铁运营']);
  });

  it('US work-authorisation wording is a requirement: OPT, CPT and EAD in capitals, and E-Verify', () => {
    for (const phrase of ['OPT friendly', 'accepts CPT', 'EAD accepted', 'E-Verify employer', 'everify', 'open to OPT/CPT']) expect(isConstraintPhrase(phrase), phrase).toBe(true);
    // The same letters inside ordinary words are not.
    for (const phrase of ['opt-in marketing', 'adoption', 'optimisation', 'head of product', 'a leading team', 'concept design']) expect(isConstraintPhrase(phrase), phrase).toBe(false);
    expect(planToFilters({ queries: ['Engineer'], unverifiedPreferences: ['OPT friendly', 'Rust'] }, 'engineer', 'intl').rankedBy).toEqual(['Rust']);
  });

  it("the planner's own terms pass the same test: a pay or visa phrase it names is never ranked by", () => {
    const { rankedBy, unmatched } = planToFilters(
      { queries: ['Backend Engineer'], unverifiedPreferences: ['salary above 150k', 'great benefits'], relevanceTerms: ['salary above 150k', 'visa sponsorship', 'Rust'] },
      'backend jobs',
      'intl',
    );
    expect(rankedBy).toEqual(['Rust']);
    // Still told to the user as not checked.
    expect(unmatched).toEqual(['salary above 150k', 'great benefits']);
    // When none of its terms is a topic, the topics are derived from the unmatched phrases.
    expect(planToFilters({ queries: ['X'], unverifiedPreferences: ['using Rust', 'salary above 150k'], relevanceTerms: ['salary above 150k', 'H-1B transfer'] }, 'x', 'intl').rankedBy).toEqual(['Rust']);
    expect(planToFilters({ queries: ['X'], unverifiedPreferences: ['salary above 150k'], relevanceTerms: ['salary above 150k'] }, 'x', 'intl').rankedBy).toEqual([]);
  });

  it('the terms joined by a space always fit what `relevance` accepts (240 characters)', () => {
    const word = (c: string) => `${c.repeat(59)}x`;
    const five = ['a', 'b', 'c', 'd', 'e'].map(word);
    expect(five.every((t) => t.length === RANKED_BY_MAX_CHARS)).toBe(true);
    const { rankedBy } = planToFilters({ queries: ['Engineer'], unverifiedPreferences: [], relevanceTerms: five }, 'engineer', 'intl');
    // Four of 60 characters and three spaces are 243: the fourth does not fit, so three are kept.
    expect(rankedBy).toEqual(five.slice(0, 3));
    expect(rankedBy.join(' ').length).toBeLessThanOrEqual(FEED_RELEVANCE_MAX_CHARS);
    expect(FeedRelevanceSchema.safeParse(rankedBy.join(' ')).success).toBe(true);
    expect(FeedRelevanceSchema.safeParse(five.join(' ')).success).toBe(false);
    // A shorter later term still fits in the room that is left.
    const mixed = planToFilters({ queries: ['Engineer'], unverifiedPreferences: [], relevanceTerms: [...five.slice(0, 4), 'Rust'] }, 'engineer', 'intl').rankedBy;
    expect(mixed).toEqual([...five.slice(0, 3), 'Rust']);
    expect(mixed.join(' ').length).toBeLessThanOrEqual(FEED_RELEVANCE_MAX_CHARS);
  });

  it('drops the lead-in of a phrase, cuts a term to 60 characters and keeps at most 5 distinct terms', () => {
    const many = ['using Rust', 'with Kubernetes', 'at climate startups', 'in the energy sector', 'working with robots', 'focused on developer tools', 'about open source'];
    const { rankedBy } = planToFilters({ queries: ['Engineer'], unverifiedPreferences: many }, 'engineer', 'intl');
    expect(rankedBy).toEqual(['Rust', 'Kubernetes', 'climate startups', 'the energy sector', 'robots']);
    expect(rankedBy).toHaveLength(RANKED_BY_MAX_TERMS);
    const long = planToFilters({ queries: ['Engineer'], unverifiedPreferences: [`a team that ${'really '.repeat(20)}cares`, 'Rust', 'rust'] }, 'engineer', 'intl').rankedBy;
    expect(long[0]!.length).toBeLessThanOrEqual(RANKED_BY_MAX_CHARS);
    expect(long).toHaveLength(2);
    expect(RANKED_BY_MAX_CHARS).toBe(60);
    expect(RANKED_BY_MAX_TERMS).toBe(5);
  });

  it('a phrase that became a filter is neither unmatched nor ranked by', () => {
    const { patch, unmatched, rankedBy } = planToFilters({ queries: ['Data Analyst'], unverifiedPreferences: ['paying over €70k', 'needs visa sponsorship', 'no staffing agencies', 'healthcare data'] }, 'data analyst', 'intl');
    expect(patch).toMatchObject({ salaryMin: { amount: 70000 }, needsSponsorship: true, excludeAgencies: true });
    expect(unmatched).toEqual(['healthcare data']);
    expect(rankedBy).toEqual(['healthcare data']);
  });

  it('GoApply: an experience line may order the list; an intern-days line is a requirement', () => {
    const { rankedBy, unmatched } = planToFilters({ queries: ['数据分析实习生'], unverifiedPreferences: ['新能源行业', '每周至少4天'] }, '数据分析实习生', 'cn');
    expect(unmatched).toEqual(['新能源行业', '每周至少4天']);
    expect(rankedBy).toEqual(['新能源行业']);
  });

  it('answers an empty list when nothing is left over', () => {
    expect(planToFilters({ queries: ['Designer'], unverifiedPreferences: [] }, 'designer', 'intl').rankedBy).toEqual([]);
  });
});
