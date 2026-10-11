// @vitest-environment node
// WP-34: job detail — market and owner visibility, the honest view (pay,
// quotes, badges, sourced company facts), apply-click (applied at once,
// idempotent, undoable), save (+ growth checklist), share (public only with
// publicDisplay), similar jobs (hidden/flagged excluded, best fit first),
// People search links, GoApply campus window, company news (dark), routes.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import type { RequestHandler } from 'express';
import { getBrand } from '../../../platform/brand/registry.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import type { CompanyProfile } from '../companies/contract.js';
import type { MatchFitView } from '../../match/contract.js';
import { fitToView, type Fit } from '../../match/fit.js';
import { fitFixture, fitsFixture } from '../../agent/__tests__/fitFixture.js';
import { LOGISTICS_BY_FILTERS_REF } from '../../match/preScore.js';
import { fitBadge } from '../../feed/ranking.js';
import { REQUIREMENT_TAGS } from '../enrich/reconcile.js';
import { cardMeta } from '../marketHooks.js';
import { JOB_REQUIREMENT_TAGS, type JobDetailResponse } from './contract.js';
import { createJobDetailRouter } from './routes.js';
import { explainNow, practicedForJobFrom, similarFromFeed } from './defaultService.js';
import { SIMILAR_LIMIT, SIMILAR_SOURCE_LIMIT, createJobDetailService, trackerEntryLockKey, type JobDetailDb, type JobDetailServiceDeps } from './service.js';
import { NEWS_CACHE_MAX, clearNewsCache, newsCacheSize, searchCompanyNews, toNewsItems } from './newsSearch.js';
import {
  classYearsOf,
  peopleSearchLinks,
  searchRole,
  shareTarget,
  slugify,
  toBadges,
  toCampusInfo,
  toPay,
  toRequirements,
  toJobDetail,
  toSections,
  toFitBadge,
  toSponsorship,
  type JobRow,
} from './view.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const DAY = 86_400_000;
const intl = getBrand('roboapply');
const cn = getBrand('goapply');

function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'j1',
    externalId: 'x1',
    title: 'Backend Engineer',
    titleNormalized: 'backend engineer',
    companyId: 'c1',
    companyName: 'Acme',
    companyLogoUrl: null,
    location: 'Austin, TX',
    locationCountry: 'US',
    workModel: 'hybrid',
    employmentType: 'full_time',
    seniority: 'mid',
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: 'USD',
    salaryPeriod: 'year',
    salaryText: null,
    salaryDisclosed: false,
    description: 'Build APIs.',
    qualifications: '- 3+ years of Go',
    responsibilities: '- Own the payments API',
    benefits: null,
    summary: 'A backend role on the payments team.',
    skillsDetail: [{ skill: 'Go', kind: 'hard', required: true }],
    sponsorship: 'offered',
    sponsorshipEvidence: 'We sponsor H-1B visas.',
    marketTags: [{ tag: 'clearance_required', evidenceQuote: 'Active Secret clearance required.', evidenceUrl: null }],
    fraudFlags: null,
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    atsType: 'greenhouse',
    postedAt: new Date(NOW.getTime() - DAY),
    postedAtEstimated: false,
    lastSeenAt: NOW,
    closedAt: null,
    archivedAt: null,
    sourceBoard: 'activejobs',
    sourceName: 'Active Jobs DB',
    originalSourceName: null,
    sourceUrl: null,
    fromRecruiterBank: false,
    employerVerified: false,
    isAgency: null,
    market: 'intl',
    visibility: 'public',
    ownerUserId: null,
    isCanonical: true,
    publicDisplay: false,
    slug: null,
    primaryTaxonomyId: 'backend_engineer',
    ...over,
  };
}

const PROFILE: CompanyProfile = {
  id: 'c1',
  name: 'Acme',
  slug: 'acme',
  logoUrl: null,
  domain: null,
  facts: { industry: { value: 'Software', source: 'provider:activejobs', asOf: '2026-10-01T00:00:00.000Z' } },
  openJobs: { value: 12, source: 'index', asOf: NOW.toISOString(), method: 'computed' },
};

function fitView(over: Partial<MatchFitView> = {}): MatchFitView {
  return {
    jobId: 'j1',
    score: 82,
    tier: 'great',
    kind: 'pre',
    dimensions: [{ key: 'skills', weight: 30, score: 90, status: 'scored', evidence: [{ text: 'Go', source: 'resume', ref: 'skill_have' }] }],
    summary: null,
    strengths: [],
    gaps: [],
    keywordsMatched: [],
    keywordsMissing: [],
    skills: { aligned: ['Go'], missing: [], listed: 1 },
    topOverlap: 'Go',
    topGap: null,
    scoredAt: NOW.toISOString(),
    resumeVariantId: 'rv1',
    estimateReason: 'ai_off',
    summaryLocaleStale: false,
    cached: true,
    ...over,
  };
}

/** THE fit of the job page in these tests: a quick estimate (82, Great) with one skills line. */
function pageFit(over: Partial<Fit> = {}): Fit {
  return fitFixture({
    jobId: 'j1',
    score: 82,
    tier: 'great',
    kind: 'estimate',
    dimensions: [{ key: 'skills', weight: 30, score: 90, status: 'scored', evidence: [{ text: 'Go', source: 'resume', ref: 'skill_have' }] }],
    skills: { aligned: ['Go'], missing: [], softSkills: [], listed: 1 },
    topOverlap: 'Go',
    estimateReason: 'ai_off',
    ...over,
  });
}

/** `getFits` for the Similar list of the older tests: 50, 60, 70 … in list order, and no fit for j4. */
const listFits = async (_u: string, ids: string[]) =>
  fitsFixture(ids.filter((id) => id !== 'j4').map((id) => fitFixture({ jobId: id, score: 50 + ids.indexOf(id) * 10, tier: 'possible', kind: 'estimate' })));

function setup(opts: { jobs?: Record<string, unknown>[]; seed?: Record<string, Record<string, unknown>[]>; deps?: Partial<JobDetailServiceDeps>; brand?: typeof intl } = {}) {
  const db = createFakePrisma({
    seed: {
      rAJob: opts.jobs ?? [job()],
      rATrackerEntry: [],
      rATrackerEvent: [],
      rAJobUserState: [],
      rAJobInteraction: [],
      rAResumeVariant: [],
      rACoverLetter: [],
      rACampusEvent: [],
      ...(opts.seed ?? {}),
    },
  });
  const markChecklistStep = vi.fn(async () => ({}));
  const flags = new Set<string>(['extension', 'jobs.recommendations']);
  const deps: JobDetailServiceDeps = {
    db: db as unknown as JobDetailDb,
    brand: () => opts.brand ?? intl,
    now: () => NOW,
    companyProfile: async () => PROFILE,
    fit: async () => pageFit(),
    fits: listFits,
    explain: ({ personalized }) => ({ mode: personalized ? 'personalized' : 'non_personalized', headline: { key: 'legal.explain.headline.personalized' }, reasons: [], gaps: [], notices: [] }),
    personalized: async () => true,
    peopleContext: async () => ({ pastCompanies: ['Globex', 'Acme'], schools: ['State University'] }),
    markChecklistStep,
    isEnabled: async (key) => flags.has(key),
    hiringContacts: async () => 'deeplinks_only',
    marketMeta: () => ({}),
    extensionAts: () => new Set(['greenhouse']),
    // Nothing set: GoApply postings are shown by default (D5). The off switch
    // has its own test ('GoApply with CN_RECRUITMENT_INFO_MODE=off').
    env: {},
    ...opts.deps,
  };
  return { db, deps, flags, markChecklistStep, service: createJobDetailService(deps) };
}

// ── Pure view ─────────────────────────────────────────────────────────────

describe('view rules (D3)', () => {
  it('pay: only stated pay; undisclosed or zero is null ("Pay not listed")', () => {
    const base = { salaryMin: 100000, salaryMax: 150000, salaryCurrency: 'USD', salaryPeriod: 'year', salaryText: null, salaryDisclosed: true };
    expect(toPay(base)).toEqual({ min: 100000, max: 150000, currency: 'USD', period: 'year', text: null });
    expect(toPay({ ...base, salaryDisclosed: false })).toBeNull();
    expect(toPay({ ...base, salaryMin: 0, salaryMax: 0 })).toBeNull();
    expect(toPay({ ...base, salaryPeriod: 'decade' })).toBeNull();
    expect(toPay({ ...base, salaryCurrency: null })).toBeNull();
  });

  it('sections are verbatim; the description only when nothing was split out', () => {
    expect(toSections({ responsibilities: ' a ', qualifications: null, benefits: 'b', description: 'all' })).toEqual([
      { kind: 'responsibilities', body: 'a' },
      { kind: 'benefits', body: 'b' },
    ]);
    expect(toSections({ responsibilities: null, qualifications: '', benefits: null, description: 'all' })).toEqual([{ kind: 'description', body: 'all' }]);
    expect(toSections({ responsibilities: null, qualifications: null, benefits: null, description: '  ' })).toEqual([]);
  });

  it('sponsorship needs the posting quote; otherwise it is not stated', () => {
    expect(toSponsorship({ sponsorship: 'offered', sponsorshipEvidence: 'We sponsor.' })).toEqual({ status: 'offered', quote: 'We sponsor.' });
    expect(toSponsorship({ sponsorship: 'not_offered', sponsorshipEvidence: '' })).toEqual({ status: 'not_stated', quote: null });
    expect(toSponsorship({ sponsorship: null, sponsorshipEvidence: 'x' })).toEqual({ status: 'not_stated', quote: null });
  });

  it('requirement lines carry their quote; unknown tags and empty quotes are dropped', () => {
    expect(
      toRequirements([
        { tag: 'citizenship_required', evidenceQuote: 'US citizens only.' },
        { tag: 'citizenship_required', evidenceQuote: 'dup' },
        { tag: 'hukou', evidenceQuote: '户口' },
        { tag: 'clearance_required', evidenceQuote: ' ' },
      ]),
    ).toEqual([{ tag: 'citizenship_required', quote: 'US citizens only.' }]);
    expect(toRequirements(null)).toEqual([]);
  });

  it('requirement tags mirror the enrichment list', () => {
    expect([...JOB_REQUIREMENT_TAGS]).toEqual([...REQUIREMENT_TAGS]);
  });

  it('"Direct from employer" only for verified, non-agency recruiter-bank jobs; at most 3 badges', () => {
    const row = { fromRecruiterBank: true, employerVerified: true, isAgency: false, sponsorship: 'offered', sponsorshipEvidence: 'We sponsor.', postedAt: new Date(NOW.getTime() - DAY), postedAtEstimated: false };
    expect(toBadges(row, NOW).map((b) => b.kind)).toEqual(['direct_from_employer', 'sponsorship', 'new']);
    expect(toBadges({ ...row, employerVerified: false }, NOW).map((b) => b.kind)).not.toContain('direct_from_employer');
    expect(toBadges({ ...row, isAgency: true }, NOW).map((b) => b.kind)).not.toContain('direct_from_employer');
    expect(toBadges({ ...row, fromRecruiterBank: false }, NOW).map((b) => b.kind)).not.toContain('direct_from_employer');
    expect(toBadges({ ...row, postedAtEstimated: true }, NOW).map((b) => b.kind)).not.toContain('new');
    expect(toBadges(row, NOW).find((b) => b.kind === 'sponsorship')?.quote).toBe('We sponsor.');
  });

  it('share: public page only with publicDisplay on a live canonical public job', () => {
    const row = { id: 'j1', title: 'Backend Engineer', slug: null, publicDisplay: true, visibility: 'public', isCanonical: true, closedAt: null, archivedAt: null };
    expect(shareTarget(intl, row)).toEqual({ url: 'https://www.roboapply.io/job/j1-backend-engineer', public: true });
    expect(shareTarget(intl, { ...row, publicDisplay: false })).toEqual({ url: 'https://www.roboapply.io/jobs/j1', public: false });
    expect(shareTarget(cn, { ...row, closedAt: NOW })).toEqual({ url: 'https://www.goapply.top/jobs/j1', public: false });
    expect(shareTarget(intl, { ...row, visibility: 'private' }).public).toBe(false);
    expect(shareTarget(intl, { ...row, title: '后端工程师' }).url).toBe('https://www.roboapply.io/job/j1');
    expect(slugify('Senior Software Engineer, Payments (Remote)')).toBe('senior-software-engineer-payments-remote');
  });

  it('People: three LinkedIn searches; none on GoApply; missing profile data leaves the link empty', () => {
    const links = peopleSearchLinks({ title: 'Backend Engineer', companyName: 'Acme' }, { pastCompanies: ['Acme', 'Globex', 'globex', 'Initech'], schools: [] }, 'intl');
    expect(links.map((l) => l.kind)).toEqual(['role', 'past_companies', 'schools']);
    expect(links[0]!.url).toMatch(/^https:\/\/www\.linkedin\.com\/search\/results\/people\/\?keywords=/);
    expect(decodeURIComponent(links[1]!.url!.replace(/\+/g, ' '))).toContain('"Acme" ("Globex" OR "Initech")');
    expect(links[1]!.params.companies).toBe('Globex, Initech');
    expect(links[2]!.url).toBeNull();
    expect(peopleSearchLinks({ title: 'x', companyName: 'Acme' }, { pastCompanies: [], schools: [] }, 'cn')).toEqual([]);
  });

  it('FIX-3: the role search uses the role, not the whole posting headline', () => {
    const headline = 'Product Designer - Gaming Communities (In-Office NYC)';
    const [role] = peopleSearchLinks({ title: headline, companyName: 'General Intuition & Medal' }, { pastCompanies: [], schools: [] }, 'intl');
    const keywords = new URL(role!.url!).searchParams.get('keywords');
    expect(keywords).toBe('"General Intuition & Medal" Product designer');
    expect(role!.params).toEqual({ company: 'General Intuition & Medal', title: 'Product designer' });
    // The role the job was placed in wins; an unplaced title loses its notes and level words.
    expect(searchRole({ title: 'Sr. SWE II (Payments)', primaryTaxonomyId: 'backend_engineer' })).toBe('Backend engineer');
    expect(searchRole({ title: 'Senior Software Engineer, Backend' })).toBe('Backend engineer');
    expect(searchRole({ title: 'Senior Zymurgist II - Night Shift (Portland, OR)' })).toBe('Zymurgist');
    expect(searchRole({ title: 'Lead Zymurgist | Brewery' })).toBe('Zymurgist');
    expect(searchRole({ title: 'Zymurgist' })).toBe('Zymurgist');
  });

  it('People: a taxonomy name that groups several roles is not used as the search words', () => {
    // "Server, barista or bartender", "Finance manager / controller", "Chef or cook", "NLP and LLM engineer".
    expect(searchRole({ title: 'Barista', primaryTaxonomyId: 'server' })).toBe('Barista');
    expect(searchRole({ title: 'Barista (Part-time) - Downtown', primaryTaxonomyId: 'server' })).toBe('Barista');
    // A bare one-word role keeps the field named after its comma (FIX-3 carry-over): "Manager" alone finds no one useful.
    expect(searchRole({ title: 'Sr. Manager, Strategic Finance - EMEA', primaryTaxonomyId: 'finance_leader' })).toBe('Strategic Finance Manager');
    expect(searchRole({ title: 'Director, Product Management (Remote)', primaryTaxonomyId: 'finance_leader' })).toBe('Product Management Director');
    // A short field is a field: only a code written in capitals (EMEA, APAC, UK) is a region.
    expect(searchRole({ title: 'Director, Legal', primaryTaxonomyId: 'finance_leader' })).toBe('Legal Director');
    expect(searchRole({ title: 'Analyst, Risk', primaryTaxonomyId: 'finance_leader' })).toBe('Risk Analyst');
    expect(searchRole({ title: 'Manager, Tax', primaryTaxonomyId: 'finance_leader' })).toBe('Tax Manager');
    expect(searchRole({ title: 'Specialist, Audit - APAC', primaryTaxonomyId: 'finance_leader' })).toBe('Audit Specialist');
    expect(searchRole({ title: 'Manager, APAC', primaryTaxonomyId: 'finance_leader' })).toBe('Manager');
    expect(searchRole({ title: 'Manager, UK, Tax', primaryTaxonomyId: 'finance_leader' })).toBe('Tax Manager');
    expect(searchRole({ title: 'Manager, Remote', primaryTaxonomyId: 'finance_leader' })).toBe('Manager');
    expect(searchRole({ title: 'Engineer, II', primaryTaxonomyId: 'finance_leader' })).toBe('Engineer');
    // What follows the comma is a place, an arrangement or a level: not a field, so nothing is added.
    for (const title of ['Zymurgist, London', 'Zymurgist, Germany', 'Zymurgist, EMEA', 'Zymurgist, Remote', 'Zymurgist, Senior', 'Zymurgist, Part-time', 'Zymurgist, Night Shift 2']) {
      expect(searchRole({ title }), title).toBe('Zymurgist');
    }
    // A role that already has its own words is not rearranged.
    expect(searchRole({ title: 'Line Cook, Pastry', primaryTaxonomyId: 'chef' })).toBe('Line Cook');
    expect(searchRole({ title: 'Line Cook', primaryTaxonomyId: 'chef' })).toBe('Line Cook');
    expect(searchRole({ title: 'Senior LLM Engineer (Remote)', primaryTaxonomyId: 'nlp_engineer' })).toBe('LLM Engineer');
    // Unplaced, and the title matches a grouped role: the title's own words.
    expect(searchRole({ title: 'Bartender' })).toBe('Bartender');
    const links = peopleSearchLinks({ title: 'Barista', companyName: 'Blue Bottle', primaryTaxonomyId: 'server' }, { pastCompanies: [], schools: [] }, 'intl');
    expect(links[0]).toMatchObject({ kind: 'role', params: { company: 'Blue Bottle', title: 'Barista' } });
    expect(new URL(links[0]!.url!).searchParams.get('keywords')).toBe('"Blue Bottle" Barista');
  });

  it('campus: 届别 parsed; official link required; stale verification flagged', () => {
    expect(classYearsOf('2027届')).toEqual([2027]);
    expect(classYearsOf('2026-2027届')).toEqual([2026, 2027]);
    const ev = { title: '2027届校园招聘', graduationClass: '2027届', applyOpensAt: new Date('2026-09-01'), applyClosesAt: new Date('2026-11-30'), officialUrl: 'https://campus.example.cn', verifiedAt: new Date(NOW.getTime() - 2 * DAY) };
    expect(toCampusInfo(ev, NOW)).toMatchObject({ classYears: [2027], needsCheck: false, officialUrl: 'https://campus.example.cn' });
    expect(toCampusInfo({ ...ev, verifiedAt: new Date(NOW.getTime() - 20 * DAY) }, NOW)!.needsCheck).toBe(true);
    expect(toCampusInfo({ ...ev, officialUrl: '' }, NOW)).toBeNull();
  });
});

// ── Service ───────────────────────────────────────────────────────────────

// ── Source and apply contract on the job page (GOAPPLY_PARITY_PLAN §5; MARKET_STRATEGY M-7, JC-1) ──

describe('job page: source line, apply target, salary (the same rule as the feed card)', () => {
  const cnBoard = (over: Record<string, unknown> = {}) =>
    job({
      id: 'b1',
      market: 'cn',
      companyName: '示例汽车（中国）投资有限公司',
      sourceBoard: 'smartrecruiters',
      sourceName: '示例汽车 · SmartRecruiters',
      originalSourceName: null,
      applyUrl: 'https://jobs.smartrecruiters.com/ExampleAuto/123-apply',
      sourceUrl: 'https://jobs.smartrecruiters.com/ExampleAuto/123',
      atsType: 'smartrecruiters',
      ...over,
    });
  const cnBank = (over: Record<string, unknown> = {}) =>
    job({ id: 'g1', market: 'cn', sourceBoard: 'gohire', sourceName: 'GoHire', fromRecruiterBank: true, applyUrl: 'https://jobs.gohire.example/p/g1', sourceUrl: 'https://jobs.gohire.example/p/g1', ...over });

  it('a board row on GoApply: the employer as the original publisher, its original link, a last-verified date, apply.target employer', async () => {
    const s = setup({ brand: cn, jobs: [cnBoard()] });
    const { job: view } = await s.service.get('u1', 'b1');
    expect(view.source).toEqual({
      name: '示例汽车 · SmartRecruiters',
      kind: 'ats_public',
      originalName: null,
      original: '示例汽车（中国）投资有限公司',
      url: 'https://jobs.smartrecruiters.com/ExampleAuto/123',
      lastVerifiedAt: NOW.toISOString(),
      via: 'ats',
    });
    expect(view.apply).toEqual({ url: 'https://jobs.smartrecruiters.com/ExampleAuto/123-apply', target: 'employer' });
    expect(view.applyUrl).toBe(view.apply!.url);
    expect(view.lastSeenAt).toBe(view.source.lastVerifiedAt);
  });

  it('a bank row: apply.target gohire and its GoHire page, only while GoHire has a posting page', async () => {
    const s = setup({ brand: cn, jobs: [cnBank()] });
    // No posting page: the stored link is the bank site's "Page not found", so the page hands out none.
    const held = (await s.service.get('u1', 'g1')).job;
    expect(held.apply).toBeNull();
    expect(held.applyUrl).toBeNull();
    // …and the apply click has nowhere to send the user: nothing moves to Applied.
    await expect(s.service.recordApplyClick('u1', 'g1')).rejects.toMatchObject({ code: 'conflict', details: { code: 'no_apply_link' } });
    expect(held.source).toMatchObject({ name: 'GoHire', kind: 'bank', via: 'bank' });
    vi.stubEnv('GOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'https://jobs.gohire.example/p/{id}');
    try {
      const { job: view } = await s.service.get('u1', 'g1');
      expect(view.apply).toEqual({ url: 'https://jobs.gohire.example/p/g1', target: 'gohire' });
      expect(view.source).toMatchObject({ name: 'GoHire', kind: 'bank', via: 'bank', lastVerifiedAt: NOW.toISOString() });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the user's own import: via import, no claim about where its link leads; no link → apply null (never invented)", () => {
    const own = job({ market: 'cn', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', sourceName: null, applyUrl: 'https://www.zhipin.example/job/1' }) as unknown as JobRow;
    expect(toJobDetail(own, NOW).apply).toEqual({ url: 'https://www.zhipin.example/job/1', target: null });
    expect(toJobDetail(own, NOW).source).toMatchObject({ kind: 'user_import', via: 'import', original: null });
    const pasted = toJobDetail({ ...own, applyUrl: '' }, NOW);
    expect(pasted.apply).toBeNull();
    expect(pasted.applyUrl).toBeNull();
  });

  it('RoboApply: an aggregator row carries no `via` and no claimed target; a board the page does not know is never called an employer board', () => {
    const agg = toJobDetail(job() as unknown as JobRow, NOW);
    expect(agg.source).toEqual({ name: 'Active Jobs DB', kind: 'provider', originalName: null, original: null, url: 'https://boards.greenhouse.io/acme/jobs/1', lastVerifiedAt: NOW.toISOString() });
    expect(agg.apply).toEqual({ url: 'https://boards.greenhouse.io/acme/jobs/1', target: null });
    // `kind` keeps the page's own reading for an unknown board; the contract facts do not claim a board.
    const unknown = toJobDetail(job({ sourceBoard: 'manual' }) as unknown as JobRow, NOW);
    expect(unknown.source.kind).toBe('ats_public');
    expect(unknown.source).not.toHaveProperty('via');
    expect(unknown.apply?.target).toBeNull();
    // A LinkedIn link is never the original link.
    expect(toJobDetail(job({ sourceUrl: 'https://www.linkedin.com/jobs/view/1', applyUrl: 'https://www.linkedin.com/jobs/view/1' }) as unknown as JobRow, NOW).source.url).toBeNull();
  });

  it('salary: null when the posting states no pay (薪资未披露), never 面议; the posting’s words with N薪 otherwise', () => {
    const none = toJobDetail(cnBoard({ salaryDisclosed: false, salaryMin: null, salaryMax: null, salaryText: null }) as unknown as JobRow, NOW);
    expect(none.salary).toBeNull();
    expect(none.pay).toBeNull();
    expect(toJobDetail(cnBoard({ salaryDisclosed: true, salaryMin: null, salaryMax: null, salaryText: '面议' }) as unknown as JobRow, NOW).salary).toBeNull();
    expect(toJobDetail(cnBoard({ salaryDisclosed: false, salaryMin: 10_000, salaryMax: 20_000, salaryCurrency: 'CNY', salaryPeriod: 'month', salaryText: '面议' }) as unknown as JobRow, NOW).salary).toBeNull();
    const stated = toJobDetail(cnBoard({ salaryDisclosed: true, salaryMin: 18_000, salaryMax: 28_000, salaryCurrency: 'CNY', salaryPeriod: 'month', salaryMonths: 15, salaryText: '18-28K·15薪' }) as unknown as JobRow, NOW);
    expect(stated.salary).toEqual({ text: '18-28K·15薪', min: 18_000, max: 28_000, currency: 'CNY', period: 'month', months: 15 });
    // Stated pay the mainland notation has no line for (another currency, a weekly rate) keeps its figures; a stored 0 is no figure.
    const cnUsd = toJobDetail(cnBoard({ salaryDisclosed: true, salaryMin: 8_000, salaryMax: 12_000, salaryCurrency: 'USD', salaryPeriod: 'month', salaryText: null }) as unknown as JobRow, NOW);
    expect(cnUsd.pay).toMatchObject({ min: 8_000, max: 12_000, currency: 'USD' });
    expect(cnUsd.salary).toEqual({ text: null, min: 8_000, max: 12_000, currency: 'USD', period: 'month', months: null });
    const cnWeekly = toJobDetail(cnBoard({ salaryDisclosed: true, salaryMin: 2_000, salaryMax: 3_000, salaryCurrency: 'CNY', salaryPeriod: 'week', salaryText: null }) as unknown as JobRow, NOW);
    expect(cnWeekly.salary).toMatchObject({ min: 2_000, max: 3_000, currency: 'CNY', period: 'week' });
    expect(toJobDetail(cnBoard({ salaryDisclosed: true, salaryMin: 0, salaryMax: 0, salaryCurrency: 'CNY', salaryPeriod: 'month', salaryText: null }) as unknown as JobRow, NOW).salary).toBeNull();
    // RoboApply: agrees with `pay` / `payText`.
    const usd = toJobDetail(job({ salaryDisclosed: true, salaryMin: 120_000, salaryMax: 150_000 }) as unknown as JobRow, NOW);
    expect(usd.pay).toMatchObject({ min: 120_000, max: 150_000 });
    expect(usd.salary).toEqual({ text: null, min: 120_000, max: 150_000, currency: 'USD', period: 'year', months: null });
    expect(toJobDetail(job({ salaryDisclosed: false }) as unknown as JobRow, NOW).salary).toBeNull();
    const words = toJobDetail(job({ salaryDisclosed: true, salaryMin: null, salaryMax: null, salaryText: 'Up to $90,000 a year' }) as unknown as JobRow, NOW);
    expect(words.salary).toMatchObject({ text: words.payText, min: null, max: null });
  });
});

describe('GET /jobs/:id (service)', () => {
  it('answers the honest view: verbatim sections, quotes, sourced company, cached fit + explanation, checklist, People', async () => {
    const { service } = setup({
      jobs: [job(), job({ id: 'j2' }), job({ id: 'j3', fraudFlags: [{ rule: 'upfront_fee', evidence: 'fee', at: NOW.toISOString() }] }), job({ id: 'j5', locationCountry: 'CA' })],
      seed: {
        rAResumeVariant: [{ id: 'rv_t', userId: 'u1', targetJobId: 'j1', deletedAt: null, createdAt: NOW }],
        rATrackerEntry: [{ id: 't1', userId: 'u1', jobId: 'j1', status: 'bookmarked', dateApplied: null, deletedAt: null, tailoredVariantId: null, coverLetterId: null, createdAt: NOW }],
      },
    });
    const res: JobDetailResponse = await service.get('u1', 'j1');
    expect(res.job).toMatchObject({
      title: 'Backend Engineer',
      pay: null,
      payText: null,
      status: 'open',
      summary: { text: 'A backend role on the payments team.', aiWritten: true },
      sponsorship: { status: 'offered', quote: 'We sponsor H-1B visas.' },
      requirements: [{ tag: 'clearance_required', quote: 'Active Secret clearance required.' }],
      source: { name: 'Active Jobs DB', kind: 'provider' },
    });
    expect(res.job.sections.map((s) => s.kind)).toEqual(['responsibilities', 'qualifications']);
    expect(res.company).toMatchObject({ id: 'c1', facts: { industry: { value: 'Software' } }, openJobs: { value: 12, source: 'index' } });
    expect(res.fit?.kind).toBe('pre');
    expect(res.explanation?.mode).toBe('personalized');
    expect(res.checklist).toEqual({ saved: true, tailoredResumeId: 'rv_t', coverLetterId: null, practiced: null, applied: false });
    expect(res.tracker).toEqual({ id: 't1', status: 'bookmarked', dateApplied: null });
    // Same role family and country; self, flagged and other-country jobs excluded.
    expect(res.similarIds).toEqual(['j2']);
    expect(res.autofill).toEqual({ supported: true, atsType: 'greenhouse' });
    expect(res.people.mode).toBe('deeplinks_only');
    expect(res.people.searchLinks).toHaveLength(3);
  });

  it('another market → 404; a private import only for its owner', async () => {
    const { service } = setup({ jobs: [job(), job({ id: 'jp', visibility: 'private', ownerUserId: 'owner' })] });
    await expect(service.get('u1', 'jp')).rejects.toMatchObject({ code: 'not_found', details: { code: 'job_not_found' } });
    await expect(service.get('owner', 'jp')).resolves.toMatchObject({ job: { id: 'jp', visibility: 'private' } });
    const onCn = setup({ brand: cn });
    await expect(onCn.service.get('u1', 'j1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.get('u1', 'missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('closed job: "no longer listed" state, tracker kept; no company record → name only, openJobs null', async () => {
    const { service } = setup({
      jobs: [job({ closedAt: new Date(NOW.getTime() - 3 * DAY), lastSeenAt: new Date(NOW.getTime() - 4 * DAY), companyId: null })],
      seed: { rATrackerEntry: [{ id: 't1', userId: 'u1', jobId: 'j1', status: 'applied', dateApplied: NOW, deletedAt: null, tailoredVariantId: null, coverLetterId: null, createdAt: NOW }] },
    });
    const res = await service.get('u1', 'j1');
    expect(res.job.status).toBe('closed');
    expect(res.job.lastSeenAt).toBe(new Date(NOW.getTime() - 4 * DAY).toISOString());
    expect(res.tracker?.status).toBe('applied');
    expect(res.checklist.applied).toBe(true);
    expect(res.company).toEqual({ id: null, name: 'Acme', slug: null, logoUrl: null, domain: null, facts: {}, openJobs: null });
  });

  it('no score: fit and explanation are null; optional parts failing never break the page', async () => {
    const { service } = setup({
      deps: {
        fit: async () => null,
        companyProfile: async () => {
          throw new Error('db down');
        },
        peopleContext: async () => {
          throw new Error('profile down');
        },
      },
    });
    const res = await service.get('u1', 'j1');
    expect(res.fit).toBeNull();
    expect(res.explanation).toBeNull();
    expect(res.company.openJobs).toBeNull();
    expect(res.people.searchLinks.map((l) => l.url === null)).toEqual([false, true, true]);
  });

  it('GoApply: not personalised without the grant; no LinkedIn links; hiring contacts off hides People', async () => {
    const goJob = job({ market: 'cn', seniority: 'intern_newgrad', companyName: '示例科技' });
    const { service } = setup({ brand: cn, jobs: [goJob], deps: { personalized: async () => false } });
    const res = await service.get('u1', 'j1');
    expect(res.explanation?.mode).toBe('non_personalized');
    expect(res.people.searchLinks).toEqual([]);
    const off = setup({ deps: { hiringContacts: async () => 'off' } });
    expect((await off.service.get('u1', 'j1')).people).toEqual({ mode: 'off', searchLinks: [] });
  });

  // Wave 5 gate: the registered check needs the brand's market list, an
  // application URL the adapter has a host permission for, and no
  // page-by-page form (R4, WP-93).
  it('"Fill this form" only where the brand’s extension runs on the application page', async () => {
    const { EXTENSION_ATS_TYPES_BY_MARKET, extensionOffersFill } = await import('../../extension/contract.js');
    const deps = { extensionAts: () => new Set<string>([...EXTENSION_ATS_TYPES_BY_MARKET.intl, ...EXTENSION_ATS_TYPES_BY_MARKET.cn]), extensionFillsJob: () => extensionOffersFill };
    const supported = async (brand: typeof intl, over: Record<string, unknown>) => {
      const s = setup({ brand, jobs: [job({ market: brand.market, ...over })], deps });
      const detail = (await s.service.get('u1', 'j1')).autofill.supported;
      const click = (await s.service.recordApplyClick('u1', 'j1')).extensionSupported;
      expect(click).toBe(detail);
      return detail;
    };
    expect(await supported(intl, { atsType: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' })).toBe(true);
    expect(await supported(intl, { atsType: 'smartrecruiters', applyUrl: 'https://careers.smartrecruiters.com/Acme/1' })).toBe(false);
    expect(await supported(intl, { atsType: 'smartrecruiters', applyUrl: 'https://jobs.smartrecruiters.com/Acme/1' })).toBe(true);
    // INT gate (INT-03, R4): Workday is one run across its pages now, so it left the page-by-page list.
    expect(await supported(intl, { atsType: 'workday', applyUrl: 'https://acme.wd5.myworkdayjobs.com/External/job/1' })).toBe(true);
    expect(await supported(intl, { atsType: 'successfactors', applyUrl: 'https://career5.sapsf.eu/career?company=acme' })).toBe(false);
    expect(await supported(cn, { atsType: 'feishu', applyUrl: 'https://jobs.bytedance.com/campus/position/1' })).toBe(false);
    expect(await supported(cn, { atsType: 'feishu', applyUrl: 'https://acme.jobs.feishu.cn/index/position/1' })).toBe(true);
    // An international board on GoApply: the page says whatever the extension area's own rule says for that market
    // (GoApply's portal list becomes a superset in the parity wave; this area only has to follow it).
    const greenhouse = 'https://boards.greenhouse.io/acme/jobs/1';
    expect(await supported(cn, { atsType: 'greenhouse', applyUrl: greenhouse })).toBe(extensionOffersFill('cn', 'greenhouse', greenhouse));
  });

  it('GoApply with CN_RECRUITMENT_INFO_MODE=off (R41-1b): a third-party posting is a 404 everywhere; the user’s own import still opens; with nothing set it opens (D5)', async () => {
    const gohire = job({ id: 'gh1', market: 'cn', sourceBoard: 'gohire', sourceName: 'GoHire', fromRecruiterBank: true });
    const own = job({ id: 'own1', market: 'cn', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import' });
    const s = setup({ brand: cn, jobs: [gohire, own], deps: { env: { CN_RECRUITMENT_INFO_MODE: 'off' } } });
    await expect(s.service.get('u1', 'gh1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.service.similar('u1', 'gh1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.service.recordApplyClick('u1', 'gh1')).rejects.toMatchObject({ code: 'not_found' });
    expect((await s.service.get('u1', 'own1')).job.id).toBe('own1');
    await expect(s.service.get('u2', 'own1')).rejects.toMatchObject({ code: 'not_found' });
    const on = setup({ brand: cn, jobs: [gohire], deps: { env: { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' } } });
    expect((await on.service.get('u1', 'gh1')).job.id).toBe('gh1');
    // The default: nothing set means postings are shown.
    const byDefault = setup({ brand: cn, jobs: [gohire, own], deps: { env: {} } });
    expect((await byDefault.service.get('u1', 'gh1')).job.id).toBe('gh1');
    expect((await byDefault.service.get('u1', 'own1')).job.id).toBe('own1');
  });

  it('GoApply campus job: the employer’s verified programme window and 届别, behind jobs.campusCalendar', async () => {
    const goJob = job({ market: 'cn', seniority: 'intern_newgrad', companyName: '示例科技', companyId: 'cc1' });
    const events = [
      { id: 'e_old', market: 'cn', companyId: 'cc1', companyName: '示例科技', title: '2026届校园招聘', graduationClass: '2026届', kind: 'application', status: 'published', applyOpensAt: new Date('2025-09-01'), applyClosesAt: new Date('2025-11-30'), officialUrl: 'https://campus.example.cn/2026', verifiedAt: NOW },
      { id: 'e_new', market: 'cn', companyId: 'cc1', companyName: '示例科技', title: '2027届校园招聘', graduationClass: '2027届', kind: 'application', status: 'published', applyOpensAt: new Date('2026-09-01'), applyClosesAt: new Date('2026-11-30'), officialUrl: 'https://campus.example.cn/2027', verifiedAt: NOW },
      { id: 'e_draft', market: 'cn', companyId: 'cc1', companyName: '示例科技', title: 'draft', graduationClass: '2028届', kind: 'application', status: 'draft', applyOpensAt: null, applyClosesAt: new Date('2026-10-20'), officialUrl: 'https://x', verifiedAt: null },
    ];
    const s = setup({ brand: cn, jobs: [goJob], seed: { rACampusEvent: events } });
    expect((await s.service.get('u1', 'j1')).job.campus).toBeNull(); // capability off
    s.flags.add('jobs.campusCalendar');
    expect((await s.service.get('u1', 'j1')).job.campus).toMatchObject({ graduationClass: '2027届', classYears: [2027], officialUrl: 'https://campus.example.cn/2027' });
  });
});

describe('apply-click, I applied, undo (R1/C11; D1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('moves the job to Applied at once, is idempotent, and Undo removes an entry the click created', async () => {
    const { service, db } = setup();
    const first = await service.recordApplyClick('u1', 'j1');
    expect(first).toMatchObject({ applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', atsType: 'greenhouse', extensionSupported: true, alreadyApplied: false });
    vi.setSystemTime(NOW.getTime() + 1000);
    const again = await service.recordApplyClick('u1', 'j1');
    expect(again.trackerEntryId).toBe(first.trackerEntryId);
    // Nothing changed the second time: callers offer no Undo.
    expect(again.alreadyApplied).toBe(true);
    const entries = db.$rows('rATrackerEntry');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'applied', appliedVia: 'manual', source: 'feed' });
    expect(db.$rows('rATrackerEvent')).toHaveLength(1);
    expect(db.$rows('rAJobUserState')[0]).toMatchObject({ applyClickedAt: NOW });

    vi.setSystemTime(NOW.getTime() + 2000);
    expect(await service.undoApplied('u1', 'j1')).toEqual({ tracker: null });
    expect(db.$rows('rATrackerEntry')[0]!.deletedAt).toBeInstanceOf(Date);
    // Undo twice is harmless.
    expect(await service.undoApplied('u1', 'j1')).toEqual({ tracker: null });
  });

  it('Undo returns a saved job to Saved', async () => {
    const { service, db } = setup({
      seed: { rATrackerEntry: [{ id: 't1', userId: 'u1', jobId: 'j1', status: 'bookmarked', dateApplied: null, deletedAt: null, tailoredVariantId: null, coverLetterId: null, createdAt: NOW }] },
    });
    await service.recordApplyClick('u1', 'j1');
    expect(db.$rows('rATrackerEntry')[0]).toMatchObject({ id: 't1', status: 'applied' });
    vi.setSystemTime(NOW.getTime() + 1000);
    expect(await service.undoApplied('u1', 'j1')).toEqual({ tracker: { id: 't1', status: 'bookmarked', dateApplied: null } });
  });

  it('never moves a later stage back; a closed job cannot be opened; extension support needs the flag', async () => {
    const { service, db, flags } = setup({
      jobs: [job(), job({ id: 'jc', closedAt: NOW })],
      seed: { rATrackerEntry: [{ id: 't1', userId: 'u1', jobId: 'j1', status: 'interviewing', dateApplied: NOW, deletedAt: null, tailoredVariantId: null, coverLetterId: null, createdAt: NOW }] },
    });
    flags.delete('extension');
    const res = await service.recordApplyClick('u1', 'j1');
    expect(res.extensionSupported).toBe(false);
    expect(db.$rows('rATrackerEntry')[0]!.status).toBe('interviewing');
    await expect(service.recordApplyClick('u1', 'jc')).rejects.toMatchObject({ code: 'conflict', details: { code: 'job_closed' } });
  });

  it('"I applied" records the date given (not in the future); works on a closed job', async () => {
    const { service } = setup({ jobs: [job({ closedAt: NOW })] });
    const res = await service.markApplied('u1', 'j1', '2026-10-01T09:00:00.000Z');
    expect(res.tracker).toMatchObject({ status: 'applied', dateApplied: '2026-10-01T09:00:00.000Z' });
    expect(res.alreadyApplied).toBe(false);
    expect((await service.markApplied('u1', 'j1')).alreadyApplied).toBe(true);
    await expect(service.markApplied('u1', 'j1', '2026-12-01T00:00:00.000Z')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  const appliedEntry = { id: 't1', userId: 'u1', jobId: 'j1', status: 'applied', dateApplied: new Date(NOW.getTime() - 2 * DAY), deletedAt: null, tailoredVariantId: null, coverLetterId: null, createdAt: new Date(NOW.getTime() - 2 * DAY) };
  const appliedEvent = (over: Record<string, unknown> = {}) => ({ id: 'ev1', entryId: 't1', userId: 'u1', kind: 'status', fromValue: null, toValue: 'applied', payload: { via: 'manual' }, createdAt: new Date(NOW.getTime() - 2 * DAY), ...over });

  it('an older application survives a no-op click and its Undo', async () => {
    const { service, db } = setup({ seed: { rATrackerEntry: [{ ...appliedEntry }], rATrackerEvent: [appliedEvent()] } });
    const click = await service.recordApplyClick('u1', 'j1');
    expect(click).toMatchObject({ trackerEntryId: 't1', alreadyApplied: true });
    expect(await service.undoApplied('u1', 'j1')).toEqual({ tracker: { id: 't1', status: 'applied', dateApplied: appliedEntry.dateApplied.toISOString() } });
    expect(db.$rows('rATrackerEntry')[0]).toMatchObject({ status: 'applied', deletedAt: null });
    expect(db.$rows('rATrackerEvent')).toHaveLength(1);
    expect(db.$rows('rAJobInteraction').map((r) => r.kind)).not.toContain('unapplied');
  });

  it('Undo leaves a move to Applied made in the tracker alone, even a recent one', async () => {
    const { service, db } = setup({
      seed: { rATrackerEntry: [{ ...appliedEntry }], rATrackerEvent: [appliedEvent({ fromValue: 'bookmarked', payload: { via: 'tracker' }, createdAt: NOW })] },
    });
    expect((await service.undoApplied('u1', 'j1')).tracker?.status).toBe('applied');
    expect(db.$rows('rATrackerEntry')[0]).toMatchObject({ status: 'applied', deletedAt: null });
  });

  // ── WP-93 (WP-34 ↔ WP-38): one Undo for every apply action ──────────────

  it('Undo reverts a move made by opening a Ready to apply kit (via agent_open): a saved job goes back to Saved', async () => {
    const { service, db } = setup({
      seed: {
        rATrackerEntry: [{ ...appliedEntry, dateApplied: NOW, createdAt: new Date(NOW.getTime() - 5 * DAY) }],
        // What the tracker core records for a move of an existing entry (trackerCore.markApplied).
        rATrackerEvent: [appliedEvent({ fromValue: 'bookmarked', payload: { stampedDateApplied: true, via: 'agent_open', applyMark: true }, createdAt: new Date(NOW.getTime() - 60_000) })],
      },
    });
    expect(await service.undoApplied('u1', 'j1')).toEqual({ tracker: { id: 't1', status: 'bookmarked', dateApplied: null } });
    expect(db.$rows('rATrackerEntry')[0]).toMatchObject({ status: 'bookmarked', dateApplied: null, appliedVia: null, deletedAt: null });
    const events = db.$rows('rATrackerEvent');
    expect(events.at(-1)).toMatchObject({ kind: 'status', fromValue: 'applied', toValue: 'bookmarked', payload: { via: 'undo' } });
    expect(db.$rows('rAJobInteraction').map((r) => r.kind)).toContain('unapplied');
  });

  it('Undo reverts the extension’s "I submitted" (via extension), including an entry that move created', async () => {
    const { service, db } = setup({
      seed: {
        rATrackerEntry: [{ ...appliedEntry, dateApplied: NOW, createdAt: new Date(NOW.getTime() - 3_600_000) }],
        // The tracker core records the creation itself when the apply action made the entry.
        rATrackerEvent: [appliedEvent({ kind: 'created', fromValue: null, payload: { source: 'extension', via: 'extension', applyMark: true }, createdAt: new Date(NOW.getTime() - 3_600_000) })],
      },
    });
    expect(await service.undoApplied('u1', 'j1')).toEqual({ tracker: null });
    expect(db.$rows('rATrackerEntry')[0]!.deletedAt).toBeInstanceOf(Date);
    expect(db.$rows('rATrackerEvent').at(-1)).toMatchObject({ fromValue: 'applied', toValue: 'removed', payload: { via: 'undo' } });
  });

  it('Undo of an extension move on an entry that already had an applied date keeps that date and restores the earlier channel', async () => {
    const earlier = new Date(NOW.getTime() - 40 * DAY);
    const { service, db } = setup({
      seed: {
        rATrackerEntry: [{ ...appliedEntry, dateApplied: earlier, appliedVia: 'extension', createdAt: earlier }],
        // A re-application from an ended entry: the date was already there, so the move records the channel it replaced.
        rATrackerEvent: [appliedEvent({ fromValue: 'rejected', payload: { via: 'extension', previousAppliedVia: 'manual', applyMark: true }, createdAt: new Date(NOW.getTime() - 60_000) })],
      },
    });
    expect(await service.undoApplied('u1', 'j1')).toEqual({ tracker: { id: 't1', status: 'rejected', dateApplied: earlier.toISOString() } });
    // The re-application cleared who ended it; undo puts that back with the stage (the export and weekly facts read it).
    expect(db.$rows('rATrackerEntry')[0]).toMatchObject({ status: 'rejected', appliedVia: 'manual', outcome: 'they_said_no', deletedAt: null });
    const events = db.$rows('rATrackerEvent').slice(-2);
    expect(events[0]).toMatchObject({ kind: 'outcome', fromValue: null, toValue: 'they_said_no', payload: { via: 'undo' } });
    expect(events[1]).toMatchObject({ kind: 'status', fromValue: 'applied', toValue: 'rejected', payload: { via: 'undo' } });
  });

  it.each([
    ['withdrawn', 'i_withdrew'],
    ['closed', 'job_pulled'],
  ])('Undo back to an ended stage restores its outcome (%s → %s); back to Saved writes none', async (ended, outcome) => {
    const moved = { fromValue: ended, payload: { via: 'agent_open', previousAppliedVia: 'manual', applyMark: true }, createdAt: new Date(NOW.getTime() - 60_000) };
    const back = setup({ seed: { rATrackerEntry: [{ ...appliedEntry, outcome: null }], rATrackerEvent: [appliedEvent(moved)] } });
    expect((await back.service.undoApplied('u1', 'j1')).tracker?.status).toBe(ended);
    expect(back.db.$rows('rATrackerEntry')[0]).toMatchObject({ status: ended, outcome });

    const saved = setup({ seed: { rATrackerEntry: [{ ...appliedEntry, outcome: null }], rATrackerEvent: [appliedEvent({ fromValue: 'bookmarked', payload: { via: 'agent_open' }, createdAt: new Date(NOW.getTime() - 60_000) })] } });
    expect((await saved.service.undoApplied('u1', 'j1')).tracker?.status).toBe('bookmarked');
    expect(saved.db.$rows('rATrackerEntry')[0]!.outcome ?? null).toBeNull();
    expect(saved.db.$rows('rATrackerEvent').map((e) => e.kind)).not.toContain('outcome');
  });

  it.each(['apply_click', 'manual', 'agent_open', 'extension'])('the 24 h limit: a %s move is undone at 23 h 59 min and left alone after 24 h', async (via) => {
    const inside = setup({
      seed: {
        rATrackerEntry: [{ ...appliedEntry }],
        rATrackerEvent: [appliedEvent({ fromValue: 'bookmarked', payload: { via }, createdAt: new Date(NOW.getTime() - (DAY - 60_000)) })],
      },
    });
    expect((await inside.service.undoApplied('u1', 'j1')).tracker?.status).toBe('bookmarked');

    const outside = setup({
      seed: {
        rATrackerEntry: [{ ...appliedEntry }],
        rATrackerEvent: [appliedEvent({ fromValue: 'bookmarked', payload: { via }, createdAt: new Date(NOW.getTime() - (DAY + 1000)) })],
      },
    });
    expect((await outside.service.undoApplied('u1', 'j1')).tracker?.status).toBe('applied');
    expect(outside.db.$rows('rATrackerEntry')[0]).toMatchObject({ status: 'applied', deletedAt: null });
    expect(outside.db.$rows('rATrackerEvent')).toHaveLength(1);
    expect(outside.db.$rows('rAJobInteraction').map((r) => r.kind)).not.toContain('unapplied');
  });

  it('only the NEWEST move into Applied counts: an old undoable move behind a recent hand edit is not undone', async () => {
    const { service, db } = setup({
      seed: {
        rATrackerEntry: [{ ...appliedEntry }],
        rATrackerEvent: [
          appliedEvent({ id: 'ev1', fromValue: 'bookmarked', payload: { via: 'agent_open', applyMark: true }, createdAt: new Date(NOW.getTime() - 3 * 3_600_000) }),
          // The user then set the stage by hand in the tracker (no apply `via`).
          appliedEvent({ id: 'ev2', fromValue: 'interviewing', payload: { via: 'tracker' }, createdAt: new Date(NOW.getTime() - 3_600_000) }),
        ],
      },
    });
    expect((await service.undoApplied('u1', 'j1')).tracker?.status).toBe('applied');
    expect(db.$rows('rATrackerEvent')).toHaveLength(2);
  });

  it('every apply response carries alreadyApplied (false on the move, true on a repeat) — click and "I applied" alike', async () => {
    const { service } = setup({ jobs: [job(), job({ id: 'j2' })] });
    const click = await service.recordApplyClick('u1', 'j1');
    expect(click).toHaveProperty('alreadyApplied', false);
    expect(await service.recordApplyClick('u1', 'j1')).toHaveProperty('alreadyApplied', true);
    expect(await service.markApplied('u1', 'j1')).toHaveProperty('alreadyApplied', true);
    expect(await service.markApplied('u1', 'j2')).toHaveProperty('alreadyApplied', false);
    expect(await service.recordApplyClick('u1', 'j2')).toHaveProperty('alreadyApplied', true);
  });

  it('apply click, "I applied", undo, save and unsave all take the (user, job) advisory lock', async () => {
    const { service, db } = setup();
    const key = trackerEntryLockKey('u1', 'j1');
    const locks = () => db.$sql.calls.filter((c) => c.text.includes('pg_advisory_xact_lock') && c.values.includes(key)).length;
    await service.save('u1', 'j1');
    expect(locks()).toBe(1);
    await service.unsave('u1', 'j1');
    expect(locks()).toBe(2);
    await service.recordApplyClick('u1', 'j1');
    expect(locks()).toBe(3);
    await service.undoApplied('u1', 'j1');
    expect(locks()).toBe(4);
    await service.markApplied('u1', 'j1');
    expect(locks()).toBe(5);
  });

  // ── WP-35: the user's own imported job ──────────────────────────────────

  it('a private import with no link answers 409 no_apply_link on an apply click and moves nothing; "I applied" still works', async () => {
    const mine = job({ id: 'imp', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', sourceName: null, applyUrl: '', companyId: null });
    const { service, db } = setup({ jobs: [mine] });
    await expect(service.recordApplyClick('u1', 'imp')).rejects.toMatchObject({ code: 'conflict', details: { code: 'no_apply_link' } });
    expect(db.$rows('rATrackerEntry')).toHaveLength(0);
    expect(db.$rows('rAJobInteraction').map((r) => r.kind)).not.toContain('apply_click');
    expect((await service.markApplied('u1', 'imp')).tracker.status).toBe('applied');
  });

  it('a job without an application link is not moved to Applied by a click', async () => {
    const { service, db } = setup({ jobs: [job({ applyUrl: '  ' })] });
    await expect(service.recordApplyClick('u1', 'j1')).rejects.toMatchObject({ code: 'conflict', details: { code: 'no_apply_link' } });
    expect(db.$rows('rATrackerEntry')).toHaveLength(0);
    // "I applied" still works.
    expect((await service.markApplied('u1', 'j1')).tracker.status).toBe('applied');
  });

  it('tracker writes take the (user, job) advisory lock; concurrent first clicks and saves create one entry', async () => {
    const { db, deps } = setup();
    // Serialize transactions the way pg_advisory_xact_lock does on one key.
    let chain: Promise<unknown> = Promise.resolve();
    const locked = new Proxy(db, {
      get(target, prop) {
        if (prop === '$transaction') {
          return (fn: (tx: unknown) => Promise<unknown>) => {
            const run = chain.then(() => (target as unknown as { $transaction: (f: typeof fn) => Promise<unknown> }).$transaction(fn));
            chain = run.catch(() => undefined);
            return run;
          };
        }
        return Reflect.get(target, prop);
      },
    });
    const service = createJobDetailService({ ...deps, db: locked as unknown as JobDetailDb });
    await Promise.all([service.recordApplyClick('u1', 'j1'), service.recordApplyClick('u1', 'j1'), service.save('u1', 'j1')]);
    expect(db.$rows('rATrackerEntry').filter((r) => r.deletedAt == null)).toHaveLength(1);
    expect(db.$sql.texts().filter((t) => t.includes('pg_advisory_xact_lock')).length).toBeGreaterThanOrEqual(3);
    expect(trackerEntryLockKey('u1', 'j1')).toBe('ra_tracker_entry:u1:j1');
  });
});

describe('save, share, similar, company news', () => {
  it('save creates a Saved entry once and calls the growth checklist every time (a failure never blocks)', async () => {
    const { service, db, markChecklistStep } = setup();
    expect((await service.save('u1', 'j1')).tracker?.status).toBe('bookmarked');
    await service.save('u1', 'j1');
    expect(db.$rows('rATrackerEntry')).toHaveLength(1);
    expect(markChecklistStep).toHaveBeenCalledTimes(2);
    expect(markChecklistStep).toHaveBeenCalledWith('u1', 'save_job');
    const failing = setup({ deps: { markChecklistStep: async () => Promise.reject(new Error('growth down')) } });
    await expect(failing.service.save('u1', 'j1')).resolves.toMatchObject({ tracker: { status: 'bookmarked' } });
  });

  it('save accepts the user’s own private import (WP-35); another user’s import stays a 404', async () => {
    const mine = job({ id: 'imp', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', sourceName: null, companyId: null });
    const { service, db } = setup({ jobs: [mine] });
    expect((await service.save('u1', 'imp')).tracker?.status).toBe('bookmarked');
    expect(db.$rows('rATrackerEntry')).toHaveLength(1);
    await expect(service.save('u2', 'imp')).rejects.toMatchObject({ code: 'not_found' });
    expect(db.$rows('rATrackerEntry')).toHaveLength(1);
  });

  it('feed affinity learns from a new save, an apply click and "I applied" (once each; a failure never blocks)', async () => {
    const recordInteraction = vi.fn(async () => undefined);
    const { service } = setup({ jobs: [job(), job({ id: 'j2' })], deps: { recordInteraction } });
    await service.save('u1', 'j1');
    await service.save('u1', 'j1'); // already saved: no second bump
    await service.recordApplyClick('u1', 'j1');
    await service.recordApplyClick('u1', 'j1'); // already applied
    await service.markApplied('u1', 'j2');
    expect(recordInteraction.mock.calls).toEqual([
      ['u1', 'j1', 'save'],
      ['u1', 'j1', 'apply_click'],
      ['u1', 'j2', 'applied'],
    ]);
    const failing = setup({ deps: { recordInteraction: async () => Promise.reject(new Error('feed down')) } });
    await expect(failing.service.save('u1', 'j1')).resolves.toMatchObject({ tracker: { status: 'bookmarked' } });
    await expect(failing.service.recordApplyClick('u1', 'j1')).resolves.toMatchObject({ alreadyApplied: false });
  });

  it('unsave removes a Saved entry and refuses one already applied', async () => {
    const { service, db } = setup();
    await service.save('u1', 'j1');
    expect(await service.unsave('u1', 'j1')).toEqual({ tracker: null });
    expect(db.$rows('rATrackerEntry')[0]!.deletedAt).toBeInstanceOf(Date);
    await service.recordApplyClick('u1', 'j1');
    await expect(service.unsave('u1', 'j1')).rejects.toMatchObject({ code: 'conflict', details: { code: 'job_in_progress' } });
  });

  it('share answers the app link unless the job may be shown publicly', async () => {
    const { service } = setup({ jobs: [job(), job({ id: 'jpub', publicDisplay: true, slug: 'backend-engineer-acme' })] });
    expect(await service.share('u1', 'j1')).toEqual({ url: 'https://www.roboapply.io/jobs/j1', public: false });
    expect(await service.share('u1', 'jpub')).toEqual({ url: 'https://www.roboapply.io/job/jpub-backend-engineer-acme', public: true });
  });

  it('similar: hidden and flagged jobs excluded, best fit first, unknown fit last (never 0)', async () => {
    const { service } = setup({
      jobs: [job(), job({ id: 'j2' }), job({ id: 'j3' }), job({ id: 'j4' }), job({ id: 'jh' }), job({ id: 'jx', archivedAt: NOW }), job({ id: 'jo', primaryTaxonomyId: 'designer' })],
      seed: {
        rAJobUserState: [{ userId: 'u1', jobId: 'jh', hiddenAt: NOW }],
        rATrackerEntry: [{ id: 't3', userId: 'u1', jobId: 'j3', status: 'applied', deletedAt: null, dateApplied: NOW, createdAt: NOW }],
      },
    });
    const res = await service.similar('u1', 'j1');
    expect(res.items.map((i) => i.jobId)).toEqual(['j2', 'j3', 'j4']);
    expect(res.items.find((i) => i.jobId === 'j4')!.fit).toBeNull();
    expect(res.items.find((i) => i.jobId === 'j3')!.tracker).toEqual({ status: 'applied' });
    expect(res.items[0]!.pay).toBeNull();
    expect(res.items[0]!.payText).toBeNull();
  });

  it('FIX-3: a similar job with a stored AI score shows that score and its kind (the number the feed card shows), not a second estimate', async () => {
    const fits = async (_u: string, ids: string[]) =>
      fitsFixture(ids.map((id) => fitFixture({ jobId: id, score: id === 'j2' ? 59 : 87, tier: id === 'j2' ? 'possible' : 'great', kind: id === 'j2' ? 'ai' : 'estimate' })));
    const { service } = setup({ jobs: [job(), job({ id: 'j2' }), job({ id: 'j3' })], deps: { fits } });
    const items = (await service.similar('u1', 'j1')).items;
    expect(items.map((i) => [i.jobId, i.fit?.score, i.fit?.kind])).toEqual([
      ['j3', 87, 'pre'],
      ['j2', 59, 'ai'],
    ]);
  });

  it('similar: weekly pay and a pay text that states an amount are kept (never "not listed")', async () => {
    const { service } = setup({
      jobs: [
        job(),
        job({ id: 'jw', salaryMin: 1200, salaryMax: 1500, salaryPeriod: 'week', salaryDisclosed: true }),
        job({ id: 'jt', salaryText: '待遇面議(經常性薪資達4萬元或以上)', salaryDisclosed: false }),
      ],
    });
    const items = (await service.similar('u1', 'j1')).items;
    expect(items.find((i) => i.jobId === 'jw')!.pay).toMatchObject({ min: 1200, max: 1500, period: 'week' });
    expect(items.find((i) => i.jobId === 'jt')).toMatchObject({ pay: null, payText: '待遇面議(經常性薪資達4萬元或以上)' });
  });

  it('FIX-3: words with no amount are not "Pay as stated", and a figure that cannot be pay is not shown as a number', async () => {
    const { service } = setup({
      jobs: [
        job(),
        // A benefits sentence stored as pay text before the normalizer kept only the pay words.
        job({ id: 'jb', salaryText: 'Competitive Pay and Benefits, including medical, dental and a 401k match', salaryDisclosed: false }),
        job({ id: 'jc', salaryText: 'Competitive', salaryDisclosed: false }),
        // "$60,000K-$90,000K" read as dollars an hour.
        job({ id: 'jx2', salaryMin: 60_000_000, salaryMax: 90_000_000, salaryCurrency: 'USD', salaryPeriod: 'hour', salaryDisclosed: true, salaryText: '$60,000K-$90,000K' }),
      ],
    });
    const items = (await service.similar('u1', 'j1')).items;
    expect(items.find((i) => i.jobId === 'jb')).toMatchObject({ pay: null, payText: null });
    expect(items.find((i) => i.jobId === 'jc')).toMatchObject({ pay: null, payText: null });
    // The post's own words stay available; no "$60,000,000 an hour".
    expect(items.find((i) => i.jobId === 'jx2')).toMatchObject({ pay: null, payText: '$60,000K-$90,000K' });
    expect((await service.get('u1', 'jx2')).job).toMatchObject({ pay: null, payText: '$60,000K-$90,000K' });
  });

  it('GET /:id lists similar ids without scoring them; GET /:id/similar ranks', async () => {
    const fits = vi.fn(async (_u: string, ids: string[]) => fitsFixture(ids.map((id) => fitFixture({ jobId: id, score: 60, tier: 'good' }))));
    const { service } = setup({ jobs: [job(), job({ id: 'j2' }), job({ id: 'j3', fraudFlags: [{ rule: 'x' }] })], deps: { fits } });
    expect((await service.get('u1', 'j1')).similarIds).toEqual(['j2']);
    expect(fits).not.toHaveBeenCalled();
    await service.similar('u1', 'j1');
    expect(fits).toHaveBeenCalledTimes(1);
  });

  it('GoApply with jobs.recommendations off (CN_RECRUITMENT_INFO_MODE=off): no similar jobs anywhere', async () => {
    const cnJob = (over: Record<string, unknown> = {}) => job({ market: 'cn', locationCountry: 'CN', ...over });
    const fits = vi.fn(async () => new Map<string, Fit>());
    const similarSource = vi.fn(async () => ['j2']);
    const s = setup({ brand: cn, jobs: [cnJob(), cnJob({ id: 'j2' })], deps: { fits, similarSource } });
    s.flags.delete('jobs.recommendations');
    expect(await s.service.similar('u1', 'j1')).toEqual({ items: [] });
    expect((await s.service.get('u1', 'j1')).similarIds).toEqual([]);
    expect(fits).not.toHaveBeenCalled();
    // The vector source is not asked either: nothing is recommended in this mode.
    expect(similarSource).not.toHaveBeenCalled();
    s.flags.add('jobs.recommendations');
    expect((await s.service.similar('u1', 'j1')).items.map((i) => i.jobId)).toEqual(['j2']);
  });

  it('company news is dark until the flag is on, labelled as search results, and follows the flag only on both brands (D5)', async () => {
    const searchNews = vi.fn(async () => [{ title: 'Acme raises prices', url: 'https://news.example.com/a', publisher: 'news.example.com', publishedAt: null }]);
    const s = setup({ deps: { searchNews } });
    await expect(s.service.companyNews('u1', 'j1')).rejects.toMatchObject({ code: 'feature_disabled' });
    s.flags.add('companyNews');
    await expect(s.service.companyNews('u1', 'j1')).resolves.toMatchObject({ kind: 'search_results', items: [{ publisher: 'news.example.com' }] });
    expect(searchNews).toHaveBeenCalledWith(intl, 'Acme');
    // GoApply: the same rule. Dark without the flag (FLAG_GOAPPLY_COMPANY_NEWS), news with it: no market term.
    const go = setup({ brand: cn, jobs: [job({ market: 'cn', companyName: '示例科技' })], deps: { searchNews } });
    await expect(go.service.companyNews('u1', 'j1')).rejects.toMatchObject({ code: 'feature_disabled' });
    go.flags.add('companyNews');
    await expect(go.service.companyNews('u1', 'j1')).resolves.toMatchObject({ kind: 'search_results', items: [{ publisher: 'news.example.com' }] });
    expect(searchNews).toHaveBeenLastCalledWith(cn, '示例科技');
    // No search configured: dark on either brand, flag or not.
    const noSearch = setup({ brand: cn, jobs: [job({ market: 'cn' })], deps: { searchNews: undefined } });
    noSearch.flags.add('companyNews');
    await expect(noSearch.service.companyNews('u1', 'j1')).rejects.toMatchObject({ code: 'feature_disabled' });
    // The job scope is unchanged: with the recruitment-info mode off a third-party posting is still a 404 there.
    const off = setup({ brand: cn, jobs: [job({ market: 'cn' })], deps: { searchNews, env: { CN_RECRUITMENT_INFO_MODE: 'off' } } });
    off.flags.add('companyNews');
    await expect(off.service.companyNews('u1', 'j1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('GoApply similar jobs: a public posting with no usable apply link is never listed; the rule does not touch RoboApply', async () => {
    const cnJob = (over: Record<string, unknown> = {}) => job({ market: 'cn', locationCountry: 'CN', sourceBoard: 'smartrecruiters', sourceName: '示例 · SmartRecruiters', ...over });
    const s = setup({
      brand: cn,
      jobs: [
        cnJob(),
        cnJob({ id: 'ok', applyUrl: 'https://careers.example.cn/jobs/2' }),
        cnJob({ id: 'empty', applyUrl: '' }),
        cnJob({ id: 'blank', applyUrl: '  ' }),
        cnJob({ id: 'script', applyUrl: 'javascript:alert(1)' }),
      ],
    });
    expect((await s.service.similar('u1', 'j1')).items.map((i) => i.jobId)).toEqual(['ok']);
    expect((await s.service.get('u1', 'j1')).similarIds).toEqual(['ok']);
    // Every similar card carries its source facts and its own apply link.
    const [card] = (await s.service.similar('u1', 'j1')).items;
    expect(card!.apply).toEqual({ url: 'https://careers.example.cn/jobs/2', target: 'employer' });
    expect(card!.source).toMatchObject({ kind: 'ats_public', via: 'ats', original: 'Acme', url: 'https://careers.example.cn/jobs/2', lastVerifiedAt: NOW.toISOString() });
    // RoboApply keeps its own rule: nothing changes there.
    const robo = setup({ jobs: [job(), job({ id: 'nolink', applyUrl: '' })] });
    expect((await robo.service.similar('u1', 'j1')).items.map((i) => i.jobId)).toEqual(['nolink']);
  });

  it('similar jobs, both brands: a recruiter-bank row is recommended only while its bank has a posting page', async () => {
    const jobs = () => [job(), job({ id: 'board' }), job({ id: 'bank', sourceBoard: 'robohire', sourceName: 'RoboHire', fromRecruiterBank: true, applyUrl: 'https://www.robohire.io/jobs/bank' })];
    const held = setup({ jobs: jobs() });
    expect((await held.service.similar('u1', 'j1')).items.map((i) => i.jobId)).toEqual(['board']);
    expect((await held.service.get('u1', 'j1')).similarIds).toEqual(['board']);
    // The service reads the setting from its own env; the card's link from the process env.
    const page = { ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://jobs.robohire.example/p/{id}' };
    vi.stubEnv('ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE', page.ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE);
    try {
      const open = setup({ jobs: jobs(), deps: { env: page } });
      const items = (await open.service.similar('u1', 'j1')).items;
      expect(items.map((i) => i.jobId).sort()).toEqual(['bank', 'board']);
      expect(items.find((i) => i.jobId === 'bank')!.apply).toEqual({ url: 'https://www.robohire.io/jobs/bank', target: null });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ── MKT-2F: the job page and Similar jobs read THE fit; Similar jobs takes a vector source ──

describe('MKT-2F: one fit on the job page and on Similar jobs (strategy 2.2 I1, I2)', () => {
  it('the job page answers getFit as the fit card reads it: same score, tier and kind, with confidence and the reason', async () => {
    const estimate = pageFit({ score: 61, tier: 'possible', confidence: 'low', confidenceReason: 'no_skills_listed' });
    const fit = vi.fn(async () => estimate);
    const { service } = setup({ deps: { fit } });
    const res = await service.get('u1', 'j1');
    expect(res.fit).toEqual(fitToView(estimate));
    expect(res.fit).toMatchObject({ score: 61, tier: 'possible', kind: 'pre', confidence: 'low', confidenceReason: 'no_skills_listed' });
    expect(fit).toHaveBeenCalledWith('u1', 'j1');
  });

  it('a stored AI fit is what the page shows (never an estimate next to it), with its prose', async () => {
    const ai = pageFit({ score: 63, tier: 'possible', kind: 'ai', cached: true, prose: { summary: 'Your Go work fits.', strengths: ['Go services'], gaps: [], keywordsMatched: [], keywordsMissing: [], locale: 'en' } });
    const { service } = setup({ deps: { fit: async () => ai } });
    const res = await service.get('u1', 'j1');
    expect(res.fit).toMatchObject({ score: 63, tier: 'possible', kind: 'ai', summary: 'Your Go work fits.', strengths: ['Go services'], cached: true });
  });

  it('a Similar card carries the same badge the feed builds from the same Fit (toFitBadge = feed fitBadge)', () => {
    for (const fit of [
      fitFixture({ jobId: 'a', score: 87, tier: 'great', kind: 'ai', topGap: 'Kubernetes', topOverlap: 'Go' }),
      fitFixture({ jobId: 'b', score: 58, tier: 'possible', kind: 'estimate', confidence: 'low', confidenceReason: 'no_level_stated' }),
      fitFixture({ jobId: 'c', score: null, tier: null, kind: 'estimate' }),
    ]) {
      expect(toFitBadge(fit)).toEqual(fitBadge(fit));
    }
    expect(toFitBadge(undefined)).toBeNull();
    expect(toFitBadge(fitFixture({ score: null, tier: null }))).toBeNull();
    expect(toFitBadge(fitFixture({ score: 58, tier: 'possible', kind: 'estimate', confidence: 'low', confidenceReason: 'no_level_stated' }))).toEqual({
      tier: 'possible',
      score: 58,
      kind: 'pre',
      topGap: null,
      topOverlap: null,
      confidence: 'low',
      confidenceReason: 'no_level_stated',
    });
  });

  it('"Why this job" on the job page leaves out a logistics part that only repeats the filters, and names the tier the card shows', () => {
    const view = fitToView(
      pageFit({
        score: 66,
        // The card keeps Possible by hysteresis although 66 alone would read Good.
        tier: 'possible',
        dimensions: [
          { key: 'skills', weight: 30, score: 90, status: 'scored', evidence: [{ text: 'Go', source: 'resume', ref: 'skill_have' }] },
          { key: 'logistics', weight: 10, score: null, status: 'not_stated', evidence: [{ text: 'Austin, TX', source: 'posting', ref: LOGISTICS_BY_FILTERS_REF }] },
        ],
      }),
    );
    const out = explainNow({ market: 'intl', personalized: true, fit: view });
    const lines = JSON.stringify(out);
    expect(lines).not.toContain('logistics');
    expect(lines).toContain('skills');
    expect(JSON.stringify(out.headline)).toContain('possible');
    // A logistics part with facts of its own stays.
    const withFacts = explainNow({
      market: 'intl',
      personalized: true,
      fit: { ...view, dimensions: [{ key: 'logistics', weight: 10, score: null, status: 'not_stated', evidence: [] }] },
    });
    expect(JSON.stringify(withFacts)).toContain('logistics');
  });
});

describe('MKT-2F: Similar jobs by job vector, re-ordered by the one fit (strategy 2.3 step 6)', () => {
  /** A "Java Backend Architect" the taxonomy stored under the building architects. */
  const anchor = () => job({ id: 'j1', title: 'Java Backend Architect', titleNormalized: 'java backend architect', primaryTaxonomyId: 'architect' });
  const building = (id: string, postedHoursAgo: number) =>
    job({ id, title: 'Landscape Architect', titleNormalized: 'landscape architect', primaryTaxonomyId: 'architect', postedAt: new Date(NOW.getTime() - postedHoursAgo * 3_600_000) });
  const backend = (id: string, over: Record<string, unknown> = {}) =>
    job({ id, title: 'Backend Software Architect', titleNormalized: 'backend software architect', primaryTaxonomyId: 'backend_engineer', ...over });
  const world = () => [anchor(), building('la1', 1), building('la2', 2), backend('be1'), backend('be2'), backend('be3')];
  const noFits = async () => new Map<string, Fit>();

  it('with a vector source the list is the source’s postings, not the same-role ones the taxonomy error would give', async () => {
    const similarSource = vi.fn(async () => ['be2', 'be1', 'be3']);
    const { service } = setup({ jobs: world(), deps: { similarSource, fits: noFits } });
    const items = (await service.similar('u1', 'j1')).items;
    // Source order (vector distance) when no fit is known.
    expect(items.map((i) => i.jobId)).toEqual(['be2', 'be1', 'be3']);
    expect(items.map((i) => i.title)).not.toContain('Landscape Architect');
    // The source is told the job, its market and country, and asked for the nearest 50.
    expect(similarSource).toHaveBeenCalledWith({ id: 'j1', market: 'intl', locationCountry: 'US', visibility: 'public', ownerUserId: null }, SIMILAR_SOURCE_LIMIT);
    expect(SIMILAR_SOURCE_LIMIT).toBe(50);
    // GET /:id lists the same ids without scoring.
    const fits = vi.fn(noFits);
    const page = setup({ jobs: world(), deps: { similarSource, fits } });
    expect((await page.service.get('u1', 'j1')).similarIds).toEqual(['be2', 'be1', 'be3']);
    expect(fits).not.toHaveBeenCalled();
  });

  it.each([
    ['no source', undefined],
    ['a null answer', async () => null],
    ['an empty list', async () => [] as string[]],
    [
      'a source that throws',
      async () => {
        throw new Error('vector read failed');
      },
    ],
    ['a source that answers something that is not a list', async () => 'be1' as unknown as string[]],
  ])('%s: the list is the same-role list, as before, and nothing is thrown', async (_name, similarSource) => {
    const { service } = setup({ jobs: world(), deps: { similarSource, fits: noFits } });
    expect((await service.similar('u1', 'j1')).items.map((i) => i.jobId)).toEqual(['la1', 'la2']);
    expect((await service.get('u1', 'j1')).similarIds).toEqual(['la1', 'la2']);
  });

  it('every id is checked again here: another market or country, a closed, private, non-canonical, flagged or hidden posting and the job itself never show', async () => {
    const jobs = [
      ...world(),
      backend('cn1', { market: 'cn', locationCountry: 'CN' }),
      backend('ca1', { locationCountry: 'CA' }),
      backend('closed', { closedAt: NOW }),
      backend('archived', { archivedAt: NOW }),
      backend('private', { visibility: 'private', ownerUserId: 'someone' }),
      backend('dup', { isCanonical: false }),
      backend('flagged', { fraudFlags: [{ rule: 'upfront_fee' }] }),
      backend('hidden'),
    ];
    const similarSource = async () => ['cn1', 'ca1', 'closed', 'archived', 'private', 'dup', 'flagged', 'hidden', 'j1', 'gone', 'be1', 'be1', 'be3'];
    const { service } = setup({ jobs, seed: { rAJobUserState: [{ userId: 'u1', jobId: 'hidden', hiddenAt: NOW }] }, deps: { similarSource, fits: noFits } });
    expect((await service.similar('u1', 'j1')).items.map((i) => i.jobId)).toEqual(['be1', 'be3']);
    expect((await service.get('u1', 'j1')).similarIds).toEqual(['be1', 'be3']);
  });

  it('a source whose ids all fail the checks falls back to the same-role list (never an empty list by accident)', async () => {
    const jobs = [...world(), backend('cn1', { market: 'cn', locationCountry: 'CN' })];
    const { service } = setup({ jobs, deps: { similarSource: async () => ['cn1', 'gone'], fits: noFits } });
    expect((await service.similar('u1', 'j1')).items.map((i) => i.jobId)).toEqual(['la1', 'la2']);
  });

  it('order: best fit first, unknown fit last, then the source order; each card shows the Fit the feed shows', async () => {
    const byId: Record<string, Fit> = {
      be1: fitFixture({ jobId: 'be1', score: 70, tier: 'good', kind: 'estimate' }),
      be2: fitFixture({ jobId: 'be2', score: 84, tier: 'great', kind: 'ai' }),
      // be3 and be4: the same score, so the source order decides. be5: no fit.
      be3: fitFixture({ jobId: 'be3', score: 55, tier: 'possible', kind: 'estimate', confidence: 'low', confidenceReason: 'no_skills_listed' }),
      be4: fitFixture({ jobId: 'be4', score: 55, tier: 'possible', kind: 'estimate' }),
    };
    const fits = vi.fn(async (_u: string, ids: string[]) => fitsFixture(ids.flatMap((id) => (byId[id] ? [byId[id]!] : []))));
    const jobs = [...world(), backend('be4'), backend('be5')];
    const { service } = setup({ jobs, deps: { similarSource: async () => ['be5', 'be4', 'be3', 'be1', 'be2'], fits } });
    const items = (await service.similar('u1', 'j1')).items;
    expect(items.map((i) => i.jobId)).toEqual(['be2', 'be1', 'be4', 'be3', 'be5']);
    expect(items.map((i) => i.fit)).toEqual([fitBadge(byId.be2), fitBadge(byId.be1), fitBadge(byId.be4), fitBadge(byId.be3), null]);
    expect(items[0]!.fit).toMatchObject({ score: 84, kind: 'ai' });
    expect(items[3]!.fit).toMatchObject({ kind: 'pre', confidence: 'low', confidenceReason: 'no_skills_listed' });
    // One list read for the candidates; no single-job (model-capable) read.
    expect(fits).toHaveBeenCalledTimes(1);
    expect(fits.mock.calls[0]![1]).toEqual(['be5', 'be4', 'be3', 'be1', 'be2']);
  });

  it('at most six cards, the best six of the candidates', async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `n${i}`);
    const jobs = [anchor(), ...ids.map((id) => backend(id))];
    const fits = async (_u: string, asked: string[]) => fitsFixture(asked.map((id) => fitFixture({ jobId: id, score: 50 + Number(id.slice(1)), tier: 'possible' })));
    const { service } = setup({ jobs, deps: { similarSource: async () => ids, fits } });
    const items = (await service.similar('u1', 'j1')).items;
    expect(items).toHaveLength(SIMILAR_LIMIT);
    expect(items.map((i) => i.jobId)).toEqual(['n8', 'n7', 'n6', 'n5', 'n4', 'n3']);
    expect((await service.get('u1', 'j1')).similarIds).toEqual(ids.slice(0, SIMILAR_LIMIT));
  });

  it('a failing fit read lists the postings in source order with no fit (the list never fails over it)', async () => {
    const fits = async () => {
      throw new Error('scores down');
    };
    const { service } = setup({ jobs: world(), deps: { similarSource: async () => ['be3', 'be1'], fits } });
    const items = (await service.similar('u1', 'j1')).items;
    expect(items.map((i) => [i.jobId, i.fit])).toEqual([
      ['be3', null],
      ['be1', null],
    ]);
  });

  it('GoApply: no fit is read without the 个性化推荐 grant (the postings are listed in source order, with none); with the grant the fits are read', async () => {
    const cnJob = (id: string, over: Record<string, unknown> = {}) => backend(id, { market: 'cn', locationCountry: 'CN', applyUrl: `https://careers.example.cn/jobs/${id}`, ...over });
    const jobs = [job({ id: 'j1', market: 'cn', locationCountry: 'CN', primaryTaxonomyId: 'architect' }), cnJob('c1'), cnJob('c2')];
    const fits = vi.fn(async (_u: string, ids: string[]) => fitsFixture(ids.map((id) => fitFixture({ jobId: id, score: id === 'c2' ? 80 : 60, tier: id === 'c2' ? 'great' : 'possible' }))));
    const similarSource = async () => ['c1', 'c2'];
    const without = setup({ brand: cn, jobs, deps: { similarSource, fits, personalized: async () => false } });
    expect((await without.service.similar('u1', 'j1')).items.map((i) => [i.jobId, i.fit])).toEqual([
      ['c1', null],
      ['c2', null],
    ]);
    expect(fits).not.toHaveBeenCalled();
    const granted = setup({ brand: cn, jobs, deps: { similarSource, fits, personalized: async () => true } });
    expect((await granted.service.similar('u1', 'j1')).items.map((i) => [i.jobId, i.fit?.score])).toEqual([
      ['c2', 80],
      ['c1', 60],
    ]);
    // A grant check that fails is read as "no grant" (fails closed).
    const broken = setup({
      brand: cn,
      jobs,
      deps: {
        similarSource,
        fits: vi.fn(async () => new Map<string, Fit>()),
        personalized: async () => {
          throw new Error('consent store down');
        },
      },
    });
    expect((await broken.service.similar('u1', 'j1')).items.map((i) => i.fit)).toEqual([null, null]);
    expect(broken.deps.fits).not.toHaveBeenCalled();
  });

  it('defaultService: the feed seam is read without a static type, so a feed module without the export answers null', async () => {
    const row = { id: 'j1', market: 'intl', locationCountry: 'US', visibility: 'public', ownerUserId: null };
    // Before the retrieval bundle merges: no such export.
    expect(await similarFromFeed(row, 50, async () => ({ feedService: {} }))).toBeNull();
    expect(await similarFromFeed(row, 50, async () => ({ similarJobIds: 'not a function' }))).toBeNull();
    expect(await similarFromFeed(row, 50, async () => null)).toBeNull();
    // After it: the export is called with the row and the limit, and its answer is passed on as it is.
    const similarJobIds = vi.fn(async () => ['be1', 'be2']);
    expect(await similarFromFeed(row, 50, async () => ({ similarJobIds }))).toEqual(['be1', 'be2']);
    expect(similarJobIds).toHaveBeenCalledWith(row, 50);
    expect(await similarFromFeed(row, 50, async () => ({ similarJobIds: async () => null }))).toBeNull();
    // A feed module that fails to load is the service's "throws" case: it lists the same-role jobs.
    await expect(similarFromFeed(row, 50, async () => Promise.reject(new Error('feed failed to load')))).rejects.toThrow('feed failed to load');
  });

  // M2 gate: the seam between MKT-2F (this reader) and MKT-2H (`feed/index.ts similarJobIds`), on the merged
  // tree, with no loader handed in: the REAL feed export is called, and it asks retrieval with the row's
  // market, country and the market's model tag. Only the two retrieval reads are fakes (no database).
  it('defaultService: with no loader the real feed export answers, asked with the market, the country and the model tag', async () => {
    const { setSimilarJobsDepsForTests } = await import('../../feed/index.js');
    const nearestJobsByJob = vi.fn(async () => [{ jobId: 'near1' }, { jobId: 'near2' }]);
    const currentModelTag = vi.fn(async (): Promise<string | null> => 'openai/text-embedding-3-small@1024');
    setSimilarJobsDepsForTests({ currentModelTag, nearestJobsByJob });
    try {
      const row = { id: 'j1', market: 'cn', locationCountry: 'CN', visibility: 'public', ownerUserId: null };
      expect(await similarFromFeed(row, 50)).toEqual(['near1', 'near2']);
      expect(currentModelTag).toHaveBeenCalledWith('cn');
      expect(nearestJobsByJob).toHaveBeenCalledWith('j1', { market: 'cn', country: 'CN', modelTag: 'openai/text-embedding-3-small@1024', limit: 50 });
      // A market with no vectors yet: null, so the service lists the same-role jobs.
      currentModelTag.mockResolvedValueOnce(null);
      expect(await similarFromFeed(row, 50)).toBeNull();
      nearestJobsByJob.mockResolvedValueOnce([]);
      expect(await similarFromFeed(row, 50)).toBeNull();
    } finally {
      setSimilarJobsDepsForTests(null);
    }
  });
});

describe('company news search (Tavily)', () => {
  beforeEach(() => clearNewsCache());

  it('keeps title, link, publisher and the stated date only', () => {
    expect(
      toNewsItems([
        { title: ' Acme  opens office ', url: 'https://www.example.com/a', published_date: '2026-10-01' },
        { title: 'no link' },
        { title: 'bad', url: 'javascript:alert(1)' },
        { title: 'Undated', url: 'https://example.org/b', published_date: 'not a date' },
      ]),
    ).toEqual([
      { title: 'Acme opens office', url: 'https://www.example.com/a', publisher: 'example.com', publishedAt: '2026-10-01T00:00:00.000Z' },
      { title: 'Undated', url: 'https://example.org/b', publisher: 'example.org', publishedAt: null },
    ]);
  });

  it('no key → null without a request; sends only the company name; caches; failures → null', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [{ title: 'T', url: 'https://e.com/x' }] }) }));
    expect(await searchCompanyNews(intl, 'Acme', { env: {}, fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const env = { TAVILY_API_KEY: 'k' };
    expect(await searchCompanyNews(intl, 'Acme', { env, fetch })).toHaveLength(1);
    expect(await searchCompanyNews(intl, 'Acme', { env, fetch })).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect(body).toMatchObject({ query: '"Acme" company news', topic: 'news' });
    const failing = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(await searchCompanyNews(intl, 'Globex', { env, fetch: failing })).toBeNull();
    const throwing = vi.fn(async () => Promise.reject(new Error('network')));
    expect(await searchCompanyNews(intl, 'Initech', { env, fetch: throwing })).toBeNull();
  });

  it('the cache is bounded and drops stale entries', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }));
    const env = { TAVILY_API_KEY: 'k' };
    for (let i = 0; i < NEWS_CACHE_MAX + 20; i++) await searchCompanyNews(intl, `Company ${i}`, { env, fetch, now: () => NOW });
    expect(newsCacheSize()).toBe(NEWS_CACHE_MAX);
    // The oldest entries were evicted: asking again searches again.
    fetch.mockClear();
    await searchCompanyNews(intl, 'Company 0', { env, fetch, now: () => NOW });
    expect(fetch).toHaveBeenCalledTimes(1);
    // A stale entry is dropped on read, then refreshed.
    fetch.mockClear();
    await searchCompanyNews(intl, 'Company 0', { env, fetch, now: () => new Date(NOW.getTime() + 7 * 60 * 60 * 1000) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ── Routes ────────────────────────────────────────────────────────────────

describe('routes', () => {
  let h: RouteHarness;
  const { service } = setup({
    jobs: [job(), job({ id: 'jcn', market: 'cn' })],
  });
  const scoreHandler: RequestHandler = (_req, res) => {
    res.json({ success: true, data: { fit: fitView() } });
  };
  const userOf = (req: { headers: Record<string, unknown> }) => (req.headers['x-test-user'] ? { id: String(req.headers['x-test-user']) } : null);
  const auth: RequestHandler[] = [fakeAuth(userOf)];
  const user = { headers: { 'x-test-user': 'u1' } };
  let newsCalls = 0;
  const newsLimiter: RequestHandler = (_req, res, next) => {
    newsCalls += 1;
    if (newsCalls > 1) {
      res.status(429).json({ success: false, code: 'rate_limited' });
      return;
    }
    next();
  };

  beforeAll(async () => {
    h = await startRouteHarness({ mounts: [['/api/v1/roboapply/jobs', createJobDetailRouter({ service, seekerAuth: auth, scoreHandler, newsLimiter, env: {} })]] });
  });
  afterAll(() => h.close());

  it('every route needs a session', async () => {
    for (const [m, p] of [
      ['GET', '/j1'],
      ['POST', '/j1/score'],
      ['GET', '/j1/similar'],
      ['POST', '/j1/save'],
      ['DELETE', '/j1/save'],
      ['POST', '/j1/apply-click'],
      ['POST', '/j1/applied'],
      ['DELETE', '/j1/applied'],
      ['POST', '/j1/share'],
      ['GET', '/j1/company-news'],
    ] as const) {
      expect((await h.request(m, `/api/v1/roboapply/jobs${p}`)).status, `${m} ${p}`).toBe(401);
    }
  });

  it('GET /:id answers the envelope; another market 404', async () => {
    const ok = await h.request<{ data: JobDetailResponse }>('GET', '/api/v1/roboapply/jobs/j1', user);
    expect(ok.status).toBe(200);
    expect(ok.body.data.job.id).toBe('j1');
    const other = await h.request<{ code: string }>('GET', '/api/v1/roboapply/jobs/jcn', user);
    expect(other.status).toBe(404);
  });

  it('apply-click → undo round trip; I applied validates its body; score uses MATCH’s handler', async () => {
    const click = await h.request<{ data: { trackerEntryId: string } }>('POST', '/api/v1/roboapply/jobs/j1/apply-click', user);
    expect(click.status).toBe(200);
    const undo = await h.request<{ data: { tracker: null } }>('DELETE', '/api/v1/roboapply/jobs/j1/applied', user);
    expect(undo.body.data.tracker).toBeNull();
    const bad = await h.request('POST', '/api/v1/roboapply/jobs/j1/applied', { ...user, body: { appliedAt: 'yesterday' } });
    expect(bad.status).toBe(422);
    const score = await h.request<{ data: { fit: MatchFitView } }>('POST', '/api/v1/roboapply/jobs/j1/score', { ...user, body: {} });
    expect(score.body.data.fit.score).toBe(82);
  });

  it('company news is 404 feature_disabled while dark, and rate-limited per user', async () => {
    const res = await h.request<{ code: string }>('GET', '/api/v1/roboapply/jobs/j1/company-news', user);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
    const again = await h.request<{ code: string }>('GET', '/api/v1/roboapply/jobs/j1/company-news', user);
    expect(again.status).toBe(429);
  });

  it('the default company-news limit is 30 an hour per user', async () => {
    const { COMPANY_NEWS_RATE_LIMIT } = await import('./routes.js');
    expect(COMPANY_NEWS_RATE_LIMIT).toEqual([{ limit: 30, windowSec: 3600 }]);
  });
});

describe('market card meta on the job page (WP-33 #7: the same cardMeta as the feed card)', () => {
  // The production dep: marketHooks.cardMeta over the job row in the brand's market.
  const marketMeta: JobDetailServiceDeps['marketMeta'] = (row, brand) => cardMeta({ ...row, market: brand.market }, { brand: brand.id, market: brand.market, stage: 'card' });

  it('the row the hooks get carries locations, the plain posting text, N薪 and the expiry date', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = setup({
      jobs: [job({ locations: [{ city: 'Taipei', country: 'TW' }], descriptionPlain: 'Plain text.', salaryMonths: 14, expiresAt: new Date('2026-11-01T00:00:00Z') })],
      deps: {
        marketMeta: (row) => {
          seen.push(row as unknown as Record<string, unknown>);
          return {};
        },
      },
    });
    await service.get('u1', 'j1');
    expect(seen[0]).toMatchObject({
      salaryText: null,
      salaryDisclosed: false,
      marketTags: expect.any(Array),
      sourceName: 'Active Jobs DB',
      sourceUrl: null,
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      sourceBoard: 'activejobs',
      atsType: 'greenhouse',
      locationCountry: 'US',
      locations: [{ city: 'Taipei', country: 'TW' }],
      descriptionPlain: 'Plain text.',
      salaryMonths: 14,
      expiresAt: new Date('2026-11-01T00:00:00Z'),
    });
  });

  it('Taiwan: a posting whose only Taiwan signal is one of its locations gets the tw meta, with a permit tag its text still states', async () => {
    const tw = job({
      locationCountry: null,
      location: 'Taipei / Singapore',
      locations: [{ city: 'Singapore', country: 'SG' }, { city: 'Taipei', country: 'TW' }],
      salaryDisclosed: false,
      salaryText: '待遇面議（經常性薪資達4萬元或以上）',
      sourceBoard: 'greenhouse',
      sourceName: 'Appier · Greenhouse',
      sourceUrl: 'https://boards.greenhouse.io/appier/jobs/1',
      descriptionPlain: '我們可協助申請工作許可。',
      marketTags: [{ tag: 'tw_work_permit_support', evidenceQuote: '可協助申請工作許可', evidenceUrl: null }],
    });
    const { service } = setup({ jobs: [tw], deps: { marketMeta } });
    const meta = (await service.get('u1', 'j1')).marketMeta as { ats_public: { country: string; pay: Record<string, unknown>; permitTags: Array<{ tag: string }>; source: Record<string, unknown> } };
    expect(meta.ats_public).toMatchObject({
      country: 'TW',
      // 面議 is "pay not listed"; the Art. 5 floor clause is not shown as an amount on the card line.
      pay: { text: '待遇面議', disclosed: false, negotiable: true },
      source: { name: 'Appier · Greenhouse', url: 'https://boards.greenhouse.io/appier/jobs/1', board: 'greenhouse' },
    });
    expect(meta.ats_public.permitTags.map((t) => t.tag)).toEqual(['tw_work_permit_support']);
  });

  it('GoApply: the cn meta carries the source line, pay in the posting’s words with N薪, and the source’s expiry date', async () => {
    const cnJob = job({
      market: 'cn',
      locationCountry: 'CN',
      sourceBoard: 'gohire',
      sourceName: 'GoHire',
      fromRecruiterBank: true,
      employerVerified: true,
      isAgency: false,
      salaryDisclosed: true,
      salaryText: null,
      salaryMin: 15000,
      salaryMax: 25000,
      salaryCurrency: 'CNY',
      salaryPeriod: 'month',
      salaryMonths: 13,
      expiresAt: new Date('2026-11-01T00:00:00Z'),
      marketTags: [{ tag: 'hukou', evidenceQuote: '可落户上海', evidenceUrl: null }],
    });
    const { service } = setup({ jobs: [cnJob], brand: cn, deps: { marketMeta } });
    const meta = (await service.get('u1', 'j1')).marketMeta as { cn: Record<string, unknown> };
    expect(meta.cn).toMatchObject({
      sourceLine: { kind: 'direct', sourceName: 'GoHire' },
      salary: { text: '15-25K·13薪', disclosed: true },
      expiresAt: '2026-11-01T00:00:00.000Z',
      tags: [{ tag: 'hukou', evidenceQuote: '可落户上海' }],
    });
  });

  it('a RoboApply job outside Taiwan has no market meta', async () => {
    const { service } = setup({ deps: { marketMeta } });
    expect((await service.get('u1', 'j1')).marketMeta).toEqual({});
  });
});

describe('practice link (SR-34-1)', () => {
  it('SR-34-1 checklist.practiced is true once a practice session for this job exists (RAMockSession.jobId)', async () => {
    // The interview area's seam: job id → when the user last completed a practice for it.
    // A written practice is a scored RAMockSession with `jobId` set; a live one an InterviewSession.
    const mockSessions = [
      { userId: 'u1', jobId: 'j1', practiceCompletedAt: '2026-10-09T10:00:00.000Z' },
      { userId: 'u1', jobId: 'j2', practiceCompletedAt: null }, // started, never answered
      { userId: 'u2', jobId: 'j3', practiceCompletedAt: '2026-10-08T10:00:00.000Z' }, // someone else's
    ];
    const practicedJobs = vi.fn(async (userId: string, jobIds: string[]) =>
      Object.fromEntries(
        mockSessions.filter((s) => s.userId === userId && jobIds.includes(s.jobId) && s.practiceCompletedAt).map((s) => [s.jobId, s.practiceCompletedAt as string]),
      ),
    );
    const { service } = setup({
      jobs: [job(), job({ id: 'j2' }), job({ id: 'j3' })],
      deps: { practicedForJob: practicedForJobFrom(practicedJobs) },
    });
    expect((await service.get('u1', 'j1')).checklist.practiced).toBe(true);
    expect(practicedJobs).toHaveBeenCalledWith('u1', ['j1']);
    expect((await service.get('u1', 'j2')).checklist.practiced).toBe(false);
    expect((await service.get('u1', 'j3')).checklist.practiced).toBe(false);
  });

  it('the production service reads interviewSessionService.practicedJobs (live sessions and written practice)', async () => {
    const practicedJobs = vi.fn(async () => ({ j1: '2026-10-09T10:00:00.000Z' }));
    vi.doMock('../../../interview-engine/sessions/InterviewSessionService.js', () => ({ interviewSessionService: { practicedJobs } }));
    try {
      const { defaultPracticedJobs } = await import('./defaultService.js');
      expect(await practicedForJobFrom(defaultPracticedJobs)('u1', 'j1')).toBe(true);
      expect(await practicedForJobFrom(defaultPracticedJobs)('u1', 'j9')).toBe(false);
      expect(practicedJobs).toHaveBeenCalledWith('u1', ['j1']);
    } finally {
      vi.doUnmock('../../../interview-engine/sessions/InterviewSessionService.js');
    }
  });

  it('a practice seam outage never breaks the page: the step reads unknown (null), not "not practiced"', async () => {
    const { service } = setup({
      deps: {
        practicedForJob: practicedForJobFrom(async () => {
          throw new Error('interview store down');
        }),
      },
    });
    const res = await service.get('u1', 'j1');
    expect(res.job.id).toBe('j1');
    expect(res.checklist.practiced).toBeNull();
  });
});
