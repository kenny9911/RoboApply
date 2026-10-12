// @vitest-environment node
// WP-16b: companies — ingest upsert with per-field provenance, typeahead
// (trigram + prefix, market-scoped), profile with sourced facts only,
// company jobs, H-1B (flag + DOL source), routes incl. auth and 404s.
// MKT-5G: the job list's two holds (a bank row without a posting page, a row
// that owes a credit line unless the caller prints it) and the sponsorship
// facts route (mount, flag, what it hands the service).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import type { RequestHandler } from 'express';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import { itemOwesCreditLine } from '../../feed/contract.js';
import { BANK_PAGES_ENV } from '../../feed/testkit.js';
import { twSourcesHooks, TW_OGDL_LICENCE_URL } from '../sources/twHooks.js';
import type { CompanyUpsert } from '../normalize/index.js';
import {
  COMPANY_JOBS_PAGE,
  companyJobsOrder,
  companyKey,
  companyPatch,
  companySlug,
  createCompaniesRouter,
  createCompanyReadService,
  creditLineMeta,
  escapeLike,
  INDUSTRY_IDS,
  industryIdFor,
  liveJobWhere,
  mapIndustries,
  MAX_POSTING_INDUSTRIES,
  POSTING_INDUSTRY_SOURCE,
  setIndustryFromPosting,
  SPONSORSHIP_DISCLAIMER,
  toCompanyProfile,
  upsertCompanies,
  type CompaniesDb,
  type CompanyProfile,
  type CompanySponsorshipResponse,
  type SponsorshipService,
} from './index.js';
import { ONBOARDING_INDUSTRIES } from '../../onboarding/contract.js';
import { flagEnvName } from '../../../platform/flags.js';
import { DOL_LCA_URL, USCIS_H1B_HUB_URL } from '../data/index.js';
import { createSponsorshipService, type SponsorshipDb } from './sponsorship/service.js';

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

describe('the company\'s job list: sources (M4 cross-review; the bank rule and the credit line, MKT-5G)', () => {
  // The list is the Company tab's "other jobs at this company" (components/features/company/CompanyTab.tsx) and
  // the API's `GET /companies/:id/jobs`. The tab shows a title and a place, so it cannot print a credit line.
  const row = (id: string, sourceBoard: string, over: Record<string, unknown> = {}) => ({
    id,
    companyId: 'c1',
    market: 'intl',
    visibility: 'public',
    isCanonical: true,
    archivedAt: null,
    title: `Role ${id}`,
    companyName: 'Acme',
    companyLogoUrl: null,
    location: 'Taipei',
    workModel: null,
    employmentType: null,
    seniority: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
    salaryText: null,
    salaryDisclosed: false,
    postedAt: NOW,
    publicDisplay: true,
    lastSeenAt: NOW,
    sourceBoard,
    sourceName: null,
    originalSourceName: null,
    sourceUrl: null,
    fromRecruiterBank: false,
    employerVerified: false,
    isAgency: null,
    ...over,
  });
  const db = createFakePrisma({
    seed: {
      rACompany: [{ id: 'c1', market: 'intl', nameNormalized: 'acme', displayName: 'Acme', slug: 'acme', domain: null, logoUrl: null, website: null, industries: [], sizeBand: null, hqLocation: null, foundedYear: null, description: null, facts: {} }],
      rAJob: [
        row('board', 'greenhouse'),
        row('open_data', 'tw_open_data'),
        row('gov', 'tw_gov_jobs'),
        row('unknown', 'some_new_source'),
        row('aggregator', 'jsearch'),
        row('bank', 'robohire', { fromRecruiterBank: true }),
        row('bank_go', 'gohire', { fromRecruiterBank: true }),
      ],
      rAH1bEmployerStat: [],
    },
  });
  // The credit line as the registered hook writes it (jobs/sources/twHooks.ts), without loading every hook module.
  const cardMeta = vi.fn((job: Parameters<NonNullable<typeof twSourcesHooks.cardMeta>>[0], ctx: Parameters<NonNullable<typeof twSourcesHooks.cardMeta>>[1]) => {
    const line = twSourcesHooks.appliesTo(job, ctx) ? twSourcesHooks.cardMeta!(job, ctx) : null;
    // A second set stands in for the other market hooks: its lines must not reach this list.
    return { ...(line ? { tw_sources: line } : {}), ats_public: { permitTags: ['from another hook set'] } };
  });
  const service = createCompanyReadService(db as unknown as CompaniesDb, () => NOW, { cardMeta });
  // Both banks have a candidate-facing posting page.
  const pages = { env: BANK_PAGES_ENV };
  const HELD_LINES = { NOT: { sourceBoard: { in: ['tw_open_data', 'tw_gov_jobs'] } } };

  it('a row that owes a credit line is neither listed nor counted: the list cannot print the line', async () => {
    for (const viewer of [{ publicOnly: true, ...pages }, { publicOnly: false, ...pages }]) {
      const list = await service.jobs('intl', 'c1', undefined, viewer);
      expect(list.items.map((i) => i.jobId).sort()).toEqual(['aggregator', 'bank', 'bank_go', 'board', 'unknown']);
      expect(list.items.some((i) => 'cardMeta' in i)).toBe(false);
      expect((await service.profile('intl', 'c1', viewer)).openJobs).toMatchObject({ value: 5 });
    }
    expect(cardMeta).not.toHaveBeenCalled();
    // The hold is in the one predicate the list and the count share, next to a caller's own restriction.
    expect(liveJobWhere('intl', 'c1', { publicOnly: true, ...pages }).AND).toEqual([HELD_LINES]);
    expect(liveJobWhere('cn', 'c1', { publicOnly: false, restrict: { fromRecruiterBank: false }, ...pages }).AND).toEqual([HELD_LINES, { fromRecruiterBank: false }]);
  });

  it('a caller whose surface prints the line gets those rows, each with its line as the feed card carries it, and counts them', async () => {
    const viewer = { publicOnly: false, printsCreditLine: true, ...pages };
    const list = await service.jobs('intl', 'c1', undefined, viewer);
    expect(list.items.map((i) => i.jobId).sort()).toEqual(['aggregator', 'bank', 'bank_go', 'board', 'gov', 'open_data', 'unknown']);
    expect((await service.profile('intl', 'c1', viewer)).openJobs).toMatchObject({ value: 7 });
    const byId = Object.fromEntries(list.items.map((i) => [i.jobId, i]));
    // Exactly the rows that owe a line carry one, and it is the licence's sentence with its link (2026 in Taipei).
    expect(list.items.filter(itemOwesCreditLine).map((i) => i.jobId).sort()).toEqual(['gov', 'open_data']);
    expect(byId.open_data!.cardMeta).toEqual({
      tw_sources: { attribution: { text: '資料來源：勞動部勞動力發展署 2026「台灣就業通網站職缺清單」，依政府資料開放授權條款第1版公開釋出', url: TW_OGDL_LICENCE_URL } },
    });
    expect((byId.gov!.cardMeta as { tw_sources: { attribution: { text: string } } }).tw_sources.attribution.text).toMatch(/^資料來源：行政院人事行政總處 2026/);
    // Only the credit line is carried: the other hook sets read columns this list does not select.
    for (const id of ['board', 'aggregator', 'bank', 'unknown']) expect(byId[id]).not.toHaveProperty('cardMeta');
    expect(liveJobWhere('intl', 'c1', viewer).AND).toEqual([]);
    expect(creditLineMeta({ ats_public: { x: 1 } })).toBeUndefined();
    expect(creditLineMeta({ tw_sources: {} })).toBeUndefined();
    expect(creditLineMeta(null)).toBeUndefined();
  });

  it('a recruiter-bank row whose bank has no posting page is neither listed nor counted, as in the feed (strategy M-7)', async () => {
    const ids = async (env: Record<string, string>) => {
      const viewer = { publicOnly: false, env };
      const list = (await service.jobs('intl', 'c1', undefined, viewer)).items.map((i) => i.jobId).sort();
      // The count and the list are one predicate.
      expect((await service.profile('intl', 'c1', viewer)).openJobs.value).toBe(list.length);
      return list;
    };
    // Neither bank has a page: its rows link to "Page not found" and are held.
    expect(await ids({})).toEqual(['aggregator', 'board', 'unknown']);
    expect(await ids({ GOHIRE_PUBLIC_JOB_URL_TEMPLATE: BANK_PAGES_ENV.GOHIRE_PUBLIC_JOB_URL_TEMPLATE! })).toEqual(['aggregator', 'bank_go', 'board', 'unknown']);
    expect(await ids({ ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE: BANK_PAGES_ENV.ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE! })).toEqual(['aggregator', 'bank', 'board', 'unknown']);
    expect(await ids({ ...BANK_PAGES_ENV })).toEqual(['aggregator', 'bank', 'bank_go', 'board', 'unknown']);
    expect(liveJobWhere('intl', 'c1', { publicOnly: false, env: {} }).AND).toEqual([HELD_LINES, { NOT: { fromRecruiterBank: true, sourceBoard: { in: ['robohire', 'gohire'] } } }]);
    // A caller that names no environment reads the process's own (the job page's count, the Assistant).
    vi.stubEnv('GOHIRE_PUBLIC_JOB_URL_TEMPLATE', '');
    vi.stubEnv('ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE', BANK_PAGES_ENV.ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE!);
    try {
      expect((await service.jobs('intl', 'c1', undefined, { publicOnly: false })).items.map((i) => i.jobId).sort()).toEqual(['aggregator', 'bank', 'board', 'unknown']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('an employer board is claimed only for a known board source; anything else is a provider, never "read from the employer"', async () => {
    const kinds = Object.fromEntries((await service.jobs('intl', 'c1', undefined, { publicOnly: false, ...pages })).items.map((i) => [i.jobId, i.source.kind]));
    // Before: every row that was not a bank's or one of three aggregators' was labelled `ats_public` (D3).
    expect(kinds).toEqual({ board: 'ats_public', unknown: 'provider', aggregator: 'provider', bank: 'bank', bank_go: 'bank' });
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

  // The facts route hands the service the market, the company, the viewer and the job page it is shown on.
  const FACTS: CompanySponsorshipResponse = {
    facts: [
      {
        kind: 'uscis_h1b_hub',
        fiscalYear: 2023,
        approvals: 11,
        denials: 2,
        employerName: 'EXAMPLE EMPLOYER LLC',
        source: { name: 'US Citizenship and Immigration Services, H-1B Employer Data Hub', url: USCIS_H1B_HUB_URL, sourceFile: 'h1b_datahubexport-2023.csv', asOf: '2025-07-01T00:00:00.000Z', dated: 'published' },
      },
    ],
    disclaimer: SPONSORSHIP_DISCLAIMER,
    viewerNeedsSponsorship: true,
  };
  const facts = vi.fn<SponsorshipService['facts']>(async () => FACTS);
  const sponsorship: SponsorshipService = { facts };

  beforeAll(async () => {
    h = await startRouteHarness({ mounts: [['/api/v1/roboapply/companies', createCompaniesRouter({ service, sponsorship, seekerAuth: auth, optionalAuth: optional, env: {} })]] });
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

  it('sponsorship facts: mounted next to /h1b, open to anyone on RoboApply, with the viewer and the job page passed on', async () => {
    const path = '/api/v1/roboapply/companies/c1/sponsorship';
    const anon = await h.request<{ data: CompanySponsorshipResponse }>('GET', path);
    expect(anon.status).toBe(200);
    expect(anon.body.data).toEqual(FACTS);
    expect(facts).toHaveBeenLastCalledWith('intl', 'c1', { userId: null, jobId: null });
    const signedIn = await h.request('GET', `${path}?jobId=j00`, user);
    expect(signedIn.status).toBe(200);
    expect(facts).toHaveBeenLastCalledWith('intl', 'c1', { userId: 'u1', jobId: 'j00' });
    // A job id is an id: nothing longer reaches the service.
    const calls = facts.mock.calls.length;
    expect((await h.request('GET', `${path}?jobId=${'x'.repeat(65)}`, user)).status).toBe(422);
    expect(facts.mock.calls.length).toBe(calls);
  });

  it('sponsorship facts: the h1bHistory flag gates the route; GoApply answers feature_disabled and the service is never asked', async () => {
    const calls = facts.mock.calls.length;
    const go = await h.request<{ code: string }>('GET', '/api/v1/roboapply/companies/c2/sponsorship', { host: 'goapply.localhost:3621' });
    expect(go.status).toBe(404);
    expect(go.body.code).toBe('feature_disabled');
    // RoboApply with the capability switched off: the same answer.
    const off = { [flagEnvName('roboapply', 'h1bHistory')]: 'false' };
    const offHarness = await startRouteHarness({ env: off, mounts: [['/api/v1/roboapply/companies', createCompaniesRouter({ service, sponsorship, seekerAuth: auth, optionalAuth: optional, env: off })]] });
    try {
      const res = await offHarness.request<{ code: string }>('GET', '/api/v1/roboapply/companies/c1/sponsorship', user);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('feature_disabled');
      // The older route shares the flag.
      expect((await offHarness.request<{ code: string }>('GET', '/api/v1/roboapply/companies/c1/h1b')).body.code).toBe('feature_disabled');
    } finally {
      await offHarness.close();
    }
    expect(facts.mock.calls.length).toBe(calls);
  });

  it('sponsorship facts through the real service: the company\'s rows with year, count, source and date; an unknown company is 404', async () => {
    const asOf = new Date('2025-07-01T00:00:00.000Z');
    const store = createFakePrisma({
      seed: {
        rACompany: db.$rows('rACompany').map((r) => ({ ...r })),
        rAH1bEmployerStat: db.$rows('rAH1bEmployerStat').map((r) => ({ ...r })),
        rASponsorRegisterEntry: [
          { id: 'r1', source: 'uscis_h1b_hub', country: 'US', employerNameNormalized: 'acme', employerName: 'ACME PLACEHOLDER INC', period: 'FY2023', approvals: 11, denials: 2, town: null, rating: null, routes: [], sourceFile: 'h1b_datahubexport-2023.csv', sourceUrl: USCIS_H1B_HUB_URL, asOf, importedAt: NOW },
        ],
        rAJob: [],
      },
    });
    const real = await startRouteHarness({
      mounts: [['/api/v1/roboapply/companies', createCompaniesRouter({ service, sponsorship: createSponsorshipService(store as unknown as SponsorshipDb), seekerAuth: auth, optionalAuth: optional, env: {} })]],
    });
    try {
      const res = await real.request<{ data: CompanySponsorshipResponse }>('GET', '/api/v1/roboapply/companies/c1/sponsorship');
      expect(res.status).toBe(200);
      expect(res.body.data.facts).toEqual([
        { kind: 'dol_lca', fiscalYear: 2025, certifiedCount: 40, source: { name: 'US Department of Labor, LCA disclosure data', url: DOL_LCA_URL, sourceFile: 'LCA_Disclosure_Data_FY2025_Q4.xlsx', asOf: NOW.toISOString(), dated: 'imported' } },
        {
          kind: 'uscis_h1b_hub',
          fiscalYear: 2023,
          approvals: 11,
          denials: 2,
          employerName: 'ACME PLACEHOLDER INC',
          source: { name: 'US Citizenship and Immigration Services, H-1B Employer Data Hub', url: USCIS_H1B_HUB_URL, sourceFile: 'h1b_datahubexport-2023.csv', asOf: asOf.toISOString(), dated: 'published' },
        },
      ]);
      expect(res.body.data.disclaimer).toBe(SPONSORSHIP_DISCLAIMER);
      expect(res.body.data.viewerNeedsSponsorship).toBe(false);
      // The other market's company does not exist here.
      const other = await real.request<{ details: { code: string } }>('GET', '/api/v1/roboapply/companies/c2/sponsorship');
      expect(other.status).toBe(404);
      expect(other.body.details.code).toBe('company_not_found');
    } finally {
      await real.close();
    }
  });

  it('GoApply: the route reads the bank posting-page settings of its own environment; a GoHire row is listed and counted once that page exists', async () => {
    const cnJob = (id: string, over: Record<string, unknown>) => ({
      id,
      companyId: 'c2',
      market: 'cn',
      visibility: 'public',
      ownerUserId: null,
      isCanonical: true,
      archivedAt: null,
      publicDisplay: true,
      title: `岗位 ${id}`,
      companyName: '示例',
      companyLogoUrl: null,
      location: '上海',
      workModel: null,
      employmentType: null,
      seniority: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryPeriod: null,
      salaryText: null,
      salaryDisclosed: false,
      postedAt: NOW,
      lastSeenAt: NOW,
      sourceName: null,
      originalSourceName: null,
      sourceUrl: null,
      employerVerified: false,
      isAgency: null,
      ...over,
    });
    const store = createFakePrisma({
      seed: {
        rACompany: db.$rows('rACompany').map((r) => ({ ...r })),
        rAJob: [cnJob('gh', { sourceBoard: 'gohire', sourceName: 'GoHire', fromRecruiterBank: true }), cnJob('board', { sourceBoard: 'greenhouse', fromRecruiterBank: false })],
      },
    });
    const read = async (env: Record<string, string>) => {
      const harness = await startRouteHarness({
        env,
        mounts: [['/api/v1/roboapply/companies', createCompaniesRouter({ service: createCompanyReadService(store as unknown as CompaniesDb, () => NOW), sponsorship, seekerAuth: auth, optionalAuth: optional, env })]],
      });
      try {
        const go = { host: 'goapply.localhost:3621', ...user };
        const jobs = await harness.request<{ data: { items: Array<{ jobId: string }> } }>('GET', '/api/v1/roboapply/companies/c2/jobs', go);
        const profile = await harness.request<{ data: CompanyProfile }>('GET', '/api/v1/roboapply/companies/c2', go);
        expect(jobs.status).toBe(200);
        return { listed: jobs.body.data.items.map((i) => i.jobId).sort(), counted: profile.body.data.openJobs.value };
      } finally {
        await harness.close();
      }
    };
    // No posting page for the GoHire bank: its row is held, the employer-board row is not.
    expect(await read({})).toEqual({ listed: ['board'], counted: 1 });
    expect(await read({ CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' })).toEqual({ listed: ['board'], counted: 1 });
    // With the page (the settings a GoApply control case needs for a GoHire fixture row): listed and counted.
    expect(await read({ CN_RECRUITMENT_INFO_MODE: 'partner_deeplink', ...BANK_PAGES_ENV })).toEqual({ listed: ['board', 'gh'], counted: 2 });
    // Recruitment-info mode off still lists no third-party posting, whatever the bank settings.
    expect(await read({ CN_RECRUITMENT_INFO_MODE: 'off', ...BANK_PAGES_ENV })).toEqual({ listed: [], counted: 0 });
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
