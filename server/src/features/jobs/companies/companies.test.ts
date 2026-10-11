// @vitest-environment node
// WP-16b: companies — ingest upsert with per-field provenance, typeahead
// (trigram + prefix, market-scoped), profile with sourced facts only,
// company jobs, H-1B (flag + DOL source), routes incl. auth and 404s.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import type { RequestHandler } from 'express';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import type { CompanyUpsert } from '../normalize/index.js';
import {
  COMPANY_JOBS_PAGE,
  companyJobsOrder,
  companyKey,
  companyPatch,
  companySlug,
  createCompaniesRouter,
  createCompanyReadService,
  escapeLike,
  INDUSTRY_IDS,
  industryIdFor,
  mapIndustries,
  MAX_POSTING_INDUSTRIES,
  POSTING_INDUSTRY_SOURCE,
  setIndustryFromPosting,
  toCompanyProfile,
  upsertCompanies,
  type CompaniesDb,
  type CompanyProfile,
} from './index.js';
import { ONBOARDING_INDUSTRIES } from '../../onboarding/contract.js';

const NOW = new Date('2026-10-10T00:00:00.000Z');
const FACT = { source: 'provider:activejobs', fetchedAt: '2026-10-01T00:00:00.000Z' };

function upsert(over: Partial<CompanyUpsert> = {}): CompanyUpsert {
  return {
    market: 'intl',
    displayName: 'Acme, Inc.',
    nameNormalized: 'acme',
    logoUrl: null,
    isAgency: null,
    bankCompanyRef: null,
    website: null,
    domain: null,
    industries: [],
    sizeBand: null,
    employeeCount: null,
    hqLocation: null,
    foundedYear: null,
    description: null,
    facts: {},
    ...over,
  };
}

describe('industry vocabulary (SM-10)', () => {
  it('is the closed list the industries filter and onboarding use', () => {
    expect([...INDUSTRY_IDS]).toEqual(ONBOARDING_INDUSTRIES.map((i) => i.id));
  });

  it('maps a label to its id only on an exact, case-insensitive match (the id or its slug)', () => {
    expect(industryIdFor('Fintech')).toBe('Fintech');
    expect(industryIdFor('  fintech ')).toBe('Fintech');
    expect(industryIdFor('AI / ML')).toBe('AI / ML');
    expect(industryIdFor('ai_ml')).toBe('AI / ML');
    expect(industryIdFor('B2B  SAAS')).toBe('B2B SaaS');
    // Near matches are not matches: nothing is guessed.
    for (const label of ['Financial technology', 'Banking', 'AI', 'Software', 'Fin tech', '金融科技', '', null, 7]) expect(industryIdFor(label), String(label)).toBeNull();
  });

  it('keeps an unmapped provider or bank value as the source wrote it, and no value twice', () => {
    expect(mapIndustries(['fintech', 'Banking', 'Fintech', '互联网', ' ', 'banking'])).toEqual(['Fintech', 'Banking', '互联网', 'banking']);
    expect(mapIndustries(null)).toEqual([]);
  });

  it('ingest stores a provider or bank industry through the same vocabulary', async () => {
    const db = createFakePrisma({ uniqueFields: { rACompany: ['slug'] } });
    const bank = { source: 'bank:gohire', fetchedAt: '2026-10-01T00:00:00.000Z' };
    await upsertCompanies(db as unknown as Pick<CompaniesDb, 'rACompany'>, [
      upsert({ industries: ['e-commerce', 'Retail'], facts: { industries: FACT } }),
      upsert({ market: 'cn', displayName: '示例科技', nameNormalized: '示例科技', industries: ['互联网'], facts: { industries: bank } }),
    ]);
    const rows = db.$rows('rACompany');
    expect(rows.find((r) => r.nameNormalized === 'acme')).toMatchObject({ industries: ['E-commerce', 'Retail'], facts: { industries: FACT } });
    expect(rows.find((r) => r.nameNormalized === '示例科技')).toMatchObject({ industries: ['互联网'], facts: { industries: bank } });
  });
});

/** One company row behind the three calls `setIndustryFromPosting` makes (the shared fake has no `isEmpty` filter). */
function companyRow(row: { industries: string[]; facts: unknown; isAgency?: boolean | null } | null, options: { filledMeanwhile?: string[] } = {}) {
  const state = row ? { id: 'co_1', ...row } : null;
  const writes: Array<Record<string, unknown>> = [];
  const selects: Array<Record<string, unknown>> = [];
  const db = {
    rACompany: {
      findUnique: async ({ where, select }: { where: { id: string }; select: Record<string, unknown> }) => {
        selects.push(select);
        return state && where.id === state.id ? { ...state, industries: [...state.industries] } : null;
      },
      updateMany: async ({ where, data }: { where: { id: string; industries: { isEmpty: boolean } }; data: Record<string, unknown> }) => {
        // Another writer (a provider's value) got there between the read and this write.
        if (state && options.filledMeanwhile) state.industries = options.filledMeanwhile;
        if (!state || where.id !== state.id || (where.industries.isEmpty && state.industries.length > 0)) return { count: 0 };
        writes.push(data);
        Object.assign(state, data);
        return { count: 1 };
      },
      update: async ({ data }: { where: { id: string }; data: Record<string, unknown> }) => {
        writes.push(data);
        Object.assign(state!, data);
        return state;
      },
    },
  } as unknown as Pick<CompaniesDb, 'rACompany'>;
  return { db, state, writes, selects };
}

describe('company industry from a posting (SM-10)', () => {
  const posting = { industry: 'Fintech', sourceUrl: 'https://boards.example.com/acme/123', at: NOW };

  it('a company with no industry takes the one the posting states, with provenance "posting", the link and the time', async () => {
    const { db, state, writes } = companyRow({ industries: [], facts: { website: FACT } });
    expect(await setIndustryFromPosting(db, 'co_1', posting)).toBe('set');
    expect(state).toMatchObject({
      industries: ['Fintech'],
      facts: { website: FACT, industries: { source: 'posting', url: 'https://boards.example.com/acme/123', fetchedAt: NOW.toISOString() } },
    });
    expect(POSTING_INDUSTRY_SOURCE).toBe('posting');
    expect(writes).toHaveLength(1);
    // The profile shows it like any other sourced fact, with its link.
    const profile = toCompanyProfile(
      { id: 'co_1', market: 'intl', nameNormalized: 'acme', displayName: 'Acme', slug: 'acme', domain: null, logoUrl: null, website: null, sizeBand: null, hqLocation: null, foundedYear: null, description: null, industries: state!.industries, facts: state!.facts },
      0,
      NOW,
    );
    expect(profile.facts.industry).toEqual({ value: 'Fintech', source: 'posting', asOf: NOW.toISOString(), url: 'https://boards.example.com/acme/123' });
  });

  it.each([
    ['the bank', { source: 'bank:gohire', fetchedAt: '2026-10-01T00:00:00.000Z' }],
    ['a provider', { source: 'provider:linkedin', fetchedAt: '2026-10-01T00:00:00.000Z' }],
    ['a user', { source: 'user', fetchedAt: '2026-10-01T00:00:00.000Z' }],
    ['an unknown source (no provenance entry)', undefined],
  ])('a company whose industry came from %s is not changed', async (_from, entry) => {
    const facts = entry ? { industries: entry } : {};
    const { db, state, writes } = companyRow({ industries: ['互联网'], facts });
    expect(await setIndustryFromPosting(db, 'co_1', posting)).toBe('unchanged');
    expect(state).toMatchObject({ industries: ['互联网'], facts });
    expect(writes).toEqual([]);
  });

  it('a later posting that states another industry is appended, up to three; the first provenance stays', async () => {
    const first = { source: 'posting', url: 'https://boards.example.com/acme/1', fetchedAt: '2026-10-01T00:00:00.000Z' };
    const { db, state } = companyRow({ industries: ['Fintech'], facts: { industries: first } });
    expect(await setIndustryFromPosting(db, 'co_1', { ...posting, industry: 'fintech' })).toBe('unchanged'); // the same one again
    expect(await setIndustryFromPosting(db, 'co_1', { ...posting, industry: 'B2B SaaS' })).toBe('appended');
    expect(await setIndustryFromPosting(db, 'co_1', { ...posting, industry: 'AI / ML' })).toBe('appended');
    expect(await setIndustryFromPosting(db, 'co_1', { ...posting, industry: 'Cybersecurity' })).toBe('unchanged'); // a fourth is not kept
    expect(state!.industries).toEqual(['Fintech', 'B2B SaaS', 'AI / ML']);
    expect(state!.industries).toHaveLength(MAX_POSTING_INDUSTRIES);
    expect(state!.facts).toEqual({ industries: first });
  });

  it('ignores a value outside the list, a company that is gone and a link that is not a web address', async () => {
    const empty = companyRow({ industries: [], facts: {} });
    expect(await setIndustryFromPosting(empty.db, 'co_1', { ...posting, industry: 'Space mining' })).toBe('unchanged');
    expect(empty.writes).toEqual([]);
    expect(await setIndustryFromPosting(companyRow(null).db, 'co_1', posting)).toBe('not_found');
    expect(await setIndustryFromPosting(empty.db, 'co_1', { ...posting, sourceUrl: 'javascript:alert(1)' })).toBe('set');
    expect(empty.state!.facts).toEqual({ industries: { source: 'posting', fetchedAt: NOW.toISOString() } });
    const noLink = companyRow({ industries: [], facts: null });
    expect(await setIndustryFromPosting(noLink.db, 'co_1', { ...posting, sourceUrl: null })).toBe('set');
    expect(noLink.state!.facts).toEqual({ industries: { source: 'posting', fetchedAt: NOW.toISOString() } });
  });

  it('a staffing agency never takes an industry from a posting: its postings describe its clients', async () => {
    const empty = companyRow({ industries: [], facts: {}, isAgency: true });
    expect(await setIndustryFromPosting(empty.db, 'co_1', posting)).toBe('unchanged');
    expect(empty.state).toMatchObject({ industries: [], facts: {} });
    expect(empty.writes).toEqual([]);
    expect(empty.selects[0]).toMatchObject({ isAgency: true });
    // Nor a second value beside one an earlier posting set before the company was known to be an agency.
    const first = { source: 'posting', url: 'https://boards.example.com/acme/1', fetchedAt: '2026-10-01T00:00:00.000Z' };
    const held = companyRow({ industries: ['Fintech'], facts: { industries: first }, isAgency: true });
    expect(await setIndustryFromPosting(held.db, 'co_1', { ...posting, industry: 'Gaming' })).toBe('unchanged');
    expect(held.state!.industries).toEqual(['Fintech']);
    // Not an agency, or not known: the posting's industry is stored as before.
    for (const isAgency of [false, null]) {
      const direct = companyRow({ industries: [], facts: {}, isAgency });
      expect(await setIndustryFromPosting(direct.db, 'co_1', posting)).toBe('set');
    }
  });

  it('never overwrites a value that arrived between the read and the write', async () => {
    const { db, state, writes } = companyRow({ industries: [], facts: {} }, { filledMeanwhile: ['互联网'] });
    expect(await setIndustryFromPosting(db, 'co_1', posting)).toBe('unchanged');
    expect(state!.industries).toEqual(['互联网']);
    expect(writes).toEqual([]);
  });
});

describe('company upsert (ingest)', () => {
  it('slugs ASCII names and hashes CJK-only names', () => {
    expect(companySlug('Acme, Inc.', 'acme')).toBe('acme-inc');
    expect(companySlug('Société Générale', 'societe generale')).toBe('societe-generale');
    expect(companySlug('示例科技', '示例科技')).toMatch(/^c-[0-9a-f]{8}$/);
  });

  it('fills only empty fields that a source states, never overwrites another source', () => {
    const existing = {
      id: 'c1',
      nameNormalized: 'acme',
      logoUrl: null,
      isAgency: null,
      bankCompanyRef: null,
      website: 'https://acme.example',
      domain: 'acme.example',
      industries: [],
      sizeBand: null,
      employeeCount: null,
      hqLocation: null,
      foundedYear: null,
      description: null,
      facts: { website: { source: 'bank:robohire', fetchedAt: '2026-09-01' }, domain: { source: 'bank:robohire', fetchedAt: '2026-09-01' } },
    };
    const patch = companyPatch(
      existing,
      upsert({ website: 'https://other.example', sizeBand: '51-200', industries: ['Software'], facts: { website: FACT, sizeBand: FACT, industries: FACT } }),
    );
    expect(patch).toEqual({
      sizeBand: '51-200',
      industries: ['Software'],
      facts: { ...existing.facts, sizeBand: FACT, industries: FACT },
    });
    // A value without provenance is never written.
    expect(companyPatch(existing, upsert({ sizeBand: '51-200' }))).toBeNull();
  });

  it('creates missing companies once per (market, name), patches existing ones, and survives a slug clash', async () => {
    const db = createFakePrisma({
      uniqueFields: { rACompany: ['slug'] },
      seed: { rACompany: [{ id: 'old', market: 'intl', nameNormalized: 'beta', displayName: 'Beta', slug: 'acme-inc', industries: [], facts: {} }] },
    });
    const ids = await upsertCompanies(db as unknown as Pick<CompaniesDb, 'rACompany'>, [
      upsert({ logoUrl: 'https://logo.example/acme.png', facts: { logoUrl: FACT } }),
      upsert(), // same company twice in a batch
      upsert({ market: 'cn', displayName: '示例科技', nameNormalized: '示例科技' }),
      upsert({ displayName: 'Beta', nameNormalized: 'beta', sizeBand: '11-50', facts: { sizeBand: FACT } }),
    ]);
    const rows = db.$rows('rACompany');
    expect(rows).toHaveLength(3);
    const acme = rows.find((r) => r.nameNormalized === 'acme')!;
    expect(acme.slug).toMatch(/^acme-inc-[0-9a-f]{6}$/); // 'acme-inc' was taken by another company
    expect(acme.facts).toEqual({ logoUrl: FACT });
    expect(rows.find((r) => r.id === 'old')).toMatchObject({ sizeBand: '11-50', facts: { sizeBand: FACT } });
    expect(ids.get(companyKey('intl', 'beta'))).toBe('old');
    expect(ids.get(companyKey('cn', '示例科技'))).toBeTruthy();
  });
});

describe('profile facts (D3)', () => {
  const row = {
    id: 'c1',
    market: 'intl',
    nameNormalized: 'acme',
    displayName: 'Acme',
    slug: 'acme',
    domain: 'acme.example',
    logoUrl: null,
    website: 'https://acme.example',
    industries: ['Software'],
    sizeBand: '51-200',
    hqLocation: 'Austin, TX',
    foundedYear: 2001,
    description: 'Makes things.',
    facts: { website: FACT, sizeBand: { ...FACT, url: 'https://acme.example/about' } },
  };

  it('shows only fields with a provenance entry; the open-job count is our sourced index count', () => {
    const p = toCompanyProfile(row, 12, NOW);
    expect(p.facts).toEqual({
      website: { value: 'https://acme.example', source: 'provider:activejobs', asOf: FACT.fetchedAt },
      size: { value: '51-200', source: 'provider:activejobs', asOf: FACT.fetchedAt, url: 'https://acme.example/about' },
    });
    expect(p.domain).toBeNull(); // no provenance for the domain
    expect(p.openJobs).toEqual({ value: 12, source: 'index', asOf: NOW.toISOString(), method: 'computed' });
  });
});

describe('read service SQL', () => {
  it('typeahead is market-scoped, prefix-first then trigram similarity, with escaped LIKE input', async () => {
    const db = createFakePrisma({ sql: { results: [[{ id: 'c1', name: 'Acme', slug: 'acme', logoUrl: null, domain: null }]] } });
    const svc = createCompanyReadService(db as unknown as CompaniesDb, () => NOW);
    expect(await svc.typeahead('cn', 'Acme Labs, Inc.', 5)).toEqual([{ id: 'c1', name: 'Acme', slug: 'acme', logoUrl: null, domain: null }]);
    const call = db.$sql.last()!;
    expect(call.text).toMatchSnapshot();
    expect(call.text).toContain('c."nameNormalized" %');
    expect(call.text).toContain('similarity(c."nameNormalized",');
    expect(call.values[0]).toBe('cn');
    expect(call.values[1]).toBe('acme labs%'); // normalized (legal suffix dropped), prefix match
    expect(call.values[2]).toBe('acme labs');
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(call.values.at(-1)).toBe(5);
    expect(await svc.typeahead('intl', 'a')).toEqual([]);
  });
});

describe('routes', () => {
  let h: RouteHarness;
  const db = createFakePrisma({
    seed: {
      rACompany: [
        { id: 'c1', market: 'intl', nameNormalized: 'acme', displayName: 'Acme', slug: 'acme', domain: null, logoUrl: null, website: null, industries: [], sizeBand: null, hqLocation: null, foundedYear: null, description: null, facts: {} },
        { id: 'c2', market: 'cn', nameNormalized: '示例', displayName: '示例', slug: 'c-1234', domain: null, logoUrl: null, website: null, industries: [], sizeBand: null, hqLocation: null, foundedYear: null, description: null, facts: {} },
      ],
      rAJob: Array.from({ length: 24 }, (_, i) => ({
        id: `j${String(i).padStart(2, '0')}`,
        companyId: 'c1',
        market: 'intl',
        visibility: 'public',
        isCanonical: i !== 22,
        archivedAt: i === 21 ? NOW : null,
        title: `Role ${i}`,
        companyName: 'Acme',
        companyLogoUrl: null,
        location: 'Austin, TX',
        workModel: null,
        employmentType: null,
        seniority: null,
        salaryMin: i === 0 ? 100000 : null,
        salaryMax: i === 0 ? 150000 : null,
        salaryCurrency: i === 0 ? 'USD' : null,
        salaryPeriod: i === 0 ? 'year' : null,
        salaryText: null,
        salaryDisclosed: i === 0,
        // j23: a live job with no posting date (listed last, not first).
        postedAt: i === 23 ? null : new Date(NOW.getTime() - i * 86_400_000),
        // Only j00–j04 are cleared for public display (OPS-A4).
        publicDisplay: i < 5,
        lastSeenAt: NOW,
        sourceBoard: 'activejobs',
        sourceName: 'Active Jobs DB',
        originalSourceName: null,
        sourceUrl: null,
        fromRecruiterBank: false,
        employerVerified: false,
        isAgency: null,
      })),
      rAH1bEmployerStat: [
        { id: 'h1', employerNameNormalized: 'acme', fiscalYear: 2025, certifiedCount: 40, medianWageAnnualUsd: 140000, sourceFile: 'LCA_Disclosure_Data_FY2025_Q4.xlsx', importedAt: NOW, topTitles: [] },
      ],
    },
  });
  // The fake sorts `{ postedAt: 'desc' }` with NULLs last; translate Prisma's `{ sort, nulls }` form for it.
  const flatOrder = (orderBy: unknown) =>
    Array.isArray(orderBy)
      ? orderBy.map((o: Record<string, unknown>) =>
          Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v && typeof v === 'object' ? (v as { sort: string }).sort : v])),
        )
      : orderBy;
  const findMany = vi.fn((args: { orderBy?: unknown }) => db.rAJob.findMany({ ...args, orderBy: flatOrder(args.orderBy) } as never));
  const jobs = new Proxy(db.rAJob as object, { get: (t, k) => (k === 'findMany' ? findMany : Reflect.get(t, k)) });
  const serviceDb = new Proxy(db as object, { get: (t, k) => (k === 'rAJob' ? jobs : Reflect.get(t, k)) });
  const service = createCompanyReadService(serviceDb as unknown as CompaniesDb, () => NOW);
  const userOf = (req: { headers: Record<string, unknown> }) => (req.headers['x-test-user'] ? { id: String(req.headers['x-test-user']) } : null);
  const auth: RequestHandler[] = [fakeAuth(userOf)];
  // optionalAuth: sets req.user for a session, passes anonymous requests through.
  const optional: RequestHandler[] = [
    (req, _res, next) => {
      const u = userOf(req);
      if (u) (req as unknown as { user: unknown }).user = u;
      next();
    },
  ];

  beforeAll(async () => {
    h = await startRouteHarness({ mounts: [['/api/v1/roboapply/companies', createCompaniesRouter({ service, seekerAuth: auth, optionalAuth: optional, env: {} })]] });
  });
  afterAll(() => h.close());

  const user = { headers: { 'x-test-user': 'u1' } };

  it('typeahead needs a session and a 2+ character query', async () => {
    expect((await h.request('GET', '/api/v1/roboapply/companies?q=ac')).status).toBe(401);
    expect((await h.request('GET', '/api/v1/roboapply/companies?q=a', user)).status).toBe(422);
  });

  it('profile is public, scoped to the brand market (another market → 404)', async () => {
    const ok = await h.request<{ data: CompanyProfile }>('GET', '/api/v1/roboapply/companies/acme');
    expect(ok.status).toBe(200);
    // Anonymous: the count covers only jobs cleared for public display, matching what the list shows.
    expect(ok.body.data).toMatchObject({ id: 'c1', name: 'Acme', facts: {}, openJobs: { value: 5, source: 'index' } });
    const signedIn = await h.request<{ data: CompanyProfile }>('GET', '/api/v1/roboapply/companies/acme', user);
    expect(signedIn.body.data.openJobs).toMatchObject({ value: 22, source: 'index' });
    const other = await h.request<{ code: string; details: { code: string } }>('GET', '/api/v1/roboapply/companies/c2');
    expect(other.status).toBe(404);
    expect(other.body.details.code).toBe('company_not_found');
    const onGo = await h.request('GET', '/api/v1/roboapply/companies/c2', { host: 'goapply.localhost:3621' });
    expect(onGo.status).toBe(200);
  });

  it('anonymous callers get only jobs cleared for public display (OPS-A4)', async () => {
    const anon = await h.request<{ data: { items: Array<{ jobId: string }>; cursor: string | null } }>('GET', '/api/v1/roboapply/companies/c1/jobs');
    expect(anon.status).toBe(200);
    expect(anon.body.data.items.map((i) => i.jobId)).toEqual(['j00', 'j01', 'j02', 'j03', 'j04']);
    expect(anon.body.data.cursor).toBeNull();
    expect(findMany.mock.calls.at(-1)![0]).toMatchObject({ where: { companyId: 'c1', market: 'intl', isCanonical: true, archivedAt: null, publicDisplay: true } });
  });

  it('orders newest first with undated jobs last', () => {
    expect(companyJobsOrder()).toEqual([{ postedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }]);
  });

  it('lists live canonical public jobs 20 a page as feed cards for a signed-in viewer (no fit, no derived badges)', async () => {
    const first = await h.request<{ data: { items: Array<Record<string, unknown>>; cursor: string | null } }>('GET', '/api/v1/roboapply/companies/c1/jobs', user);
    expect(findMany.mock.calls.at(-1)![0]).toMatchObject({ orderBy: companyJobsOrder() });
    expect((findMany.mock.calls.at(-1)![0] as { where: Record<string, unknown> }).where).not.toHaveProperty('publicDisplay');
    expect(first.status).toBe(200);
    expect(first.body.data.items).toHaveLength(COMPANY_JOBS_PAGE);
    expect(first.body.data.items[0]).toMatchObject({
      jobId: 'j00',
      fit: null,
      badges: [],
      pay: { min: 100000, max: 150000, currency: 'USD', period: 'year', text: null },
      source: { name: 'Active Jobs DB', kind: 'provider' },
    });
    expect(first.body.data.items[1]!.pay).toBeNull();
    const second = await h.request<{ data: { items: Array<{ jobId: string; postedAt: string | null }>; cursor: string | null } }>(
      'GET',
      `/api/v1/roboapply/companies/c1/jobs?cursor=${first.body.data.cursor}`,
      user,
    );
    expect(second.body.data.items.map((i) => i.jobId)).toEqual(['j20', 'j23']);
    expect(second.body.data.items[1]!.postedAt).toBeNull();
    expect(second.body.data.cursor).toBeNull();
  });

  it('H-1B history cites the DOL file; off for GoApply (feature_disabled)', async () => {
    const res = await h.request<{ data: { years: Array<{ medianWage: Record<string, unknown> }>; disclaimer: string } }>('GET', '/api/v1/roboapply/companies/c1/h1b');
    expect(res.status).toBe(200);
    expect(res.body.data.years[0]!.medianWage).toMatchObject({ value: 140000, source: 'dol_lca', sourceFile: 'LCA_Disclosure_Data_FY2025_Q4.xlsx' });
    expect(res.body.data.disclaimer).toMatch(/not a visa approval/);
    const go = await h.request<{ code: string }>('GET', '/api/v1/roboapply/companies/c2/h1b', { host: 'goapply.localhost:3621' });
    expect(go.status).toBe(404);
    expect(go.body.code).toBe('feature_disabled');
  });
});
