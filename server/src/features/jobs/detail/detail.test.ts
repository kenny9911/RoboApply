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
import type { MatchFitView, PreScoreResult } from '../../match/contract.js';
import { REQUIREMENT_TAGS } from '../enrich/reconcile.js';
import { JOB_REQUIREMENT_TAGS, type JobDetailResponse } from './contract.js';
import { createJobDetailRouter } from './routes.js';
import { createJobDetailService, trackerEntryLockKey, type JobDetailDb, type JobDetailServiceDeps } from './service.js';
import { NEWS_CACHE_MAX, clearNewsCache, newsCacheSize, searchCompanyNews, toNewsItems } from './newsSearch.js';
import {
  classYearsOf,
  peopleSearchLinks,
  shareTarget,
  slugify,
  toBadges,
  toCampusInfo,
  toPay,
  toRequirements,
  toSections,
  toSponsorship,
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
    cachedFit: async () => fitView(),
    preScore: async (_u, ids) => ids.map((id, i): PreScoreResult => ({ jobId: id, score: id === 'j4' ? null : 50 + i * 10, tier: 'possible', kind: 'pre', dimensions: [], topOverlap: null, topGap: null })),
    explain: ({ personalized }) => ({ mode: personalized ? 'personalized' : 'non_personalized', headline: { key: 'legal.explain.headline.personalized' }, reasons: [], gaps: [], notices: [] }),
    personalized: async () => true,
    peopleContext: async () => ({ pastCompanies: ['Globex', 'Acme'], schools: ['State University'] }),
    markChecklistStep,
    isEnabled: async (key) => flags.has(key),
    hiringContacts: async () => 'deeplinks_only',
    marketMeta: () => ({}),
    extensionAts: () => new Set(['greenhouse']),
    // GoApply rows below model a recruitment-info mode that allows postings;
    // the mode-off case has its own test ('GoApply recruitment-info mode off').
    env: { CN_RECRUITMENT_INFO_MODE: 'licensed' },
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
        cachedFit: async () => null,
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
      const s = setup({ brand, jobs: [job({ market: brand.market, ...over })], deps: brand === cn ? { ...deps, env: { CN_RECRUITMENT_INFO_MODE: 'licensed' } } : deps });
      const detail = (await s.service.get('u1', 'j1')).autofill.supported;
      const click = (await s.service.recordApplyClick('u1', 'j1')).extensionSupported;
      expect(click).toBe(detail);
      return detail;
    };
    expect(await supported(intl, { atsType: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' })).toBe(true);
    expect(await supported(intl, { atsType: 'smartrecruiters', applyUrl: 'https://careers.smartrecruiters.com/Acme/1' })).toBe(false);
    expect(await supported(intl, { atsType: 'smartrecruiters', applyUrl: 'https://jobs.smartrecruiters.com/Acme/1' })).toBe(true);
    expect(await supported(intl, { atsType: 'workday', applyUrl: 'https://acme.wd5.myworkdayjobs.com/External/job/1' })).toBe(false);
    expect(await supported(intl, { atsType: 'successfactors', applyUrl: 'https://career5.sapsf.eu/career?company=acme' })).toBe(false);
    expect(await supported(cn, { atsType: 'feishu', applyUrl: 'https://jobs.bytedance.com/campus/position/1' })).toBe(false);
    expect(await supported(cn, { atsType: 'feishu', applyUrl: 'https://acme.jobs.feishu.cn/index/position/1' })).toBe(true);
    expect(await supported(cn, { atsType: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' })).toBe(false);
  });

  it('GoApply recruitment-info mode off (R-14, R41-1b): a third-party posting is a 404 everywhere; the user’s own import still opens', async () => {
    const gohire = job({ id: 'gh1', market: 'cn', sourceBoard: 'gohire', sourceName: 'GoHire', fromRecruiterBank: true });
    const own = job({ id: 'own1', market: 'cn', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import' });
    const s = setup({ brand: cn, jobs: [gohire, own], deps: { env: {} } });
    await expect(s.service.get('u1', 'gh1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.service.similar('u1', 'gh1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.service.recordApplyClick('u1', 'gh1')).rejects.toMatchObject({ code: 'not_found' });
    expect((await s.service.get('u1', 'own1')).job.id).toBe('own1');
    await expect(s.service.get('u2', 'own1')).rejects.toMatchObject({ code: 'not_found' });
    const on = setup({ brand: cn, jobs: [gohire], deps: { env: { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' } } });
    expect((await on.service.get('u1', 'gh1')).job.id).toBe('gh1');
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

  it('similar: weekly pay and pay stated in words are kept (never "not listed")', async () => {
    const { service } = setup({
      jobs: [
        job(),
        job({ id: 'jw', salaryMin: 1200, salaryMax: 1500, salaryPeriod: 'week', salaryDisclosed: true }),
        job({ id: 'jt', salaryText: 'Competitive', salaryDisclosed: false }),
      ],
    });
    const items = (await service.similar('u1', 'j1')).items;
    expect(items.find((i) => i.jobId === 'jw')!.pay).toMatchObject({ min: 1200, max: 1500, period: 'week' });
    expect(items.find((i) => i.jobId === 'jt')).toMatchObject({ pay: null, payText: 'Competitive' });
  });

  it('GET /:id lists similar ids without scoring them; GET /:id/similar ranks', async () => {
    const preScore = vi.fn(async (_u: string, ids: string[]): Promise<PreScoreResult[]> => ids.map((id) => ({ jobId: id, score: 60, tier: 'good', kind: 'pre', dimensions: [], topOverlap: null, topGap: null })));
    const { service } = setup({ jobs: [job(), job({ id: 'j2' }), job({ id: 'j3', fraudFlags: [{ rule: 'x' }] })], deps: { preScore } });
    expect((await service.get('u1', 'j1')).similarIds).toEqual(['j2']);
    expect(preScore).not.toHaveBeenCalled();
    await service.similar('u1', 'j1');
    expect(preScore).toHaveBeenCalledTimes(1);
  });

  it('GoApply with jobs.recommendations off (CN_RECRUITMENT_INFO_MODE=off): no similar jobs anywhere', async () => {
    const cnJob = (over: Record<string, unknown> = {}) => job({ market: 'cn', locationCountry: 'CN', ...over });
    const preScore = vi.fn(async () => [] as PreScoreResult[]);
    const s = setup({ brand: cn, jobs: [cnJob(), cnJob({ id: 'j2' })], deps: { preScore } });
    s.flags.delete('jobs.recommendations');
    expect(await s.service.similar('u1', 'j1')).toEqual({ items: [] });
    expect((await s.service.get('u1', 'j1')).similarIds).toEqual([]);
    expect(preScore).not.toHaveBeenCalled();
    s.flags.add('jobs.recommendations');
    expect((await s.service.similar('u1', 'j1')).items.map((i) => i.jobId)).toEqual(['j2']);
  });

  it('company news is dark until the flag is on, RoboApply only, labelled as search results', async () => {
    const searchNews = vi.fn(async () => [{ title: 'Acme raises prices', url: 'https://news.example.com/a', publisher: 'news.example.com', publishedAt: null }]);
    const s = setup({ deps: { searchNews } });
    await expect(s.service.companyNews('u1', 'j1')).rejects.toMatchObject({ code: 'feature_disabled' });
    s.flags.add('companyNews');
    await expect(s.service.companyNews('u1', 'j1')).resolves.toMatchObject({ kind: 'search_results', items: [{ publisher: 'news.example.com' }] });
    expect(searchNews).toHaveBeenCalledWith(intl, 'Acme');
    const go = setup({ brand: cn, jobs: [job({ market: 'cn' })], deps: { searchNews } });
    go.flags.add('companyNews');
    await expect(go.service.companyNews('u1', 'j1')).rejects.toMatchObject({ code: 'feature_disabled' });
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

describe('practice link (SR-34-1)', () => {
  it.todo('SR-34-1 checklist.practiced is true once a practice session for this job exists (RAMockSession.raJobId)');
});
