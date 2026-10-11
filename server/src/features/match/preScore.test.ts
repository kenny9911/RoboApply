// @vitest-environment node
// The quick estimate, version 2 (MARKET_STRATEGY 2.2, 2.4; SM-3): table tests
// per component, the priors, the logistics rule, coverage and confidence, and
// the rule that no chip of the saved search moves a fit (invariant I3).
import { describe, expect, it } from 'vitest';

import { getMatchPriors } from './config.js';
import { DEFAULT_MATCH_PRIORS, DEFAULT_MATCH_TIERS, DEFAULT_MATCH_WEIGHTS, tierForScore } from './contract.js';
import {
  LOGISTICS_BY_FILTERS_REF,
  combineDimensions,
  combineWithPriors,
  confidenceFor,
  coverageOf,
  degreeMeets,
  evidenceRoles,
  hardFiltersOf,
  industryDimension,
  isByFilters,
  jobSkillList,
  levelGap,
  locationCheck,
  logisticsDimension,
  logisticsForEstimate,
  needsSponsorshipFor,
  payCheck,
  postingCoverageOf,
  preScore,
  preScoreDimensions,
  preScoreLimit,
  resumeSeniority,
  roleIdOfTitle,
  seniorityFactor,
  skillKey,
  skillsDimension,
  splitSkills,
  normalizeText,
  taxonomyOverlap,
  titleLevelDimension,
  titleOverlap,
  visaCheck,
} from './preScore.js';
import { buildKeywordRows } from './keywordRows.js';
import { buildMatchUser, payAsPosted, toMatchJob, type UserMatchInputs } from './context.js';
import { defaultUserInputs, jobRecord, matchJob, matchUser } from './testkit.js';

const W = { ...DEFAULT_MATCH_WEIGHTS };
const P = { ...DEFAULT_MATCH_PRIORS };
const CFG = { weights: W, tiers: { ...DEFAULT_MATCH_TIERS } };
const NOW = new Date('2026-10-10T00:00:00Z');
/** No logistics answers at all: nothing to check, nothing guaranteed. */
const NO_LOGISTICS = { locations: [], workModels: [], country: null, salaryMin: null } as const;

describe('taxonomy distance', () => {
  it.each([
    ['backend_engineer', 'backend_engineer', 1],
    ['swe_backend', 'backend_engineer', 1], // inside the user's target group
    ['software_engineering', 'frontend_engineer', 1], // inside the user's target category
    ['platform_engineer', 'backend_engineer', 0.6], // same group
    ['frontend_engineer', 'backend_engineer', 0.3], // same category
    ['account_executive', 'backend_engineer', 0], // unrelated
    ['not_a_node', 'backend_engineer', 0],
  ])('%s vs %s → %s', (target, job, expected) => {
    expect(taxonomyOverlap(target, job)).toBe(expected);
  });

  it('the job falls back to its title when it carries no taxonomy ids; the person falls back to their most recent title', () => {
    const job = matchJob({ taxonomyIds: [], primaryTaxonomyId: null, title: 'Senior Backend Engineer' });
    expect(titleOverlap(matchUser(), job)).toBe(1);
    // A hand-built person with no `evidenceRoleIds`: the role their most recent title names.
    expect(evidenceRoles({ recentTitle: 'Backend Engineer' })).toEqual(['backend_engineer']);
    expect(titleOverlap({ recentTitle: 'Backend Engineer' }, job)).toBe(1);
    expect(titleOverlap({ recentTitle: null }, job)).toBeNull();
    // An explicit empty list is "the record shows no role": the title is not consulted again.
    expect(titleOverlap({ evidenceRoleIds: [], recentTitle: 'Backend Engineer' }, job)).toBeNull();
    // Ids that are not taxonomy nodes are dropped.
    expect(evidenceRoles({ evidenceRoleIds: ['not_a_node', 'backend_engineer', 'backend_engineer'], recentTitle: null })).toEqual(['backend_engineer']);
  });

  it('the saved search is never the role: a job inside the Role filter is not a fit for passing the filter (I3)', () => {
    const teacher = matchUser({ evidenceRoleIds: ['school_teacher'], recentTitle: 'Teacher', targetTaxonomyIds: ['data_analyst'], targetTitles: ['Data Analyst'] });
    const analyst = matchJob({ title: 'Data Analyst', taxonomyIds: ['data_ai', 'data_analytics', 'data_analyst'], primaryTaxonomyId: 'data_analyst' });
    expect(titleOverlap(teacher, analyst)).toBe(0);
    expect(titleLevelDimension(teacher, analyst, W)).toMatchObject({ status: 'scored', score: 0 });
  });
});

describe('seniority factor', () => {
  it.each([
    [['senior'], 'senior', 1],
    [['mid'], 'senior', 0.7],
    [['entry'], 'senior', 0.3],
    [['intern_newgrad'], 'senior', 0],
    [['mid', 'lead_staff'], 'senior', 0.7],
    [[], 'senior', 0.8],
    [['senior'], null, 0.8],
  ])('%j vs %s → %s', (targets, job, f) => {
    expect(seniorityFactor(targets as string[], job as string | null)).toBe(f);
  });
});

describe('title_level = taxonomy overlap × seniority × stated eligibility', () => {
  it('scores overlap × factor and cites the posting title', () => {
    const d = titleLevelDimension(matchUser({ recentTitle: 'Software Engineer', yearsExperience: 4 }), matchJob({ seniority: 'senior' }), W);
    expect(d).toMatchObject({ key: 'title_level', status: 'scored', score: 70, weight: 35 });
    expect(d.evidence[0]).toEqual({ text: 'Backend Engineer', source: 'posting', ref: 'title' });
  });

  it('halves when the posting states a degree the user does not have', () => {
    const d = titleLevelDimension(matchUser({ highestDegree: 'bachelor' }), matchJob({ educationLevel: 'master' }), W);
    expect(d.score).toBe(50);
    expect(d.evidence.some((e) => e.ref === 'education_required')).toBe(true);
    // Unknown user degree: no penalty (never inferred).
    expect(titleLevelDimension(matchUser({ highestDegree: null }), matchJob({ educationLevel: 'master' }), W).score).toBe(100);
  });

  it('GoApply: a stated 届别 the user is not in halves title_level; unstated does nothing', () => {
    const cnUser = matchUser({ market: 'cn', classYear: 2026 });
    const stated = matchJob({ market: 'cn', classYears: [2027], classYearQuote: '面向2027届毕业生' });
    const d = titleLevelDimension(cnUser, stated, W);
    expect(d.score).toBe(50);
    expect(d.evidence).toContainEqual({ text: '面向2027届毕业生', source: 'posting', ref: 'class_year' });
    expect(titleLevelDimension(cnUser, matchJob({ market: 'cn', classYears: [2026] }), W).score).toBe(100);
    expect(titleLevelDimension(cnUser, matchJob({ market: 'cn', classYears: [] }), W).score).toBe(100);
  });

  it('degreeMeets', () => {
    expect(degreeMeets('master', 'bachelor')).toBe(true);
    expect(degreeMeets('associate', 'bachelor')).toBe(false);
    expect(degreeMeets(null, 'bachelor')).toBeNull();
    expect(degreeMeets('phd', null)).toBeNull();
    expect(degreeMeets('phd', 'none')).toBeNull();
  });
});

describe('skills = Σ weight shown / Σ weight listed over the first 10 hard skills (required 1, preferred 0.5)', () => {
  it.each([
    [['TypeScript', 'Go'], ['typescript', 'go', 'kubernetes'], 67],
    [['typescript', 'GO', 'Kubernetes'], ['typescript', 'go', 'kubernetes'], 100],
    [[], ['typescript'], 0],
    [['Node.js'], ['nodejs'], 100],
  ])('user %j vs job %j → %s', (userSkills, jobSkills, score) => {
    const d = skillsDimension(matchUser({ skills: userSkills as string[] }), matchJob({ skills: jobSkills as string[] }), W);
    expect(d.score).toBe(score);
  });

  it('counts the first 10 only, required ones first', () => {
    const many = Array.from({ length: 20 }, (_, i) => `skill${i}`);
    const d = skillsDimension(matchUser({ skills: many.slice(0, 10) }), matchJob({ skills: many }), W);
    expect(d.score).toBe(100);
    // The person shows only the last ten: none of the ten that are counted.
    expect(skillsDimension(matchUser({ skills: many.slice(10) }), matchJob({ skills: many }), W).score).toBe(0);
    // Required skills are counted before the others, wherever the posting lists them.
    const detail = many.map((skill, i) => ({ skill, kind: 'hard', required: i >= 15 }));
    const requiredOnly = matchUser({ skills: many.slice(15) });
    // 5 required shown (5 × 1) of 5 required + 5 preferred (5 × 1 + 5 × 0.5).
    expect(skillsDimension(requiredOnly, matchJob({ skills: [], skillsDetail: detail }), W).score).toBe(Math.round((100 * 5) / 7.5));
  });

  it('a required skill counts 1 and a preferred one 0.5', () => {
    const job = matchJob({
      skills: [],
      skillsDetail: [
        { skill: 'Kubernetes', kind: 'hard', required: true },
        { skill: 'TypeScript', kind: 'hard', required: false },
        { skill: 'Go', kind: 'hard', required: false },
      ],
    });
    // Shows the two preferred ones: (0.5 + 0.5) / (1 + 0.5 + 0.5).
    expect(skillsDimension(matchUser({ skills: ['TypeScript', 'Go'] }), job, W).score).toBe(50);
    // Shows only the required one: 1 / 2.
    expect(skillsDimension(matchUser({ skills: ['Kubernetes'] }), job, W).score).toBe(50);
    // Shows the required one and one preferred: 1.5 / 2.
    expect(skillsDimension(matchUser({ skills: ['Kubernetes', 'Go'] }), job, W).score).toBe(75);
  });

  it('soft skills are shown and never counted; a posting that lists only soft skills states no skills', () => {
    const softOnly = matchJob({
      skills: ['communication', 'attention to detail'],
      skillsDetail: [
        { skill: 'Communication', kind: 'soft', required: true },
        { skill: 'Attention to detail', kind: 'soft', required: false },
      ],
    });
    expect(skillsDimension(matchUser({ skills: ['Communication'] }), softOnly, W)).toMatchObject({ status: 'not_stated', score: null });
    expect(splitSkills(matchUser(), softOnly)).toEqual({ aligned: [], missing: [], missingRequired: [], softSkills: ['Communication', 'Attention to detail'] });
    expect(preScore(matchUser(), softOnly, CFG).softSkills).toEqual(['Communication', 'Attention to detail']);

    // Mixed: the soft skill is in neither the numerator nor the denominator.
    const mixed = matchJob({
      skills: ['typescript', 'teamwork', 'go'],
      skillsDetail: [
        { skill: 'TypeScript', kind: 'hard', required: true },
        { skill: 'Teamwork', kind: 'soft', required: true },
      ],
    });
    // TypeScript (required, shown) 1, Go (no detail entry, so hard and preferred; shown) 0.5 → 1.5 / 1.5.
    expect(skillsDimension(matchUser({ skills: ['TypeScript', 'Go'] }), mixed, W).score).toBe(100);
    expect(jobSkillList(mixed).map((s) => [s.skill, s.kind, s.required])).toEqual([
      ['TypeScript', 'hard', true],
      ['Teamwork', 'soft', true],
      ['Go', 'hard', false],
    ]);
    expect(splitSkills(matchUser({ skills: ['TypeScript'] }), mixed)).toEqual({ aligned: ['TypeScript'], missing: ['Go'], missingRequired: [], softSkills: ['Teamwork'] });
    // The gap on a card is never a soft skill.
    expect(preScore(matchUser({ skills: [] }), mixed, CFG).topGap).toBe('TypeScript');
  });

  it('is not stated when the posting lists no skills; evidence names a missing required skill', () => {
    expect(skillsDimension(matchUser(), matchJob({ skills: [], skillsDetail: null }), W).status).toBe('not_stated');
    const d = skillsDimension(
      matchUser({ skills: ['TypeScript'] }),
      matchJob({ skills: [], skillsDetail: [{ skill: 'Go', required: false }, { skill: 'Kubernetes', required: true }, { skill: 'TypeScript', required: true }] }),
      W,
    );
    expect(d.evidence).toContainEqual({ text: 'Kubernetes', source: 'posting', ref: 'skill_missing' });
    expect(d.evidence).toContainEqual({ text: 'TypeScript', source: 'resume', ref: 'skill_have' });
  });

  it('a skill written only in the resume body counts as shown — and agrees with the keyword check', () => {
    const resume = 'Senior engineer. Ran our Kubernetes clusters and wrote Go services.';
    const user = matchUser({ skills: ['TypeScript'], resumeTextNorm: normalizeText(resume) });
    const job = matchJob({ skills: ['typescript', 'go', 'kubernetes', 'rust'], skillsDetail: null });
    // Stored lower case, shown in the usual spelling.
    expect(splitSkills(user, job)).toEqual({ aligned: ['TypeScript', 'Go', 'Kubernetes'], missing: ['Rust'], missingRequired: [], softSkills: [] });
    expect(skillsDimension(user, job, W).score).toBe(75);
    expect(skillsDimension(user, job, W).evidence).toContainEqual({ text: 'Rust', source: 'posting', ref: 'skill_missing' });
    const skillsRow = buildKeywordRows({ job: { ...job, minYears: null }, user, resumeText: resume, keywords: null }).find((r) => r.key === 'skills')!;
    expect(skillsRow.items.filter((i) => !i.found).map((i) => i.term)).toEqual(['Rust']);
    // Whole words only: "Go" is not found inside "Google".
    const google = matchUser({ skills: [], resumeTextNorm: normalizeText('Worked at Google.') });
    expect(splitSkills(google, matchJob({ skills: ['go'], skillsDetail: null })).missing).toEqual(['Go']);
  });

  it('skillKey normalizes punctuation and case', () => {
    expect(skillKey(' Node.JS ')).toBe('nodejs');
    expect(skillKey('C++')).toBe('c++');
    expect(skillKey('C#')).not.toBe(skillKey('C++'));
  });
});

describe('industry', () => {
  it('shared industry = 100, none shared = 0, unknown on either side = not stated', () => {
    expect(industryDimension(matchUser(), matchJob(), W).score).toBe(100);
    expect(industryDimension(matchUser({ employerIndustries: ['Retail'] }), matchJob(), W).score).toBe(0);
    expect(industryDimension(matchUser({ employerIndustries: [] }), matchJob(), W).status).toBe('not_stated');
    expect(industryDimension(matchUser(), matchJob({ companyIndustries: [] }), W).status).toBe('not_stated');
  });
});

describe('logistics (deterministic, never a constant)', () => {
  it.each([
    ['inside the radius', {}, {}, 'met'],
    ['outside the radius', {}, { geoLat: 48.137, geoLng: 11.575, locationCity: 'Munich', location: 'Munich, DE' }, 'not_met'],
    ['same city by name', { locations: [{ label: 'Berlin', city: 'Berlin', country: 'DE', radiusKm: 0 }] }, {}, 'met'],
    ['country only', { locations: [{ label: 'Germany', country: 'DE', radiusKm: 0 }] }, { locationCity: 'Hamburg' }, 'met'],
    ['remote-only user, onsite job', { workModels: ['remote'] }, {}, 'not_met'],
    ['remote job, remote user', { workModels: ['remote'] }, { workModel: 'remote', remoteScope: 'global' }, 'met'],
    ['remote job scoped to another country', { workModels: ['remote'] }, { workModel: 'remote', remoteScope: 'US' }, 'not_met'],
    ['onsite-only user, remote job', { workModels: ['onsite'] }, { workModel: 'remote' }, 'not_met'],
    ['no preferences', { locations: [], workModels: [], country: null }, {}, 'not_stated'],
    ['job location unknown', {}, { locationCity: null, locationCountry: null, geoLat: null, geoLng: null, location: null }, 'not_stated'],
  ])('location: %s', (_name, user, job, expected) => {
    expect(locationCheck(matchUser(user as never), matchJob(job as never))).toBe(expected);
  });

  it.each([
    ['annual max ≥ min', {}, {}, 'met'],
    ['annual max < min', { salaryMin: { amount: 100000, currency: 'EUR', period: 'year' } }, {}, 'not_met'],
    ['monthly minimum annualized', { salaryMin: { amount: 7000, currency: 'EUR', period: 'month' } }, {}, 'met'],
    ['hourly minimum annualized', { salaryMin: { amount: 50, currency: 'EUR', period: 'hour' } }, {}, 'not_met'],
    ['undisclosed pay', {}, { salaryAnnualMin: null, salaryAnnualMax: null }, 'not_stated'],
    ['other currency', { salaryMin: { amount: 60000, currency: 'USD', period: 'year' } }, {}, 'not_stated'],
    ['no minimum set', { salaryMin: null }, {}, 'not_stated'],
  ])('pay: %s', (_name, user, job, expected) => {
    expect(payCheck(matchUser(user as never), matchJob(job as never))).toBe(expected);
  });

  it('visa: only when the user needs sponsorship; silence is not stated, never inferred', () => {
    const needs = matchUser({ needsSponsorship: true });
    expect(visaCheck(needs, matchJob({ sponsorship: 'offered' }))).toBe('met');
    expect(visaCheck(needs, matchJob({ sponsorship: 'not_offered' }))).toBe('not_met');
    expect(visaCheck(needs, matchJob({ sponsorship: null }))).toBe('not_stated');
    expect(visaCheck(matchUser({ needsSponsorship: false }), matchJob({ sponsorship: 'not_offered' }))).toBeNull();
    expect(visaCheck(needs, matchJob({ market: 'cn', sponsorship: 'not_offered' }))).toBeNull();
  });

  it('visa evidence quotes only the post’s own words, never the sponsorship enum', () => {
    const needs = matchUser({ needsSponsorship: true });
    const noQuote = logisticsDimension(needs, matchJob({ sponsorship: 'offered', sponsorshipEvidence: null }), W);
    expect(noQuote.evidence).toContainEqual({ text: '', source: 'posting', ref: 'visa_offered' });
    const quoted = logisticsDimension(needs, matchJob({ sponsorship: 'not_offered', sponsorshipEvidence: 'Visa sponsorship is not available.' }), W);
    expect(quoted.evidence).toContainEqual({ text: 'Visa sponsorship is not available.', source: 'posting', ref: 'visa_not_offered' });
  });

  it('TW-09: the per-country work-authorization answer wins over the search-profile toggle', () => {
    const tw = matchJob({ locationCountry: 'TW', locationCity: 'Taipei' });
    expect(needsSponsorshipFor(matchUser({ needsSponsorship: false, workAuth: [{ country: 'TW', authorized: false, sponsorship: 'now' }] }), tw)).toBe(true);
    expect(needsSponsorshipFor(matchUser({ needsSponsorship: true, workAuth: [{ country: 'TW', authorized: true, sponsorship: null }] }), tw)).toBe(false);
    expect(needsSponsorshipFor(matchUser({ needsSponsorship: true, workAuth: [{ country: 'US', authorized: true, sponsorship: 'no' }] }), tw)).toBe(true);
  });

  it('FIX-3: pay evidence is the posting\'s own words when it has them (18-28K·15薪), never our annual arithmetic', () => {
    const cnUser = matchUser({ market: 'cn', country: 'CN', locations: [], salaryMin: { amount: 15000, currency: 'CNY', period: 'month' } });
    const cnJob = matchJob({ market: 'cn', locationCountry: 'CN', locationCity: '上海', salaryCurrency: 'CNY', salaryAnnualMin: 270000, salaryAnnualMax: 420000, payAsPosted: '18-28K·15薪' });
    const pay = logisticsDimension(cnUser, cnJob, W).evidence.find((e) => e.ref === 'pay_met');
    expect(pay).toEqual({ text: '18-28K·15薪', source: 'posting', ref: 'pay_met' });
    // No words from the posting: the compared figures, as before.
    const bare = logisticsDimension(cnUser, { ...cnJob, payAsPosted: null }, W).evidence.find((e) => e.ref === 'pay_met');
    expect(bare?.text).toBe('CNY 270000–420000');
    // GoApply has no visa part at all.
    expect(logisticsDimension(cnUser, cnJob, W).evidence.some((e) => e.ref?.startsWith('visa'))).toBe(false);
    // The record → job mapping drops a label the pasted line carried and words with no amount.
    expect(payAsPosted('薪资：18-28K·15薪')).toBe('18-28K·15薪');
    expect(payAsPosted('Salary: $90,000 - $110,000 a year')).toBe('$90,000 - $110,000 a year');
    expect(payAsPosted('面议')).toBeNull();
    expect(payAsPosted(null)).toBeNull();
    expect(toMatchJob(jobRecord({ salaryText: '薪资:18-28K·15薪' })).payAsPosted).toBe('18-28K·15薪');
  });

  it('averages the stated checks; all not stated → not stated', () => {
    const half = logisticsDimension(matchUser({ salaryMin: { amount: 100000, currency: 'EUR', period: 'year' } }), matchJob(), W);
    expect(half.score).toBe(50);
    expect(half.evidence.map((e) => e.ref)).toEqual(['location_met', 'pay_not_met']);
    const none = logisticsDimension(matchUser({ locations: [], workModels: [], country: null, salaryMin: null }), matchJob(), W);
    expect(none.status).toBe('not_stated');
  });
});

describe('the estimate is about the resume, and only claims what it compared', () => {
  // An 8-year engineer whose latest title states no level.
  const senior = matchUser({ recentTitle: 'Software Engineer', yearsExperience: 8 });

  it.each([
    ['Senior Software Engineer', 2, 'senior'], // the title states it
    ['Software Engineer', 8, 'senior'], // else the years
    ['Software Engineer', 4, 'mid'],
    ['Software Engineer', 1.5, 'entry'],
    ['Software Engineer', 0, 'intern_newgrad'],
    ['Software Engineering Intern', 0.3, 'intern_newgrad'],
    ['Principal Engineer', 12, 'lead_staff'],
    ['VP of Engineering', 15, 'director_exec'],
    ['Software Engineer', null, null],
    [null, null, null],
  ])('resume level: %s, %s years → %s', (title, years, level) => {
    expect(resumeSeniority(title as string | null, years as number | null)).toBe(level);
  });

  it('a role two or more levels from the resume is at most Possible, however well the rest lines up (a senior resume against an internship)', () => {
    // Everything else is perfect: same role, every skill, same industry, location and pay met.
    const perfect = { skills: ['typescript', 'go'], skillsDetail: null };
    for (const seniority of ['intern_newgrad', 'entry']) {
      const r = preScore(senior, matchJob({ ...perfect, seniority }), CFG);
      expect(r.score, seniority).toBeLessThan(CFG.tiers.good);
      expect(r.tier === 'great' || r.tier === 'good', seniority).toBe(false);
    }
    // One level away or the same level is not limited.
    expect(preScore(senior, matchJob({ ...perfect, seniority: 'senior' }), CFG).tier).toBe('great');
    expect(preScore(senior, matchJob({ ...perfect, seniority: 'mid' }), CFG).score).toBeGreaterThanOrEqual(CFG.tiers.good);
    // An unknown level on either side limits nothing (never inferred).
    expect(levelGap(senior, null)).toBeNull();
    expect(levelGap(matchUser({ recentTitle: null, yearsExperience: null }), 'senior')).toBeNull();
  });

  it('a post with no skills and a role we cannot place gets NO score from location and pay alone', () => {
    const job = matchJob({ title: 'Cleared Zzz', taxonomyIds: [], primaryTaxonomyId: null, skills: [], skillsDetail: null, companyIndustries: [] });
    const r = preScore(senior, job, CFG);
    // The location and pay only repeat the person's own filters: nothing at all is compared.
    expect(r.dimensions.filter((d) => d.status === 'scored').map((d) => d.key)).toEqual([]);
    expect(r).toMatchObject({ score: null, tier: null, topGap: null, topOverlap: null, limit: null, confidence: 'low' });
    // The same when the location and pay are facts (no filter guarantees them): they say nothing about the work.
    const facts = preScore({ ...senior, hardFilters: { location: false, pay: false } }, job, CFG);
    expect(facts.dimensions.filter((d) => d.status === 'scored').map((d) => d.key)).toEqual(['logistics']);
    expect(facts).toMatchObject({ score: null, tier: null, limit: null, confidence: 'low' });
  });

  it('under half of the comparable weight compared → Possible at most; the limit never raises a score', () => {
    // Only the role (35 of 90) could be compared.
    const user = matchUser({ ...senior, employerIndustries: [], ...NO_LOGISTICS });
    const r = preScore(user, matchJob({ skills: [], skillsDetail: null }), CFG);
    expect(r.dimensions.filter((d) => d.status === 'scored').map((d) => d.key)).toEqual(['title_level']);
    expect(r.limit).toBe(CFG.tiers.good - 1);
    // 35 × 100 + priors for the rest: 3500 + 1170 + 360 + 500 + 450 = 59.8.
    expect(r.score).toBe(60);
    expect(r.tier).toBe('possible');
    // A filter-guaranteed logistics part is not evidence: it does not lift the job over the half.
    const guaranteed = preScore(matchUser({ ...senior, employerIndustries: [] }), matchJob({ skills: [], skillsDetail: null }), CFG);
    expect(guaranteed.limit).toBe(CFG.tiers.good - 1);

    const full = preScore(senior, matchJob(), CFG);
    expect(preScoreLimit(full.dimensions, 0, CFG.tiers)).toBe(100);
    expect(full.score).toBe(combineWithPriors(full.dimensions, P));
    const unrelated = preScore(senior, matchJob({ taxonomyIds: ['sales', 'account_executive'], primaryTaxonomyId: 'account_executive', title: 'Account Executive', skills: ['salesforce'] }), CFG);
    expect(unrelated.tier === 'great' || unrelated.tier === 'good').toBe(false);
  });
});

describe('priors, not renormalisation (MARKET_STRATEGY 2.4)', () => {
  // A person whose logistics answers are profile facts, not filters: a met check is real information.
  const noFilters = { ...NO_LOGISTICS, country: 'DE', hardFilters: { location: false, pay: false } };

  it('the worked example: no skills, a perfect title and logistics really met give 64.8, so 65 at most and never Great', () => {
    const user = matchUser({ recentTitle: 'Senior Software Engineer', employerIndustries: [], ...noFilters });
    const job = matchJob({ skills: [], skillsDetail: null, companyIndustries: [] });
    const r = preScore(user, job, CFG);
    expect(r.dimensions.map((d) => [d.key, d.score])).toEqual([
      ['title_level', 100],
      ['skills', null],
      ['industry', null],
      ['logistics', 100],
      ['career_path', null],
    ]);
    // (35 × 100 + 30 × 39 + 15 × 24 + 10 × 100 + 10 × 45) / 100 = 64.8
    expect(combineWithPriors(r.dimensions, P)).toBe(65);
    expect(r.score).toBeLessThanOrEqual(65);
    expect(r.tier).not.toBe('great');
    // Renormalising alone would have said 100.
    expect(combineDimensions(r.dimensions)).toBe(100);
  });

  it('each not-stated component contributes its own prior at its full weight', () => {
    const scored = (key: string, score: number) => ({ key, weight: W[key as keyof typeof W], score, status: 'scored' as const, evidence: [] });
    const missing = (key: string) => ({ key, weight: W[key as keyof typeof W], score: null, status: 'not_stated' as const, evidence: [] });
    const all = ['title_level', 'skills', 'industry', 'logistics', 'career_path'];
    // Nothing stated: the weighted mean of the priors.
    const none = all.map(missing) as never;
    expect(combineWithPriors(none, P)).toBe(Math.round((35 * 44 + 30 * 39 + 15 * 24 + 10 * 50 + 10 * 45) / 100));
    for (const key of all) {
      // Everything else at 100, this one not stated: it counts at its prior, not at 100 and not at 0.
      const dims = all.map((k) => (k === key ? missing(k) : scored(k, 100))) as never;
      const expected = Math.round((100 * (100 - W[key as keyof typeof W]) + P[key as keyof typeof P] * W[key as keyof typeof W]) / 100);
      expect(combineWithPriors(dims, P), key).toBe(expected);
    }
    // Other priors (a market's own): the same arithmetic.
    const custom = { title_level: 10, skills: 20, industry: 30, logistics: 40, career_path: 50 };
    expect(combineWithPriors(none, custom)).toBe(Math.round((35 * 10 + 30 * 20 + 15 * 30 + 10 * 40 + 10 * 50) / 100));
    // `preScore` reads the priors of its config.
    const job = matchJob({ skills: [], skillsDetail: null });
    const low = preScore(matchUser(), job, { ...CFG, priors: { ...P, skills: 0 } }).score!;
    const high = preScore(matchUser(), job, { ...CFG, priors: { ...P, skills: 60 } }).score!;
    expect(high - low).toBe(Math.round((30 * 60) / 100));
  });

  it('a no-skills job is never Great, whatever else it says', () => {
    const everything = matchUser({ recentTitle: 'Senior Backend Engineer', ...noFilters, salaryMin: { amount: 60000, currency: 'EUR', period: 'year' } });
    const r = preScore(everything, matchJob({ skills: [], skillsDetail: null }), CFG);
    // title 100, industry 100, logistics 100: 3500 + 1170 + 1500 + 1000 + 450 = 76.2
    expect(r.score).toBe(76);
    expect(r.tier).toBe('good');
    expect(r.limit).toBe(CFG.tiers.great - 1);
  });

  it('nothing to compare → null, never 0', () => {
    const user = matchUser({ evidenceRoleIds: [], recentTitle: null, skills: [], employerIndustries: [], ...NO_LOGISTICS });
    const r = preScore(user, matchJob({ skills: [], taxonomyIds: [], primaryTaxonomyId: null, title: 'Zzz', companyIndustries: [] }), CFG);
    expect(r.score).toBeNull();
    expect(r.tier).toBeNull();
    expect(r.kind).toBe('pre');
  });

  it('getMatchPriors: defaults, a per-key override, the GoApply override with its fallback, and a malformed value', () => {
    expect(getMatchPriors('roboapply', {})).toEqual({ title_level: 44, skills: 39, industry: 24, logistics: 50, career_path: 45 });
    expect(getMatchPriors('roboapply', { MATCH_PRIORS: '{"skills":30,"logistics":"70"}' })).toEqual({ ...P, skills: 30, logistics: 70 });
    // GoApply reads CN_MATCH_PRIORS when it is set, else the shared value, then the defaults (D5).
    expect(getMatchPriors('goapply', { MATCH_PRIORS: '{"skills":30}', CN_MATCH_PRIORS: '{"skills":55}' }).skills).toBe(55);
    expect(getMatchPriors('goapply', { MATCH_PRIORS: '{"skills":30}' }).skills).toBe(30);
    expect(getMatchPriors('goapply', {})).toEqual(P);
    // RoboApply never reads the CN value.
    expect(getMatchPriors('roboapply', { CN_MATCH_PRIORS: '{"skills":55}' }).skills).toBe(39);
    // One malformed key keeps the defaults whole.
    for (const bad of ['{"skills":"x"}', '{"skills":-1}', '{"skills":101}', '{"skills":null}', '{"skills":true}', '{"skills":""}', 'not json', '[1,2]', '']) {
      expect(getMatchPriors('roboapply', { MATCH_PRIORS: bad }), bad).toEqual(P);
    }
  });
});

describe('logistics in the estimate: a check met only through your own filter adds nothing', () => {
  const pay = { amount: 60000, currency: 'EUR', period: 'year' } as const;

  it('every stated check met and filter-guaranteed → not compared: it counts at the prior, and the evidence says so', () => {
    // Location (a search location) and pay (a pay floor) are both filters, and both met.
    const user = matchUser();
    const job = matchJob();
    expect(hardFiltersOf(user)).toEqual({ location: true, pay: true });
    const { dimension, byFilters } = logisticsForEstimate(user, job, W);
    expect(byFilters).toBe(true);
    // No number nobody measured: the part is not stated, like any part the estimate cannot compare.
    expect(dimension).toMatchObject({ key: 'logistics', status: 'not_stated', score: null, weight: W.logistics });
    // One line, never empty: what the filters already guaranteed, in the posting's own words.
    expect(dimension.evidence).toEqual([{ text: 'Berlin, DE · EUR 70000–90000', source: 'posting', ref: LOGISTICS_BY_FILTERS_REF }]);
    expect(isByFilters(dimension)).toBe(true);
    expect(isByFilters(logisticsDimension(user, job, W))).toBe(false);
    // The facts themselves (the AI score's form) are unchanged: 100.
    expect(logisticsDimension(user, job, W).score).toBe(100);
    // In the estimate the part contributes the logistics prior at its full weight, and is out of the coverage.
    const r = preScore(user, job, CFG);
    expect(r.dimensions.find((d) => d.key === 'logistics')).toEqual(dimension);
    expect(r.coverage).toBe(0.8);
    const withPrior = (logistics: number) => preScore(user, job, { ...CFG, priors: { ...P, logistics } });
    // Another prior for the market moves the total by weight × difference: 10 × (90 − 50) / 100 = 4 points.
    expect(withPrior(90).score! - withPrior(50).score!).toBe(4);
    // The same total as a person with no logistics answers at all (the prior, not 100).
    const really = preScore(matchUser({ hardFilters: { location: false, pay: false } }), job, CFG);
    expect(really.dimensions.find((d) => d.key === 'logistics')!.score).toBe(100);
    expect(really.score! - r.score!).toBe(5);
  });

  it('with no words to quote the part is a plain not-stated one: never an empty evidence line', () => {
    // Met by distance, and the posting carries coordinates but no place words.
    const user = matchUser({ salaryMin: null });
    const job = matchJob({ location: null, locationCity: null, locationCountry: null });
    const { dimension, byFilters } = logisticsForEstimate(user, job, W);
    expect(locationCheck(user, job)).toBe('met');
    expect(byFilters).toBe(true);
    expect(dimension).toMatchObject({ status: 'not_stated', score: null, evidence: [] });
    for (const d of preScore(user, job, CFG).dimensions) for (const e of d.evidence) expect(e.text.trim(), `${d.key} ${e.ref}`).not.toBe('');
  });

  it('an offered sponsorship is a fact of the posting, never guaranteed by the "I need sponsorship" filter', () => {
    // The filter only removes postings that say they do not sponsor; silent ones stay. So "offered" is information.
    const user = matchUser({ needsSponsorship: true });
    const offered = matchJob({ sponsorship: 'offered', sponsorshipEvidence: 'We sponsor visas.' });
    const scored = logisticsForEstimate(user, offered, W);
    expect(scored.byFilters).toBe(false);
    expect(scored.dimension).toMatchObject({ status: 'scored', score: 100 });
    expect(scored.dimension.evidence.map((e) => e.ref)).toEqual(['location_met', 'pay_met', 'visa_offered']);
    // The sponsorship check alone, with no quote in the posting: scored as a fact, and no by-filters line at all.
    const visaOnly = matchUser({ ...NO_LOGISTICS, needsSponsorship: true });
    const bare = logisticsForEstimate(visaOnly, matchJob({ sponsorship: 'offered', sponsorshipEvidence: null }), W);
    expect(bare.byFilters).toBe(false);
    expect(bare.dimension).toMatchObject({ status: 'scored', score: 100 });
    expect(bare.dimension.evidence.some((e) => e.ref === LOGISTICS_BY_FILTERS_REF)).toBe(false);
    // A posting silent on sponsorship: the visa check is not stated, so only the filtered checks remain → not compared.
    expect(logisticsForEstimate(user, matchJob(), W).byFilters).toBe(true);
    // A posting that says no is a real penalty: 2 of 3 met.
    expect(logisticsForEstimate(user, matchJob({ sponsorship: 'not_offered', sponsorshipEvidence: 'No visa sponsorship.' }), W).dimension.score).toBe(67);
    // The offer is worth points in the total: 10 × (100 − 50) / 100 over the silent posting.
    expect(preScore(user, offered, CFG).score! - preScore(user, matchJob(), CFG).score!).toBe(5);
  });

  it('really met without a filter → 100, as a fact', () => {
    // The country is a profile fact and the visa need a per-country work-authorisation answer: no filter guarantees either.
    const user = matchUser({ locations: [], workModels: [], country: 'DE', salaryMin: null, needsSponsorship: false, workAuth: [{ country: 'DE', authorized: false, sponsorship: 'now' }], hardFilters: { location: false, pay: false } });
    const job = matchJob({ sponsorship: 'offered', sponsorshipEvidence: 'We sponsor visas.' });
    const { dimension, byFilters } = logisticsForEstimate(user, job, W);
    expect(byFilters).toBe(false);
    expect(dimension.score).toBe(100);
    expect(dimension.evidence.some((e) => e.ref === LOGISTICS_BY_FILTERS_REF)).toBe(false);
    expect(preScore(user, job, CFG).coverage).toBe(0.9);
    // One real check next to a guaranteed one is information: 100, not the prior.
    const mixed = matchUser({ needsSponsorship: false, workAuth: [{ country: 'DE', authorized: false, sponsorship: 'now' }] });
    expect(logisticsForEstimate(mixed, job, W)).toMatchObject({ byFilters: false, dimension: { score: 100 } });
  });

  it('not met is a real penalty, filter or not: 100 × met / stated', () => {
    const user = matchUser({ salaryMin: { amount: 100000, currency: 'EUR', period: 'year' } });
    const half = logisticsForEstimate(user, matchJob(), W);
    expect(half.byFilters).toBe(false);
    expect(half.dimension.score).toBe(50);
    expect(half.dimension.evidence.map((e) => e.ref)).toEqual(['location_met', 'pay_not_met']);
    const none = logisticsForEstimate(matchUser({ salaryMin: { amount: 100000, currency: 'EUR', period: 'year' }, workModels: ['remote'] }), matchJob(), W);
    expect(none.dimension.score).toBe(0);
    // Nothing stated on either side → not stated, and the prior is applied by the total.
    const silent = logisticsForEstimate(matchUser(NO_LOGISTICS), matchJob(), W);
    expect(silent.dimension).toMatchObject({ status: 'not_stated', evidence: [] });
    expect(silent.byFilters).toBe(false);
  });

  it('a hand-built person: location is a filter when a location, a work model or a country is set; pay with a floor; never the visa answer', () => {
    expect(hardFiltersOf(matchUser({ ...NO_LOGISTICS, needsSponsorship: null }))).toEqual({ location: false, pay: false });
    expect(hardFiltersOf(matchUser({ ...NO_LOGISTICS, country: 'DE' })).location).toBe(true);
    expect(hardFiltersOf(matchUser({ ...NO_LOGISTICS, workModels: ['remote'] })).location).toBe(true);
    expect(hardFiltersOf(matchUser({ ...NO_LOGISTICS, salaryMin: pay })).pay).toBe(true);
    expect(hardFiltersOf(matchUser({ needsSponsorship: true }))).toEqual({ location: true, pay: true });
    expect(hardFiltersOf(matchUser({ ...NO_LOGISTICS, needsSponsorship: true }))).toEqual({ location: false, pay: false });
  });
});

describe('coverage and confidence', () => {
  it.each([
    [0.49, 'low'],
    [0.5, 'medium'],
    [0.74, 'medium'],
    [0.75, 'high'],
    [0, 'low'],
    [1, 'high'],
  ])('coverage %s → %s', (coverage, confidence) => {
    expect(confidenceFor(coverage)).toBe(confidence);
    // A thin posting (or an onboarding-only level) is low whatever the coverage.
    expect(confidenceFor(coverage, true)).toBe('low');
  });

  it('the thresholds as the estimate reaches them, through the weights', () => {
    // Only the role is comparable (no skills, no industry, no logistics answers): coverage = the title weight.
    const user = matchUser({ employerIndustries: [], ...NO_LOGISTICS });
    const job = matchJob({ skills: [], skillsDetail: null });
    const at = (title: number) => preScore(user, job, { ...CFG, weights: { title_level: title, skills: 100 - title - 10, industry: 0, logistics: 0, career_path: 10 } });
    // The posting states its role and level and nothing else: `title` of 90 points. Under 60% → low, whatever the coverage.
    expect(at(49)).toMatchObject({ coverage: 0.49, confidence: 'low' });
    expect(at(50)).toMatchObject({ coverage: 0.5, confidence: 'low', postingCoverage: 0.556 });
    // From 54 of 90 the posting states 60%: the coverage decides.
    expect(at(54)).toMatchObject({ coverage: 0.54, confidence: 'medium', postingCoverage: 0.6, confidenceReason: null });
    expect(at(74)).toMatchObject({ coverage: 0.74, confidence: 'medium' });
    expect(at(75)).toMatchObject({ coverage: 0.75, confidence: 'high' });
  });

  it('coverage: the weight of the parts backed on both sides; career_path never counts', () => {
    const full = preScoreDimensions(matchUser({ ...NO_LOGISTICS, country: 'DE', hardFilters: { location: false, pay: false } }), matchJob(), W);
    expect(full.filter((d) => d.status === 'scored').map((d) => d.key)).toEqual(['title_level', 'skills', 'industry', 'logistics']);
    expect(coverageOf(full)).toBe(0.9);
    // A logistics part met only through the person's own filters is not scored, so it is not in the coverage.
    const byFilters = preScoreDimensions(matchUser(), matchJob(), W);
    expect(byFilters.filter((d) => d.status === 'scored').map((d) => d.key)).toEqual(['title_level', 'skills', 'industry']);
    expect(coverageOf(byFilters)).toBe(0.8);
    expect(coverageOf([{ key: 'career_path', weight: 10, score: 80, status: 'scored', evidence: [] }])).toBe(0);
  });

  it('what the posting states: role and level, hard skills, the employer industry, a location or pay', () => {
    expect(postingCoverageOf(matchJob(), W)).toBe(1);
    // A role with no stated level is half of that part.
    expect(postingCoverageOf(matchJob({ seniority: null }), W)).toBeCloseTo((17.5 + 30 + 15 + 10) / 90, 6);
    expect(postingCoverageOf(matchJob({ skills: [], skillsDetail: null }), W)).toBeCloseTo(60 / 90, 6);
    expect(postingCoverageOf(matchJob({ companyIndustries: [] }), W)).toBeCloseTo(75 / 90, 6);
    const nowhere = { location: null, locationCity: null, locationCountry: null, geoLat: null, geoLng: null, workModel: null, salaryAnnualMin: null, salaryAnnualMax: null };
    expect(postingCoverageOf(matchJob(nowhere), W)).toBeCloseTo(80 / 90, 6);
    // Pay alone states the logistics part.
    expect(postingCoverageOf(matchJob({ ...nowhere, salaryAnnualMax: 90000 }), W)).toBe(1);
    expect(postingCoverageOf(matchJob({ title: 'Zzz', taxonomyIds: [], primaryTaxonomyId: null }), W)).toBeCloseTo(55 / 90, 6);
  });

  it('I4: a posting that states under 60% of the rubric is never Great and its confidence is low', () => {
    // No skills and no level: under 60% whatever else the posting says (industry and location are stated here).
    const thin = matchJob({ skills: [], skillsDetail: null, seniority: null });
    expect(postingCoverageOf(thin, W)).toBeLessThan(0.6);
    for (const user of [matchUser(), matchUser({ recentTitle: 'Senior Backend Engineer', ...NO_LOGISTICS, country: 'DE', hardFilters: { location: false, pay: false } })]) {
      const r = preScore(user, thin, CFG);
      expect(r.confidence).toBe('low');
      expect(r.confidenceReason).toBe('no_skills_listed');
      expect(r.tier).not.toBe('great');
      expect(r.limit).toBeLessThanOrEqual(CFG.tiers.great - 1);
    }
    // The cap holds even with priors that would lift the total past the Great line.
    const lifted = preScore(matchUser(), matchJob({ seniority: null, companyIndustries: [], location: null, locationCity: null, locationCountry: null, geoLat: null, geoLng: null, workModel: null, salaryAnnualMin: null, salaryAnnualMax: null }), {
      ...CFG,
      priors: { title_level: 100, skills: 100, industry: 100, logistics: 100, career_path: 100 },
    });
    expect(lifted.postingCoverage).toBeLessThan(0.6);
    expect(lifted.score).toBe(CFG.tiers.great - 1);
    expect(lifted.confidence).toBe('low');
  });

  it('the reason is the first that applies: no skills, no level, no role evidence, no resume, few details', () => {
    const thinBase = { companyIndustries: [], location: null, locationCity: null, locationCountry: null, geoLat: null, geoLng: null, workModel: null, salaryAnnualMin: null, salaryAnnualMax: null };
    const reason = (user: Parameters<typeof preScore>[0], job: Parameters<typeof preScore>[1]) => {
      const r = preScore(user, job, CFG);
      expect(r.confidence).toBe('low');
      return r.confidenceReason;
    };
    expect(reason(matchUser(), matchJob({ skills: [], skillsDetail: null, companyIndustries: [] }))).toBe('no_skills_listed');
    expect(reason(matchUser(), matchJob({ ...thinBase, seniority: null }))).toBe('no_level_stated');
    const noRole = matchUser({ evidenceRoleIds: [], skills: [], employerIndustries: [], ...NO_LOGISTICS });
    expect(reason(noRole, matchJob())).toBe('no_role_evidence');
    const noResume = matchUser({ skills: [], resumeSeniority: 'intern_newgrad', levelSource: 'onboarding', hasResume: false });
    expect(reason(noResume, matchJob())).toBe('no_resume');
    // A level that is only the onboarding answer: low, even with every part compared.
    expect(reason(matchUser({ resumeSeniority: 'intern_newgrad', levelSource: 'onboarding' }), matchJob({ seniority: 'intern_newgrad' }))).toBe('few_details');
    // High or medium confidence carries no reason.
    expect(preScore(matchUser(), matchJob(), CFG)).toMatchObject({ confidence: 'high', confidenceReason: null });
  });
});

describe('I3: no chip of the saved search moves a fit', () => {
  /** The same person (profile, experience, resume) with another saved search. */
  const person = (filters: Record<string, unknown>, over: Partial<UserMatchInputs> = {}) =>
    buildMatchUser({ userId: 'u1', market: 'intl', ...defaultUserInputs(), resumeParsed: { skills: ['TypeScript', 'Go'] }, ...over, searchProfile: { version: 1, filters } }, NOW);
  const BASE = defaultUserInputs().searchProfile!.filters as Record<string, unknown>;
  const jobs = [
    matchJob(),
    matchJob({ id: 'intern', title: 'Software Engineering Intern', seniority: 'intern_newgrad' }),
    matchJob({ id: 'analyst', title: 'Data Analyst', taxonomyIds: ['data_ai', 'data_analytics', 'data_analyst'], primaryTaxonomyId: 'data_analyst', skills: ['sql'] }),
    matchJob({ id: 'thin', skills: [], skillsDetail: null, seniority: null }),
  ];

  it.each([
    ['seniority', { seniority: ['intern_newgrad', 'entry'] }],
    ['seniority removed', { seniority: undefined }],
    ['taxonomyIds', { taxonomyIds: ['data_analyst'] }],
    ['taxonomyIds removed', { taxonomyIds: undefined }],
    ['titles', { titles: ['Data Analyst', 'Product Manager'] }],
    ['skills', { skills: ['sql', 'excel'] }],
    ['companies', { companies: ['Acme', 'PayCo'], excludedCompanies: ['Globex'], preferredCompanies: ['Initech'] }],
    ['all of them at once', { seniority: ['director_exec'], taxonomyIds: ['account_executive'], titles: ['Teacher'], skills: ['salesforce'], companies: ['Acme'] }],
  ])('changing filters.%s changes no field of the result', (_name, change) => {
    const before = person(BASE);
    const after = person({ ...BASE, ...change });
    for (const job of jobs) expect(preScore(after, job, CFG), job.id).toEqual(preScore(before, job, CFG));
  });

  it.each([
    ['the location', { locations: [{ label: 'Munich', city: 'Munich', country: 'DE', radiusKm: 30, lat: 48.137, lng: 11.575 }] }],
    ['the pay floor', { salaryMin: { amount: 150000, currency: 'EUR', period: 'year' } }],
    ['no pay floor', { salaryMin: undefined }],
    ['the sponsorship answer', { needsSponsorship: true }],
  ])('changing only %s changes the logistics part and the total, and no other part', (_name, change) => {
    const before = person(BASE);
    const after = person({ ...BASE, ...change });
    const job = matchJob({ sponsorship: 'not_offered', sponsorshipEvidence: 'No visa sponsorship.' });
    const a = preScore(before, job, CFG);
    const b = preScore(after, job, CFG);
    const others = (r: typeof a) => r.dimensions.filter((d) => d.key !== 'logistics');
    const logistics = (r: typeof a) => r.dimensions.find((d) => d.key === 'logistics')!;
    expect(others(b)).toEqual(others(a));
    expect(logistics(b)).not.toEqual(logistics(a));
    // The total moves by the logistics part alone: its weight times the change of its score.
    const moved = (W.logistics * ((logistics(b).score ?? P.logistics) - (logistics(a).score ?? P.logistics))) / 100;
    expect(Math.abs(b.score! - a.score! - moved)).toBeLessThanOrEqual(1);
    expect([b.topOverlap, b.topGap, b.softSkills, b.postingCoverage]).toEqual([a.topOverlap, a.topGap, a.softSkills, a.postingCoverage]);
  });

  it('the Level chips do not move any fit, and a senior resume against an internship is at most Possible', () => {
    const scores = [['senior'], [], ['mid'], ['intern_newgrad', 'entry'], ['director_exec']].map((seniority) => preScore(person({ ...BASE, seniority }), jobs[0]!, CFG).score);
    expect(new Set(scores).size).toBe(1);
    // The chips include the internship level: the resume is still a senior engineer's.
    const intern = preScore(person({ ...BASE, seniority: ['intern_newgrad'] }), jobs[1]!, CFG);
    expect(intern.score).toBeLessThan(CFG.tiers.good);
    expect(intern.tier === 'great' || intern.tier === 'good').toBe(false);
  });

  it('two recent titles of "Teacher" give a low title_level for a Data Analyst job, even when the saved search targets data analysts', () => {
    const teacher = person(
      { ...BASE, taxonomyIds: ['data_analyst'], titles: ['Data Analyst'], seniority: ['mid'] },
      {
        experience: [
          { title: 'Teacher', company: 'Lincoln High', startYm: '2021-09', endYm: null, current: true, kind: 'work' },
          { title: 'Teacher', company: 'Roosevelt Middle School', startYm: '2017-09', endYm: '2021-06', current: false, kind: 'work' },
        ],
      },
    );
    expect(teacher.evidenceRoleIds).toEqual(['school_teacher']);
    expect(teacher.targetTaxonomyIds).toEqual(['data_analyst']);
    const title = preScore(teacher, jobs[2]!, CFG).dimensions.find((d) => d.key === 'title_level')!;
    expect(title).toMatchObject({ status: 'scored', score: 0 });
    // The same search for a person whose record shows a data analyst: a full title match.
    const analyst = person({ ...BASE, taxonomyIds: ['data_analyst'] }, { experience: [{ title: 'Data Analyst', company: 'Acme', startYm: '2020-01', endYm: null, current: true, kind: 'work' }] });
    expect(preScore(analyst, matchJob({ ...jobs[2]!, seniority: 'mid' }), CFG).dimensions.find((d) => d.key === 'title_level')!.score).toBeGreaterThanOrEqual(70);
  });
});

describe('role evidence comes from the record', () => {
  const inputs = (over: Partial<UserMatchInputs>): UserMatchInputs => ({ userId: 'u1', market: 'intl', ...defaultUserInputs(), experience: [], resumeParsed: null, ...over });

  it('from the profile experience: the two most recent titles, the current one first', () => {
    const u = buildMatchUser(
      inputs({
        experience: [
          { title: 'Product Manager', company: 'A', startYm: '2015-01', endYm: '2018-12', current: false, kind: 'work' },
          { title: 'Data Analyst', company: 'B', startYm: '2022-01', endYm: null, current: true, kind: 'work' },
          { title: 'Teacher', company: 'C', startYm: '2010-01', endYm: '2014-12', current: false, kind: 'work' },
        ],
      }),
      NOW,
    );
    // The current job, then the first listed: the third title is not evidence.
    expect(u.evidenceRoleIds).toEqual(['data_analyst', 'product_manager']);
  });

  it('from the parsed resume when the profile has no experience', () => {
    const u = buildMatchUser(inputs({ resumeParsed: { experience: [{ role: 'Senior Backend Engineer', startDate: '2020-01', endDate: 'Present' }, { title: 'Data Analyst' }, { role: 'Teacher' }] } }), NOW);
    expect(u.evidenceRoleIds).toEqual(['backend_engineer', 'data_analyst']);
  });

  it('from a headline that names a role, whole or in its first part', () => {
    expect(buildMatchUser(inputs({ profile: { ...defaultUserInputs().profile!, headline: 'Data Analyst' } }), NOW).evidenceRoleIds).toEqual(['data_analyst']);
    expect(buildMatchUser(inputs({ profile: { ...defaultUserInputs().profile!, headline: 'Data Analyst | SQL, Python, dashboards' } }), NOW).evidenceRoleIds).toEqual(['data_analyst']);
    // A headline that names no role is no evidence.
    expect(buildMatchUser(inputs({ profile: { ...defaultUserInputs().profile!, headline: 'Curious, kind, always learning' } }), NOW).evidenceRoleIds).toEqual([]);
    // It adds to the experience titles.
    const both = buildMatchUser(inputs({ profile: { ...defaultUserInputs().profile!, headline: 'Product Manager' }, experience: [{ title: 'Data Analyst', company: 'B', startYm: '2022-01', endYm: null, current: true, kind: 'work' }] }), NOW);
    expect(both.evidenceRoleIds).toEqual(['data_analyst', 'product_manager']);
  });

  it('a person\'s title is placed by the same rule as a posting\'s title: Taiwan titles are folded for the match', () => {
    // Traditional Chinese titles, including Taiwan vocabulary (資料 for 数据): the role tree carries Simplified aliases.
    expect(roleIdOfTitle('資深後端工程師')).toBe('backend_engineer');
    expect(roleIdOfTitle('資料分析師')).toBe('data_analyst');
    expect(roleIdOfTitle('后端开发工程师')).toBe('backend_engineer');
    expect(roleIdOfTitle('Senior Backend Engineer')).toBe('backend_engineer');
    expect(roleIdOfTitle('   ')).toBeNull();
    expect(roleIdOfTitle(null)).toBeNull();
    const tw = buildMatchUser(inputs({ experience: [{ title: '資深後端工程師', company: '某科技', startYm: '2019-01', endYm: null, current: true, kind: 'work' }] }), NOW);
    expect(tw.evidenceRoleIds).toEqual(['backend_engineer']);
    // And the job side: a Taiwan posting with no stored role is placed from its title the same way.
    expect(titleOverlap(tw, matchJob({ title: '後端工程師', taxonomyIds: [], primaryTaxonomyId: null }))).toBe(1);
  });

  it('no evidence → the title part is not stated and takes its prior; the saved search is not read for it', () => {
    // The saved search names a role, a title and a level; the record (no experience, no resume, no headline) shows none.
    const search = { version: 1, filters: { taxonomyIds: ['backend_engineer'], titles: ['Backend Engineer'], seniority: ['senior'] } };
    const u = buildMatchUser(inputs({ searchProfile: search, employerIndustries: [], profile: { ...defaultUserInputs().profile!, country: null } }), NOW);
    expect(u.evidenceRoleIds).toEqual([]);
    expect(u.targetTaxonomyIds).toEqual(['backend_engineer']);
    const r = preScore({ ...u, skills: ['TypeScript', 'Go', 'Kubernetes'] }, matchJob(), CFG);
    const title = r.dimensions.find((d) => d.key === 'title_level')!;
    expect(title).toMatchObject({ status: 'not_stated', score: null });
    // skills 100, the rest at their priors: 35 × 44 + 30 × 100 + 15 × 24 + 10 × 50 + 10 × 45 = 58.5
    expect(r.score).toBe(Math.round((35 * 44 + 30 * 100 + 15 * 24 + 10 * 50 + 10 * 45) / 100));
    expect(r).toMatchObject({ coverage: 0.3, confidence: 'low', confidenceReason: 'no_role_evidence' });
    // With the role filter the old estimate said 100 here; now a job inside the filter is at most Possible on skills alone.
    expect(r.tier).toBe('possible');
  });
});

describe('combining and tiers', () => {
  it('the AI total still renormalises over the scored components (its arithmetic is unchanged)', () => {
    const dims = preScoreDimensions(matchUser({ employerIndustries: [] }), matchJob(), W);
    expect(dims.find((d) => d.key === 'industry')!.status).toBe('not_stated');
    expect(dims.find((d) => d.key === 'career_path')!.status).toBe('not_stated');
    // Logistics only repeats the person's filters here, so the estimate does not compare it either.
    expect(dims.find((d) => d.key === 'logistics')!.status).toBe('not_stated');
    // title 100 (35) + skills 67 (30), over 65
    expect(combineDimensions(dims)).toBe(Math.round((35 * 100 + 30 * 67) / 65));
    // The estimate: the same parts, with the priors for the three that are not compared.
    expect(combineWithPriors(dims, P)).toBe(Math.round((35 * 100 + 30 * 67 + 15 * 24 + 10 * 50 + 10 * 45) / 100));
    // With location and pay as facts the AI arithmetic counts them: title 100 (35) + skills 67 (30) + logistics 100 (10), over 75.
    const facts = preScoreDimensions(matchUser({ employerIndustries: [], hardFilters: { location: false, pay: false } }), matchJob(), W);
    expect(combineDimensions(facts)).toBe(Math.round((35 * 100 + 30 * 67 + 10 * 100) / 75));
  });

  it.each([
    [80, 'great'],
    [79, 'good'],
    [65, 'good'],
    [64, 'possible'],
    [45, 'possible'],
    [44, 'unlikely'],
    [0, 'unlikely'],
  ])('tier boundaries 80/65/45: %s → %s', (score, tier) => {
    expect(tierForScore(score)).toBe(tier);
  });

  it('preScore returns the tier, an overlap and a gap from real fields, with its coverage and confidence', () => {
    const r = preScore(matchUser(), matchJob({ skillsDetail: [{ skill: 'Kubernetes', required: true }] }), CFG);
    expect(r.kind).toBe('pre');
    expect(r.topGap).toBe('Kubernetes');
    expect(r.topOverlap).toBe('TypeScript');
    expect(r.tier).toBe(tierForScore(r.score!));
    expect(r).toMatchObject({ coverage: 0.8, confidence: 'high', confidenceReason: null, postingCoverage: 1, softSkills: [], limit: 100 });
  });

  it('GoApply: school tier is never an input (C15)', () => {
    const base = matchUser({ market: 'cn' });
    const job = matchJob({ market: 'cn' });
    const withTier = { ...base, schoolTiers: ['985'], schoolTags: ['985', '211'], schoolName: '清华大学' } as never;
    expect(preScore(withTier, job, CFG)).toEqual(preScore(base, job, CFG));
  });
});
