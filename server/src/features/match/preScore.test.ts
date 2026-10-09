// @vitest-environment node
// WP-18 — the deterministic pre-score (ARCH §4.7): table tests per component.
import { describe, expect, it } from 'vitest';

import { DEFAULT_MATCH_TIERS, DEFAULT_MATCH_WEIGHTS, tierForScore } from './contract.js';
import {
  combineDimensions,
  degreeMeets,
  industryDimension,
  locationCheck,
  logisticsDimension,
  needsSponsorshipFor,
  payCheck,
  preScore,
  preScoreDimensions,
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
import { matchJob, matchUser } from './testkit.js';

const W = { ...DEFAULT_MATCH_WEIGHTS };
const CFG = { weights: W, tiers: { ...DEFAULT_MATCH_TIERS } };

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

  it('falls back to title matching when the job or the user has no taxonomy ids', () => {
    const user = matchUser({ targetTaxonomyIds: [], targetTitles: ['Backend Engineer'] });
    const job = matchJob({ taxonomyIds: [], primaryTaxonomyId: null, title: 'Senior Backend Engineer' });
    expect(titleOverlap(user, job)).toBe(1);
    expect(titleOverlap(matchUser({ targetTaxonomyIds: [], targetTitles: [], recentTitle: null }), job)).toBeNull();
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
    const d = titleLevelDimension(matchUser({ targetSeniority: ['mid'] }), matchJob({ seniority: 'senior' }), W);
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

describe('skills = |job ∩ user| / min(|job|, 10)', () => {
  it.each([
    [['TypeScript', 'Go'], ['typescript', 'go', 'kubernetes'], 67],
    [['typescript', 'GO', 'Kubernetes'], ['typescript', 'go', 'kubernetes'], 100],
    [[], ['typescript'], 0],
    [['Node.js'], ['nodejs'], 100],
  ])('user %j vs job %j → %s', (userSkills, jobSkills, score) => {
    const d = skillsDimension(matchUser({ skills: userSkills as string[] }), matchJob({ skills: jobSkills as string[] }), W);
    expect(d.score).toBe(score);
  });

  it('caps the denominator at 10', () => {
    const many = Array.from({ length: 20 }, (_, i) => `skill${i}`);
    const d = skillsDimension(matchUser({ skills: many.slice(0, 10) }), matchJob({ skills: many }), W);
    expect(d.score).toBe(100);
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
    expect(splitSkills(user, job)).toEqual({ aligned: ['typescript', 'go', 'kubernetes'], missing: ['rust'], missingRequired: [] });
    expect(skillsDimension(user, job, W).score).toBe(75);
    expect(skillsDimension(user, job, W).evidence).toContainEqual({ text: 'rust', source: 'posting', ref: 'skill_missing' });
    const skillsRow = buildKeywordRows({ job: { ...job, minYears: null }, user, resumeText: resume, keywords: null }).find((r) => r.key === 'skills')!;
    expect(skillsRow.items.filter((i) => !i.found).map((i) => i.term)).toEqual(['rust']);
    // Whole words only: "Go" is not found inside "Google".
    const google = matchUser({ skills: [], resumeTextNorm: normalizeText('Worked at Google.') });
    expect(splitSkills(google, matchJob({ skills: ['go'], skillsDetail: null })).missing).toEqual(['go']);
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

  it('averages the stated checks; all not stated → not stated', () => {
    const half = logisticsDimension(matchUser({ salaryMin: { amount: 100000, currency: 'EUR', period: 'year' } }), matchJob(), W);
    expect(half.score).toBe(50);
    expect(half.evidence.map((e) => e.ref)).toEqual(['location_met', 'pay_not_met']);
    const none = logisticsDimension(matchUser({ locations: [], workModels: [], country: null, salaryMin: null }), matchJob(), W);
    expect(none.status).toBe('not_stated');
  });
});

describe('combining and tiers', () => {
  it('not_stated components drop out and the weights renormalize', () => {
    const dims = preScoreDimensions(matchUser({ employerIndustries: [] }), matchJob(), W);
    expect(dims.find((d) => d.key === 'industry')!.status).toBe('not_stated');
    expect(dims.find((d) => d.key === 'career_path')!.status).toBe('not_stated');
    // title 100 (35) + skills 67 (30) + logistics 100 (10) over 75
    expect(combineDimensions(dims)).toBe(Math.round((35 * 100 + 30 * 67 + 10 * 100) / 75));
  });

  it('nothing to compare → null, never 0', () => {
    const user = matchUser({ targetTaxonomyIds: [], targetTitles: [], recentTitle: null, skills: [], employerIndustries: [], locations: [], workModels: [], country: null, salaryMin: null });
    const r = preScore(user, matchJob({ skills: [], taxonomyIds: [], primaryTaxonomyId: null, title: 'Zzz', companyIndustries: [] }), CFG);
    expect(r.score).toBeNull();
    expect(r.tier).toBeNull();
    expect(r.kind).toBe('pre');
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

  it('preScore returns the tier, an overlap and a gap from real fields', () => {
    const r = preScore(matchUser(), matchJob({ skillsDetail: [{ skill: 'Kubernetes', required: true }] }), CFG);
    expect(r.kind).toBe('pre');
    expect(r.topGap).toBe('Kubernetes');
    expect(r.topOverlap).toBe('typescript');
    expect(r.tier).toBe(tierForScore(r.score!));
  });

  it('GoApply: school tier is never an input (C15)', () => {
    const base = matchUser({ market: 'cn' });
    const job = matchJob({ market: 'cn' });
    const withTier = { ...base, schoolTiers: ['985'], schoolTags: ['985', '211'], schoolName: '清华大学' } as never;
    expect(preScore(withTier, job, CFG)).toEqual(preScore(base, job, CFG));
  });
});
