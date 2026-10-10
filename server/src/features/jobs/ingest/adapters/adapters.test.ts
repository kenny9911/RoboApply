// @vitest-environment node
// WP-16b: source adapters — RapidAPI params (Taiwan → country=tw, the seam
// WP-42 asserts), provider-stated extras, the bank cursor sync, the bank
// employer-signal adapter, the GoHire TLS rule (CN-E-05) and the registry.
// Parity wave (PAR-7): the per-brand source registry, the GoHire bank over
// HTTPS (whitelist, published-first pass, listing diff, tombstones), the
// posting-page rule for bank rows, and bank 学历 / 代招.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/prisma.js', () => ({
  default: {},
  prisma: {},
  createPrismaClientForUrl: vi.fn(() => ({ job: { findMany: vi.fn() } })),
  activeRuntimeUrl: () => 'postgresql://active.example/db',
  cleanConnectionString: (u: string | undefined) => u,
}));
vi.mock('../../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { logger } from '../../../../services/LoggerService.js';
import {
  __test as bankClientTest,
  bankApiConfig,
  bankDisabledReason,
  bankForMarket,
  bankMarket,
  bankTlsSatisfied,
  bankTransport,
  getBankClient,
  isBankEnabled,
} from '../../../../roboapply/v2/lib/raBankClients.js';
import { resetBankPublicJobUrlWarningsForTests } from '../../../../roboapply/v2/lib/raCrossBankMatch.js';
import { normalizeFantasticJob } from '../../../../roboapply/v2/lib/raFantasticJobs.js';
import { normalizeJSearchJob } from '../../../../roboapply/v2/lib/raRapidApiJobs.js';
import { getBrand } from '../../../../platform/brand/index.js';
import { getSourceAdapter, jobSourcesForBrand, registerSourceAdapter, resetJobSourceWarningsForTests, resetSourceAdaptersForTests } from '../../sources/index.js';
import type { JobSourceAdapter, SourceQuery } from '../../sources/index.js';
import { normalizeProviderJob } from '../../normalize/index.js';
import { adaptersForBrand, ingestProvidersForBrand, resetBuiltinAdaptersForTests, sourcesForBrand } from '../providers.js';
import {
  BANK_API_MAX_PAGES,
  BANK_API_PASS_BUDGET_MS,
  BANK_SYNC_SELECT,
  bankCursorWhere,
  classifyBankRow,
  createBankAdapter,
  bankCursorMark,
  bankPageMark,
  cursorWrittenWithoutPage,
  formatApiCursor,
  formatBankCursor,
  inputFromBankSyncRow,
  isBankTestPosting,
  isSyncableBankJob,
  parseApiCursor,
  parseBankCursor,
  pickBankSyncRow,
  readBankEmployerSignals,
  type BankFetchLike,
} from './bank.js';
import { createRapidApiAdapter, inputFromRapidApiRow, rapidApiCountry, rapidApiSearchParams, rapidApiSupportsCountry } from './rapidApi.js';

const NOW = new Date('2026-10-10T00:00:00Z');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RapidAPI search params (planner seam)', () => {
  it('searches Taiwan with country=tw when the market country is TW or the city is in Taiwan', () => {
    expect(rapidApiCountry({ country: 'TW' })).toBe('TW');
    expect(rapidApiCountry({ country: 'US', city: 'Taipei' })).toBe('TW');
    expect(rapidApiCountry({ country: 'US', city: 'Austin' })).toBe('US');
    expect(rapidApiSearchParams({ q: 'Backend engineer', country: 'TW', city: 'Taipei', datePosted: 'week' }, 'jsearch')).toEqual({
      query: 'Backend engineer in Taipei',
      country: 'tw',
      datePosted: 'week',
    });
    expect(rapidApiSearchParams({ q: 'Backend engineer', country: 'TW', datePosted: 'week', remote: true }, 'activejobs')).toEqual({
      query: 'Backend engineer',
      country: 'tw',
      datePosted: 'week',
      workFromHome: true,
      titleQuery: 'Backend engineer',
      locationText: 'Taiwan',
    });
  });

  it('Fantastic Jobs only plans countries it can scope; JSearch takes any ISO country', () => {
    expect(rapidApiSupportsCountry('activejobs', 'TW')).toBe(true);
    expect(rapidApiSupportsCountry('activejobs', 'KE')).toBe(false);
    expect(rapidApiSupportsCountry('jsearch', 'KE')).toBe(true);
    expect(rapidApiSupportsCountry('jsearch', '*')).toBe(false);
  });

  it('passes provider-stated extras (work arrangement, skills, levels, expiry, website) to the normalizer', () => {
    const aj = normalizeFantasticJob(
      {
        id: 7,
        title: 'Data Engineer',
        organization: 'Acme',
        url: 'https://boards.greenhouse.io/acme/jobs/7',
        source_type: 'ats',
        ai_work_arrangement: 'Hybrid',
        ai_experience_level: '2-5',
        ai_key_skills: ['Python', 'SQL', ''],
        date_validthrough: '2026-12-01T00:00:00',
        organization_url: 'https://acme.example',
      },
      'activejobs',
      NOW,
    )!;
    expect(aj).toMatchObject({ workType: 'unknown', workModel: 'Hybrid', experienceLevel: '2-5', skills: ['Python', 'SQL'], expiresAt: '2026-12-01T00:00:00', companyWebsite: 'https://acme.example' });
    const input = inputFromRapidApiRow(aj);
    expect(input.companyFacts).toEqual({ source: 'provider:activejobs', website: 'https://acme.example', fetchedAt: NOW.toISOString() });

    const js = normalizeJSearchJob(
      {
        job_id: 'abc',
        job_title: 'Analyst',
        employer_name: 'Beta',
        job_required_experience: { no_experience_required: false, required_experience_in_months: 36 },
        job_required_skills: ['Excel'],
        job_offer_expiration_datetime_utc: '2026-11-30T00:00:00.000Z',
      },
      { country: 'us', fetchedAt: NOW },
    )!;
    expect(js).toMatchObject({ experienceMonths: 36, skills: ['Excel'], expiresAt: '2026-11-30T00:00:00.000Z' });
    // Nothing is invented when the provider is silent.
    const bare = normalizeJSearchJob({ job_id: 'z', job_title: 'Analyst', employer_name: 'Beta' }, { country: 'us', fetchedAt: NOW })!;
    expect('skills' in bare || 'experienceMonths' in bare || 'companyWebsite' in bare).toBe(false);
  });

  it('a failing client becomes an error result, never a throw', async () => {
    const provider = { id: 'jsearch' as const, isEnabled: () => true, search: vi.fn(async () => null) };
    const a = createRapidApiAdapter('jsearch', { provider, isEnabled: () => true });
    const q = { id: 'q', provider: 'jsearch' as const, market: 'intl' as const, origin: 'demand' as const, params: { q: 'QA', country: 'US', datePosted: 'week' } };
    expect(await a.fetch(q, { now: NOW })).toEqual({ jobs: [], calls: 1, error: 'provider_unavailable' });
    provider.search.mockRejectedValueOnce(new Error('boom'));
    expect((await a.fetch(q, { now: NOW })).error).toBe('boom');
  });
});

describe('recruiter-bank cursor sync', () => {
  it('syncs only open AND published jobs', () => {
    expect(isSyncableBankJob({ status: 'open', publishedAt: NOW })).toBe(true);
    expect(isSyncableBankJob({ status: 'open', publishedAt: null })).toBe(false);
    expect(isSyncableBankJob({ status: 'draft', publishedAt: NOW })).toBe(false);
    expect(isSyncableBankJob({ status: 'paused', publishedAt: NOW })).toBe(false);
  });

  it('cursor round-trips and scopes the read to rows after it', () => {
    const c = formatBankCursor({ updatedAt: new Date('2026-10-05T01:02:03.000Z'), id: 'j9' });
    expect(parseBankCursor(c)).toEqual({ updatedAt: new Date('2026-10-05T01:02:03.000Z'), id: 'j9' });
    expect(parseBankCursor('garbage')).toBeNull();
    expect(parseBankCursor(null)).toBeNull();
    expect(bankCursorWhere(null)).toEqual({});
    expect(bankCursorWhere(parseBankCursor(c))).toEqual({
      OR: [{ updatedAt: { gt: new Date('2026-10-05T01:02:03.000Z') } }, { updatedAt: new Date('2026-10-05T01:02:03.000Z'), id: { gt: 'j9' } }],
    });
  });

  it('reads no internal recruiter fields', () => {
    const keys = Object.keys(BANK_SYNC_SELECT);
    for (const banned of ['notes', 'internalNotes', 'evaluationRules', 'interviewRequirements', 'userId', 'aiInsights']) expect(keys).not.toContain(banned);
    expect(Object.keys(BANK_SYNC_SELECT.company.select)).not.toContain('internalNotes');
  });

  it('employer signals are false unless the bank records them', () => {
    expect(readBankEmployerSignals({})).toEqual({ employerVerified: false, syndicationConsent: false });
    expect(readBankEmployerSignals({ employerVerified: 'yes', syndicationConsentAt: null })).toEqual({ employerVerified: false, syndicationConsent: false });
    expect(readBankEmployerSignals({ company: { employerVerified: true }, syndicationConsentAt: new Date() })).toEqual({ employerVerified: true, syndicationConsent: true });
  });

  it.todo('SR-16b-3/SR-16b-4: BANK_SYNC_SELECT reads the bank verified-employer and syndication-consent columns once RoboHire/GoHire add them');

  it('company facts from the bank carry the bank as their source; the apply link is the bank\'s posting page', () => {
    vi.stubEnv('ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'https://jobs.example.test/p/{id}');
    const input = inputFromBankSyncRow(
      'robohire',
      { id: 'r1', status: 'open', publishedAt: NOW, updatedAt: NOW, title: 'QA', companyName: 'Acme', company: { name: 'Acme', size: '51-200', industry: 'Software' } },
      NOW,
    )!;
    expect(input.companyFacts).toMatchObject({ source: 'bank:robohire', industries: ['Software'], size: '51-200' });
    expect(input.applyUrl).toBe('https://jobs.example.test/p/r1');
    const noFacts = inputFromBankSyncRow('robohire', { id: 'r2', status: 'open', publishedAt: NOW, updatedAt: NOW, title: 'QA', companyName: 'Acme' }, NOW)!;
    expect(noFacts.companyFacts).toBeUndefined();
  });

  it('a bank with no posting page yields no job at all (never a made-up /jobs/<id> link)', () => {
    expect(inputFromBankSyncRow('robohire', { id: 'r1', status: 'open', publishedAt: NOW, updatedAt: NOW, title: 'QA', companyName: 'Acme' }, NOW)).toBeNull();
    expect(inputFromBankSyncRow('gohire', { id: 'g1', status: 'open', publishedAt: NOW, updatedAt: NOW, title: '后端工程师', companyName: '某某科技' }, NOW)).toBeNull();
  });

  it('an unreachable bank is an error result; a read failure never throws', async () => {
    const q = { id: 'q', provider: 'bank_gohire' as const, market: 'cn' as const, origin: 'bank_sync' as const, params: { q: '', country: '*', datePosted: 'all' } };
    expect(await createBankAdapter('gohire', { read: async () => null }).fetch(q, { now: NOW })).toMatchObject({ error: 'bank_unavailable', jobs: [] });
    const failing = createBankAdapter('gohire', {
      read: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect((await failing.fetch(q, { now: NOW })).error).toContain('GoHire bank read failed');
  });
});

// ── Parity wave: what a bank row is, and when it is listed ─────────────────

const bankQuery = (cursor?: string): SourceQuery => ({
  id: 'q',
  provider: 'bank_gohire',
  market: 'cn',
  origin: 'bank_sync',
  params: { q: '', country: '*', datePosted: 'all', ...(cursor ? { cursor } : {}) },
});

const TEMPLATE = { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://example.test/p/{id}' };
/** The mark of a cursor written while that template was set. */
const PAGE_MARK = bankPageMark(TEMPLATE.GOHIRE_PUBLIC_JOB_URL_TEMPLATE);

function row(id: string, over: Record<string, unknown> = {}) {
  return { id, status: 'open', publishedAt: NOW, updatedAt: new Date(`2026-10-0${(Number(id.replace(/\D/g, '')) % 9) + 1}T00:00:00Z`), title: '后端工程师', companyName: '某某科技', ...over } as never;
}

describe('bank row rules (one rule for every transport)', () => {
  it('classifies closed, unpublished, unattributed and test rows; a testing job is not a test posting', () => {
    expect(classifyBankRow(row('j1'))).toBe('ok');
    expect(classifyBankRow(row('j1', { status: 'closed' }))).toBe('closed');
    expect(classifyBankRow(row('j1', { publishedAt: null }))).toBe('unpublished');
    expect(classifyBankRow(row('j1', { companyName: '  ', company: null }))).toBe('no_company');
    expect(classifyBankRow(row('j1', { title: '测试岗位请勿投递' }))).toBe('test_posting');
    // A test posting is a title that names no job: only 测试 / test / demo and filler.
    for (const title of ['测试', '測試', 'test 123', 'Test', 'Demo 2', 'demo', '内部测试职位', '测试岗位请勿投递', '测试数据-01', '测试职位（勿投）', 'TEST JOB - please ignore']) {
      expect(isBankTestPosting(title), title).toBe(true);
    }
    // 测试 is also the word for testing work: a real job is never dropped as a recruiter's test posting.
    for (const title of ['软件测试工程师', '高级测试开发工程师', '自动化测试', '测试经理', 'Test Engineer', 'QA Tester', 'Latest Demo Engineer']) {
      expect(isBankTestPosting(title), title).toBe(false);
    }
    // Review cases: testing jobs outside any list of QA role names.
    for (const title of ['电池测试技术员', '测试技术员', '产品测试', '测试运维工程师', '半导体测试设备工程师', '晶圆测试操作员', '射频测试', 'QA测试']) {
      expect(isBankTestPosting(title), title).toBe(false);
      expect(classifyBankRow(row('j1', { title }))).toBe('ok');
    }
    expect(isBankTestPosting('后端工程师')).toBe(false);
    expect(isBankTestPosting(null)).toBe(false);
  });

  it('GoHire rows are agency postings (代招) unless the bank says the employer is verified; the employer itself is not marked an agency', () => {
    const unverified = inputFromBankSyncRow('gohire', row('g1'), NOW, { publicJobUrl: () => 'https://example.test/p/g1' })!;
    expect(unverified.agencyPosting).toBe(true);
    const job = normalizeProviderJob(unverified, 'bank_gohire', { market: 'cn', now: NOW });
    expect(job).toMatchObject({ isAgency: true, employerVerified: false, fromRecruiterBank: true, market: 'cn' });
    expect(job.company.isAgency).toBeNull();
    const verified = inputFromBankSyncRow('gohire', row('g2', { employerVerified: true }), NOW, { publicJobUrl: () => 'https://example.test/p/g2' })!;
    expect(verified.agencyPosting).toBe(false);
    expect(normalizeProviderJob(verified, 'bank_gohire', { market: 'cn', now: NOW })).toMatchObject({ isAgency: null, employerVerified: true });
    // RoboHire rows keep today's rule (no blanket agency label).
    expect(inputFromBankSyncRow('robohire', row('r1'), NOW, { publicJobUrl: () => 'https://example.test/p/r1' })!.agencyPosting).toBeNull();
  });

  it('maps the bank 学历 field (本科, bachelor, associate) and carries headcount', () => {
    for (const [education, level] of [['本科', 'bachelor'], ['bachelor', 'bachelor'], ['associate', 'associate'], ['不限', 'none'], ['硕士', 'master'], ['博士', 'phd'], ['high_school', null]] as const) {
      const input = inputFromBankSyncRow('gohire', row('g1', { education, headcount: 3 }), NOW, { publicJobUrl: () => 'https://example.test/p/g1' })!;
      const job = normalizeProviderJob(input, 'bank_gohire', { market: 'cn', now: NOW });
      expect(job.educationLevel).toBe(level);
      expect(job.fieldSources.educationLevel).toBe(level ? 'provider' : undefined);
      expect(job.headcount).toBe(3);
    }
    expect(Object.keys(BANK_SYNC_SELECT)).toEqual(expect.arrayContaining(['education', 'headcount']));
  });
});

describe('database transport: held rows and the posting-page rule', () => {
  afterEach(() => resetBankPublicJobUrlWarningsForTests());

  it('with no posting page: nothing is emitted, held ids close as no_apply_target, every open row of the bank is closed, and the cursor is marked', async () => {
    const adapter = createBankAdapter('gohire', {
      env: {},
      read: async () => [row('j1'), row('j2', { publishedAt: null }), row('j3', { companyName: '' }), row('j4', { title: '测试' }), row('j5', { status: 'closed' })],
    });
    const out = await adapter.fetch(bankQuery(), { now: NOW });
    expect(out.jobs).toEqual([]);
    expect(out.closures).toEqual([{ externalIds: ['j1'], reason: 'no_apply_target' }]);
    expect(out.closedExternalIds).toEqual(['j2', 'j3', 'j4', 'j5']);
    expect(out.listing).toEqual({ externalIds: [], reason: 'no_apply_target' });
    expect(out.notes).toEqual({ bank_synced: 1, bank_no_public_page: 1, bank_unpublished: 1, bank_no_company: 1, bank_test_posting: 1, bank_closed: 1 });
    expect(cursorWrittenWithoutPage(out.cursor)).toBe(true);
    expect(parseBankCursor(out.cursor)).toMatchObject({ id: 'j5' });
  });

  it('with a page template: the row is emitted with that apply URL, nothing is held, and no blanket closure is reported', async () => {
    const adapter = createBankAdapter('gohire', { env: TEMPLATE, read: async () => [row('j1'), row('j2', { publishedAt: null })] });
    const out = await adapter.fetch(bankQuery(), { now: NOW });
    expect(out.jobs.map((j) => [j.externalId, j.applyUrl])).toEqual([['j1', 'https://example.test/p/j1']]);
    expect(out.closures).toEqual([]);
    expect(out.listing).toBeNull();
    expect(out.closedExternalIds).toEqual(['j2']);
    expect(cursorWrittenWithoutPage(out.cursor)).toBe(false);
    expect(bankCursorMark(out.cursor)).toBe(PAGE_MARK);
    expect(PAGE_MARK).toMatch(/^page:[0-9a-f]{8}$/);
  });

  it('the first sync after the template is set starts from the beginning, so held rows come back', async () => {
    const seen: Array<unknown> = [];
    const adapter = createBankAdapter('gohire', {
      env: TEMPLATE,
      read: async (_bank, cursor) => {
        seen.push(cursor);
        return [row('j1')];
      },
    });
    const first = await adapter.fetch(bankQuery('2026-10-05T00:00:00.000Z|j9|nopage'), { now: NOW });
    expect(seen[0]).toBeNull();
    // The cursor it writes names the page it ran with, and the next sync continues from it.
    expect(first.cursor).toBe(`${formatBankCursor(row('j1'))}|${PAGE_MARK}`);
    await adapter.fetch(bankQuery(first.cursor!), { now: NOW });
    expect(seen[1]).toEqual(parseBankCursor(first.cursor));
    expect(seen[1]).not.toBeNull();
  });

  it('a cursor written before the posting-page rule (no mark) restarts once when a template is set, so no stored row keeps the old /jobs/<id> link', async () => {
    // Review case: the template is already set at the first sync after the merge.
    const seen: Array<unknown> = [];
    const adapter = createBankAdapter('robohire', {
      env: { ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://jobs.example.test/p/{id}' },
      read: async (_bank, cursor) => {
        seen.push(cursor);
        return cursor ? [] : [row('j1'), row('j2')];
      },
    });
    const out = await adapter.fetch({ ...bankQuery('2026-10-05T00:00:00.000Z|j9'), provider: 'bank_robohire', market: 'intl' }, { now: NOW });
    expect(seen).toEqual([null]);
    // Every stored row is read again and rewritten with the bank's real page.
    expect(out.jobs.map((j) => j.applyUrl)).toEqual(['https://jobs.example.test/p/j1', 'https://jobs.example.test/p/j2']);
    expect(bankCursorMark(out.cursor)).toBe(bankPageMark('https://jobs.example.test/p/{id}'));
    // The restart happens once: the marked cursor is continued.
    await adapter.fetch({ ...bankQuery(out.cursor!), provider: 'bank_robohire', market: 'intl' }, { now: NOW });
    expect(seen[1]).toEqual(parseBankCursor(out.cursor));
    expect(seen[1]).not.toBeNull();
  });

  it('a changed template restarts once too; with no template an unmarked cursor is continued and marked nopage', async () => {
    const seen: Array<unknown> = [];
    const read = async (_bank: unknown, cursor: unknown) => {
      seen.push(cursor);
      return [row('j1')];
    };
    const other = createBankAdapter('gohire', { env: { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://other.example.test/jobs/{id}' }, read: read as never });
    const moved = await other.fetch(bankQuery(`2026-10-05T00:00:00.000Z|j9|${PAGE_MARK}`), { now: NOW });
    expect(seen[0]).toBeNull();
    expect(moved.jobs[0]!.applyUrl).toBe('https://other.example.test/jobs/j1');
    expect(bankCursorMark(moved.cursor)).not.toBe(PAGE_MARK);

    const held = await createBankAdapter('gohire', { env: {}, read: read as never }).fetch(bankQuery('2026-10-05T00:00:00.000Z|j9'), { now: NOW });
    expect(seen[1]).toEqual({ updatedAt: new Date('2026-10-05T00:00:00.000Z'), id: 'j9' });
    expect(cursorWrittenWithoutPage(held.cursor)).toBe(true);
    // Marks: only the three forms parse.
    expect(bankCursorMark('2026-10-05T00:00:00.000Z|j9')).toBeNull();
    expect(bankCursorMark('2026-10-05T00:00:00.000Z|j9|nopage')).toBe('nopage');
    expect(parseBankCursor('2026-10-05T00:00:00.000Z|j9|page')).toBeNull();
    expect(parseBankCursor(`2026-10-05T00:00:00.000Z|j9|${PAGE_MARK}`)).toEqual({ updatedAt: new Date('2026-10-05T00:00:00.000Z'), id: 'j9' });
  });
});

// ── Parity wave: the GoHire bank over HTTPS ────────────────────────────────

const API_ENV = { GOHIRE_API_KEY: 'rh_test_key_never_logged', GOHIRE_API_BASE: 'https://api.gohire.test', ...TEMPLATE };

/** A list row as the GoHire endpoint sends it: every Job column, the internal ones included. */
function apiRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    status: 'open',
    publishedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    title: '后端工程师',
    companyName: '某某科技',
    description: '负责后端开发',
    education: '本科',
    headcount: 2,
    // Recruiter-internal fields the whitelist must drop:
    notes: 'INTERNAL-NOTE-SECRET',
    evaluationRules: 'EVAL-RULES-SECRET',
    passingScore: 60,
    aiInsights: { report: 'AI-INSIGHTS-SECRET' },
    clientKey: 'client-key-secret',
    organizationId: 'org_secret',
    userId: 'user_secret',
    hiringRequest: { id: 'hr_secret', title: 'HR-TITLE-SECRET' },
    stats: { matches: 9 },
    ...over,
  };
}

interface FakeApi {
  fetch: BankFetchLike;
  calls: Array<{ url: string; headers: Record<string, string> | undefined }>;
}

function fakeApi(pages: unknown[][], options: { total?: number; failAt?: number; status?: number } = {}): FakeApi {
  const calls: FakeApi['calls'] = [];
  const fetch: BankFetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    if (options.failAt === page) return { ok: false, status: options.status ?? 502, text: async () => 'UPSTREAM-BODY-SECRET' };
    const data = pages[page - 1] ?? [];
    const total = options.total ?? pages.flat().length;
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data, pagination: { page, limit: 50, total, totalPages: pages.length, hasMore: false } }) };
  };
  return { fetch, calls };
}

const fifty = (prefix: string, over: Record<string, unknown> = {}) => Array.from({ length: 50 }, (_, i) => apiRow(`${prefix}${i}`, over));

describe('GoHire bank over HTTPS (interim list reader)', () => {
  afterEach(() => resetBankPublicJobUrlWarningsForTests());

  it('the whitelist keeps the BANK_SYNC_SELECT fields and nothing else', () => {
    const picked = pickBankSyncRow(apiRow('j1'))!;
    expect(Object.keys(picked).sort()).toEqual([...Object.keys(BANK_SYNC_SELECT)].sort());
    expect(picked.company).toBeNull();
    expect(picked).toMatchObject({ id: 'j1', education: '本科', headcount: 2, publishedAt: new Date('2026-10-01T00:00:00.000Z') });
    expect(JSON.stringify(picked)).not.toMatch(/SECRET|secret/);
    expect(pickBankSyncRow({ title: 'no id' })).toBeNull();
    expect(pickBankSyncRow('nope')).toBeNull();
  });

  it('calls the list endpoint published-first with the key in a header, and stops at the first unpublished row', async () => {
    const api = fakeApi([fifty('a'), [apiRow('b0'), apiRow('b1'), apiRow('u0', { publishedAt: null }), apiRow('u1', { publishedAt: null })], fifty('never', { publishedAt: null })], { total: 1273 });
    const adapter = createBankAdapter('gohire', { env: API_ENV, transport: () => 'api', fetch: api.fetch });
    const out = await adapter.fetch(bankQuery(), { now: NOW });
    expect(api.calls.map((c) => c.url)).toEqual([
      'https://api.gohire.test/api/v1/jobs?status=open&sortBy=aging&limit=50&page=1',
      'https://api.gohire.test/api/v1/jobs?status=open&sortBy=aging&limit=50&page=2',
    ]);
    expect(api.calls[0]!.headers).toMatchObject({ 'X-API-Key': 'rh_test_key_never_logged' });
    expect(out.calls).toBe(2);
    expect(out.jobs).toHaveLength(52);
    expect(out.jobs[0]).toMatchObject({ externalId: 'a0', applyUrl: 'https://example.test/p/a0', sourceBoard: 'gohire', educationLevel: '本科', agencyPosting: true });
    // The requisitions the recruiters never published: the endpoint's own count minus the published rows read.
    expect(out.notes).toMatchObject({ bank_synced: 52, bank_unpublished: 1273 - 52 });
    expect(out.error).toBeUndefined();
    expect(parseApiCursor(out.cursor)).toEqual({ passStart: NOW, page: 1 });
    expect(out.exhausted).toBe(true);
  });

  it('a response row carrying notes or evaluationRules never reaches a job, a note or an error', async () => {
    const api = fakeApi([[apiRow('j1'), apiRow('j2', { companyName: '' }), apiRow('j3', { title: '测试' })]]);
    const out = await createBankAdapter('gohire', { env: API_ENV, transport: () => 'api', fetch: api.fetch }).fetch(bankQuery(), { now: NOW });
    expect(JSON.stringify(out)).not.toMatch(/SECRET|secret|rh_test_key/);
    expect(out.notes).toMatchObject({ bank_synced: 1, bank_no_company: 1, bank_test_posting: 1 });
    expect(out.closedExternalIds).toEqual(['j2', 'j3']);
  });

  it('a complete pass reports the listing (the diff closes what is missing); a failed pass reports none and writes nothing', async () => {
    const ok = await createBankAdapter('gohire', { env: API_ENV, transport: () => 'api', fetch: fakeApi([[apiRow('j1'), apiRow('j2')]]).fetch }).fetch(bankQuery(), { now: NOW });
    expect(ok.listing).toEqual({ externalIds: ['j1', 'j2'], reason: 'bank_closed' });

    const failing = fakeApi([fifty('a'), fifty('b')], { failAt: 2, status: 502 });
    const failed = await createBankAdapter('gohire', { env: API_ENV, transport: () => 'api', fetch: failing.fetch }).fetch(bankQuery(), { now: NOW });
    expect(failed).toEqual({ jobs: [], calls: 2, error: 'GoHire bank read failed: http_502' });
    expect(JSON.stringify(failed)).not.toContain('UPSTREAM-BODY-SECRET');
    expect(failed.listing).toBeUndefined();
  });

  it('the pass stops inside the caller\'s remaining budget (the ingest tick), not only inside its own 100 s (review fix)', async () => {
    // Each request takes 6 s on the fake clock; the tick has 10 s left.
    let t = 0;
    const api = fakeApi([fifty('a'), fifty('b'), fifty('c'), fifty('d')]);
    const slow: BankFetchLike = async (url, init) => {
      t += 6_000;
      return api.fetch(url, init);
    };
    const adapter = createBankAdapter('gohire', { env: API_ENV, transport: () => 'api', fetch: slow, clock: () => t });
    const out = await adapter.fetch(bankQuery(), { now: NOW, budgetMs: 10_000 });
    // Two requests (0 s and 6 s); at 12 s the budget is spent, so page 3 is left for the next run.
    expect(out.calls).toBe(2);
    expect(out.jobs).toHaveLength(100);
    expect(out.notes).toMatchObject({ bank_pass_cut_short: 1 });
    expect(out.cursor).toBe(formatApiCursor(NOW, 3));
    expect(out.exhausted).toBe(false);
    expect(out.listing).toBeNull();
    // With no caller budget the pass keeps its own cap and reads on.
    t = 0;
    const free = await createBankAdapter('gohire', { env: API_ENV, transport: () => 'api', fetch: slow, clock: () => t }).fetch(bankQuery(), { now: NOW });
    expect(free.calls).toBe(4);
    expect(BANK_API_PASS_BUDGET_MS).toBe(100_000);
  });

  it('a later page that runs out of the budget is a pass cut short (rows kept, resumed at that page), not a failed pass', async () => {
    const api = fakeApi([fifty('a'), fifty('b')]);
    let n = 0;
    const fetch: BankFetchLike = (url, init) => {
      n += 1;
      if (n === 1) return api.fetch(url, init);
      // The second request never answers; its timeout was shortened to what is left of the budget.
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    let t = 0;
    const adapter = createBankAdapter('gohire', {
      env: API_ENV,
      transport: () => 'api',
      fetch: (url, init) => {
        const p = fetch(url, init);
        t += 9_990; // 10 ms of the budget are left after the first request
        return p;
      },
      clock: () => t,
      timeoutMs: 20_000,
    });
    const started = Date.now();
    const out = await adapter.fetch(bankQuery(), { now: NOW, budgetMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out.error).toBeUndefined();
    expect(out.calls).toBe(2);
    expect(out.jobs).toHaveLength(50);
    expect(out.cursor).toBe(formatApiCursor(NOW, 2));
    expect(out.notes).toMatchObject({ bank_pass_cut_short: 1 });
    expect(out.listing).toBeNull();
  });

  it('a timeout is an error result (no body, no URL, no key in the text)', async () => {
    const hang: BankFetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted https://api.gohire.test?key=rh_test_key_never_logged'))));
    const out = await createBankAdapter('gohire', { env: API_ENV, transport: () => 'api', fetch: hang, timeoutMs: 5 }).fetch(bankQuery(), { now: NOW });
    expect(out).toEqual({ jobs: [], calls: 1, error: 'GoHire bank read failed: timeout' });
  });

  it('reads at most 40 pages per pass and then reports no listing (a capped pass closes nothing)', async () => {
    const pages = Array.from({ length: BANK_API_MAX_PAGES + 5 }, (_, p) => fifty(`p${p}_`));
    const api = fakeApi(pages);
    const out = await createBankAdapter('gohire', { env: API_ENV, transport: () => 'api', fetch: api.fetch }).fetch(bankQuery(), { now: NOW });
    expect(api.calls).toHaveLength(BANK_API_MAX_PAGES);
    expect(out.jobs).toHaveLength(BANK_API_MAX_PAGES * 50);
    expect(out.listing).toBeNull();
    expect(out.notes).toMatchObject({ bank_page_cap: 1 });
  });

  it('a pass cut short by its time budget resumes at the next page and never reports a listing', async () => {
    const api = fakeApi([fifty('a'), fifty('b'), [apiRow('c0')]]);
    let t = 0;
    const adapter = createBankAdapter('gohire', { env: API_ENV, transport: () => 'api', fetch: api.fetch, passBudgetMs: 10, clock: () => (t += 20) });
    const first = await adapter.fetch(bankQuery(), { now: NOW });
    expect(first.listing).toBeNull();
    expect(first.exhausted).toBe(false);
    expect(first.notes).toMatchObject({ bank_pass_cut_short: 1 });
    expect(first.cursor).toBe(formatApiCursor(NOW, 2));
    // The resumed pass finishes, but it did not see page 1: no listing diff.
    t = -1000;
    const resumed = await createBankAdapter('gohire', { env: API_ENV, transport: () => 'api', fetch: api.fetch }).fetch(bankQuery(first.cursor!), { now: new Date('2026-10-10T00:10:00Z') });
    expect(resumed.jobs.map((j) => j.externalId)).toHaveLength(51);
    expect(resumed.listing).toBeNull();
    expect(parseApiCursor(resumed.cursor)).toEqual({ passStart: NOW, page: 1 });
  });

  it('with no posting page the pass still counts the bank: every published row is held as no_apply_target', async () => {
    const env = { GOHIRE_API_KEY: 'k', GOHIRE_API_BASE: 'https://api.gohire.test' };
    const out = await createBankAdapter('gohire', { env, transport: () => 'api', fetch: fakeApi([[apiRow('j1'), apiRow('j2')]], { total: 10 }).fetch }).fetch(bankQuery(), { now: NOW });
    expect(out.jobs).toEqual([]);
    expect(out.closures).toEqual([{ externalIds: ['j1', 'j2'], reason: 'no_apply_target' }]);
    expect(out.listing).toEqual({ externalIds: [], reason: 'bank_closed' });
    expect(out.notes).toEqual({ bank_synced: 2, bank_no_public_page: 2, bank_unpublished: 8 });
  });

  it('the list cursor is its own: a database cursor starts a new pass, and the reverse', () => {
    expect(parseApiCursor('2026-10-05T01:02:03.000Z|j9')).toBeNull();
    expect(parseBankCursor(formatApiCursor(NOW, 3))).toBeNull();
    expect(parseApiCursor(formatApiCursor(NOW, 3))).toEqual({ passStart: NOW, page: 3 });
  });
});

describe('GoHire syndication endpoint (cursor + tombstones)', () => {
  it('a cursor sync upserts rows and a tombstone closes one', async () => {
    const calls: string[] = [];
    const fetch: BankFetchLike = async (url) => {
      calls.push(url);
      const data = [
        { ...apiRow('s1'), updatedAt: '2026-10-06T00:00:00.000Z', employerVerified: true, syndicationConsentAt: '2026-09-01T00:00:00.000Z', company: { id: 'c1', name: '某某科技', website: 'https://example.cn', internalNotes: 'COMPANY-SECRET' } },
        { id: 's2', updatedAt: '2026-10-07T00:00:00.000Z', deleted: true },
      ];
      return { ok: true, status: 200, text: async () => JSON.stringify({ data }) };
    };
    const env = { ...API_ENV, GOHIRE_SYNDICATION_URL: 'https://api.gohire.test/api/v1/syndication/jobs' };
    const adapter = createBankAdapter('gohire', { env, transport: () => 'syndication', fetch, pageSize: () => 200 });
    const out = await adapter.fetch(bankQuery(`2026-10-05T00:00:00.000Z|j9|${PAGE_MARK}`), { now: NOW });
    // The endpoint is sent the position only, never our mark.
    expect(calls).toEqual(['https://api.gohire.test/api/v1/syndication/jobs?cursor=2026-10-05T00%3A00%3A00.000Z%7Cj9&limit=200']);
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]).toMatchObject({ externalId: 's1', employerVerified: true, syndicationConsent: true, agencyPosting: false, bankCompanyRef: 'gohire:c1' });
    expect(out.closedExternalIds).toEqual(['s2']);
    expect(out.cursor).toBe(`2026-10-07T00:00:00.000Z|s2|${PAGE_MARK}`);
    expect(JSON.stringify(out)).not.toMatch(/SECRET/);
  });
});

describe('bank clients: TLS, markets, guards', () => {
  it('GoHire requires sslmode=require or stricter (local hosts exempt); RoboHire unchanged', () => {
    expect(bankTlsSatisfied('gohire', 'postgresql://u:p@db.gohire.example:5432/gh')).toBe(false);
    expect(bankTlsSatisfied('gohire', 'postgresql://u:p@db.gohire.example:5432/gh?sslmode=prefer')).toBe(false);
    expect(bankTlsSatisfied('gohire', 'postgresql://u:p@db.gohire.example:5432/gh?sslmode=require')).toBe(true);
    expect(bankTlsSatisfied('gohire', 'postgresql://u:p@db.gohire.example:5432/gh?sslmode=verify-full')).toBe(true);
    expect(bankTlsSatisfied('gohire', 'postgresql://u:p@localhost:5432/gh')).toBe(true);
    expect(bankTlsSatisfied('gohire', 'not a url')).toBe(false);
    expect(bankTlsSatisfied('robohire', 'postgresql://u:p@db.robohire.example/rh')).toBe(true);
  });

  it('a GoHire URL without TLS disables the bank when there is no API key', () => {
    vi.stubEnv('DATABASE_URL_GOHIRE', 'postgresql://u:p@db.gohire.example/gh');
    vi.stubEnv('RA_CROSSBANK_CROSS_TENANT_CONFIRMED', 'true');
    vi.stubEnv('GOHIRE_API_KEY', '');
    expect(isBankEnabled('gohire')).toBe(false);
    expect(bankDisabledReason('gohire')).toBe('tls_required_no_api_key');
    vi.stubEnv('DATABASE_URL_GOHIRE', 'postgresql://u:p@db.gohire.example/gh?sslmode=require');
    expect(isBankEnabled('gohire')).toBe(true);
    expect(bankTransport('gohire')).toBe('db');
    vi.stubEnv('RA_CROSSBANK_GOHIRE_DISABLED', 'true');
    expect(isBankEnabled('gohire')).toBe(false);
    expect(bankDisabledReason('gohire')).toBe('kill_switch');
    bankClientTest.resetCache();
    vi.unstubAllEnvs();
  });

  it('GOHIRE_BANK_TRANSPORT: db when the URL satisfies TLS, else api when the key is set; a choice that cannot be honoured is off', () => {
    const plain = 'postgresql://u:p@db.gohire.example/gh';
    const tls = `${plain}?sslmode=require`;
    const key = { GOHIRE_API_KEY: 'k' };
    expect(bankTransport('gohire', { DATABASE_URL_GOHIRE: tls })).toBe('db');
    expect(bankTransport('gohire', { DATABASE_URL_GOHIRE: tls, ...key })).toBe('db');
    // The current environment: a database URL that does not require TLS, and the API key.
    expect(bankTransport('gohire', { DATABASE_URL_GOHIRE: plain, ...key })).toBe('api');
    expect(bankTransport('gohire', { DATABASE_URL_GOHIRE: plain })).toBe('off');
    expect(bankTransport('gohire', key)).toBe('api');
    expect(bankTransport('gohire', {})).toBe('off');
    expect(bankTransport('gohire', { DATABASE_URL_GOHIRE: tls, ...key, GOHIRE_BANK_TRANSPORT: 'api' })).toBe('api');
    expect(bankTransport('gohire', { DATABASE_URL_GOHIRE: tls, ...key, GOHIRE_BANK_TRANSPORT: 'off' })).toBe('off');
    expect(bankTransport('gohire', { DATABASE_URL_GOHIRE: plain, ...key, GOHIRE_BANK_TRANSPORT: 'db' })).toBe('off');
    expect(bankTransport('gohire', { DATABASE_URL_GOHIRE: tls, GOHIRE_BANK_TRANSPORT: 'api' })).toBe('off');
    expect(bankTransport('gohire', { DATABASE_URL_GOHIRE: tls, GOHIRE_BANK_TRANSPORT: 'nonsense' })).toBe('db');
    // RoboHire has no HTTPS transport.
    expect(bankTransport('robohire', { DATABASE_URL_ROBOHIRE: 'postgresql://u:p@db.robohire.example/rh', ...key })).toBe('db');
    expect(bankTransport('robohire', key)).toBe('off');
  });

  it('the API is HTTPS only; the syndication URL is optional', () => {
    expect(bankApiConfig('gohire', { GOHIRE_API_KEY: 'k' })).toEqual({ base: 'https://api.gohire.top', key: 'k', syndicationUrl: null });
    expect(bankApiConfig('gohire', { GOHIRE_API_KEY: 'k', GOHIRE_API_BASE: 'https://api.example.test/' })).toMatchObject({ base: 'https://api.example.test' });
    expect(bankApiConfig('gohire', { GOHIRE_API_KEY: 'k', GOHIRE_API_BASE: 'http://api.example.test' })).toBeNull();
    expect(bankApiConfig('gohire', { GOHIRE_API_KEY: 'k', GOHIRE_SYNDICATION_URL: 'http://api.example.test/s' })).toBeNull();
    expect(bankApiConfig('gohire', { GOHIRE_API_KEY: 'k', GOHIRE_SYNDICATION_URL: 'https://api.example.test/s' })).toMatchObject({ syndicationUrl: 'https://api.example.test/s' });
    expect(bankApiConfig('gohire', {})).toBeNull();
    expect(bankApiConfig('robohire', { GOHIRE_API_KEY: 'k' })).toBeNull();
  });

  it('with the current env (non-TLS database URL, API key) the GoHire adapter is enabled over HTTPS and no database pool is opened', () => {
    bankClientTest.resetCache();
    vi.stubEnv('DATABASE_URL_GOHIRE', 'postgresql://u:secret@db.gohire.example/gh');
    vi.stubEnv('GOHIRE_API_KEY', 'rh_key');
    vi.stubEnv('RA_CROSSBANK_CROSS_TENANT_CONFIRMED', 'true');
    vi.stubEnv('GOHIRE_BANK_TRANSPORT', '');
    vi.stubEnv('GOHIRE_SYNDICATION_URL', '');
    expect(isBankEnabled('gohire')).toBe(true);
    expect(getBankClient('gohire')).toBeNull();
    const adapter = createBankAdapter('gohire');
    expect(adapter.isEnabled()).toBe(true);
    expect(adapter.transport?.()).toBe('api');
    expect(adapter.disabledReason?.()).toBeNull();
    vi.stubEnv('GOHIRE_SYNDICATION_URL', 'https://api.gohire.top/api/v1/syndication/jobs');
    expect(adapter.transport?.()).toBe('syndication');
    bankClientTest.resetCache();
    vi.unstubAllEnvs();
  });

  it('warns once (without the URL) when a configured GoHire URL is rejected for missing TLS', () => {
    bankClientTest.resetCache();
    const warn = vi.mocked(logger.warn);
    warn.mockClear();
    vi.stubEnv('DATABASE_URL_GOHIRE', 'postgresql://u:secret@db.gohire.example/gh?sslmode=disable');
    vi.stubEnv('RA_CROSSBANK_CROSS_TENANT_CONFIRMED', 'true');
    vi.stubEnv('GOHIRE_API_KEY', '');
    expect(isBankEnabled('gohire')).toBe(false);
    expect(getBankClient('gohire')).toBeNull();
    expect(isBankEnabled('gohire')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatch(/does not require TLS/);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('secret');
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('db.gohire.example');
    bankClientTest.resetCache();
    vi.unstubAllEnvs();
  });

  it('maps banks to markets both ways', () => {
    expect(bankMarket('gohire')).toBe('cn');
    expect(bankMarket('robohire')).toBe('intl');
    expect(bankForMarket('cn')).toBe('gohire');
    expect(bankForMarket('intl')).toBe('robohire');
  });
});

describe('providers per brand and the source registry', () => {
  afterEach(() => {
    resetSourceAdaptersForTests();
    resetBuiltinAdaptersForTests();
    resetJobSourceWarningsForTests();
  });

  const ats = (): JobSourceAdapter => ({
    provider: 'ats_public',
    kind: 'cursor',
    markets: ['intl', 'cn'],
    sourceBoards: ['greenhouse', 'lever'],
    isEnabled: () => true,
    transport: () => 'board_api',
    supportsCountry: () => false,
    dailyCallLimit: () => null,
    fetch: async () => ({ jobs: [], calls: 0 }),
  });

  it('RoboApply runs activejobs → bank_robohire → jsearch (no linkedin); GoApply the GoHire bank; CN_EXTERNAL_PROVIDERS is ignored with one warning', () => {
    const warn = vi.mocked(logger.warn);
    warn.mockClear();
    expect(ingestProvidersForBrand(getBrand('roboapply'), {})).toEqual(['activejobs', 'bank_robohire', 'jsearch']);
    expect(ingestProvidersForBrand(getBrand('goapply'), {})).toEqual(['bank_gohire']);
    // Whatever CN_EXTERNAL_PROVIDERS says, JSearch is never a GoApply source.
    for (let i = 0; i < 3; i += 1) expect(ingestProvidersForBrand(getBrand('goapply'), { CN_EXTERNAL_PROVIDERS: 'jsearch,linkedin,boss' })).toEqual(['bank_gohire']);
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('CN_EXTERNAL_PROVIDERS'))).toHaveLength(1);
    expect(adaptersForBrand(getBrand('roboapply'), {}).map((a) => a.provider)).toEqual(['activejobs', 'bank_robohire', 'jsearch']);
    expect(adaptersForBrand(getBrand('goapply'), {}).map((a) => a.provider)).toEqual(['bank_gohire']);
    expect(getSourceAdapter('linkedin')).toBeNull();
  });

  it('the public boards join both brands through their market; a second adapter for a provider is refused', () => {
    const adapter = ats();
    registerSourceAdapter(adapter);
    registerSourceAdapter(adapter);
    expect(() => registerSourceAdapter({ ...adapter })).toThrow(/already registered/);
    expect(getSourceAdapter('ats_public')).toBe(adapter);
    expect(adaptersForBrand(getBrand('roboapply'), {}).map((a) => a.provider)).toEqual(['activejobs', 'bank_robohire', 'jsearch', 'ats_public']);
    // GoApply: the GoHire bank and the employer boards, and never jsearch whatever CN_EXTERNAL_PROVIDERS says.
    expect(adaptersForBrand(getBrand('goapply'), {}).map((a) => a.provider)).toEqual(['bank_gohire', 'ats_public']);
    expect(adaptersForBrand(getBrand('goapply'), { CN_EXTERNAL_PROVIDERS: 'jsearch' }).map((a) => a.provider)).toEqual(['bank_gohire', 'ats_public']);
  });

  it('no RapidAPI adapter serves market cn', () => {
    for (const id of ['jsearch', 'activejobs', 'linkedin'] as const) expect(createRapidApiAdapter(id).markets).toEqual(['intl']);
  });

  it('JOB_PROVIDERS_<BRAND> narrows a brand to a subset and never adds a source', () => {
    registerSourceAdapter(ats());
    const go = getBrand('goapply');
    const robo = getBrand('roboapply');
    expect(adaptersForBrand(go, { JOB_PROVIDERS_GOAPPLY: 'bank_gohire' }).map((a) => a.provider)).toEqual(['bank_gohire']);
    expect(adaptersForBrand(go, { JOB_PROVIDERS_GOAPPLY: 'ats_public' }).map((a) => a.provider)).toEqual(['ats_public']);
    // A name the brand does not have is ignored: JSearch cannot be added to GoApply this way.
    expect(adaptersForBrand(go, { JOB_PROVIDERS_GOAPPLY: 'jsearch, bank_gohire' }).map((a) => a.provider)).toEqual(['bank_gohire']);
    expect(adaptersForBrand(go, { JOB_PROVIDERS_GOAPPLY: 'jsearch' })).toEqual([]);
    expect(adaptersForBrand(go, { JOB_PROVIDERS_GOAPPLY: '  ' }).map((a) => a.provider)).toEqual(['bank_gohire', 'ats_public']);
    // One brand's variable does not touch the other; the registry order is kept.
    expect(adaptersForBrand(robo, { JOB_PROVIDERS_GOAPPLY: 'bank_gohire' }).map((a) => a.provider)).toEqual(['activejobs', 'bank_robohire', 'jsearch', 'ats_public']);
    expect(adaptersForBrand(robo, { JOB_PROVIDERS_ROBOAPPLY: 'jsearch,activejobs' }).map((a) => a.provider)).toEqual(['activejobs', 'jsearch']);
  });

  it('jobSourcesForBrand describes each source: kind, market, transport and whether it is on', () => {
    registerSourceAdapter(ats());
    const go = sourcesForBrand(getBrand('goapply'), {});
    expect(go.map((s) => [s.provider, s.kind, s.market])).toEqual([
      ['bank_gohire', 'bank', 'cn'],
      ['ats_public', 'ats', 'cn'],
      ['user_import', 'import', 'cn'],
    ]);
    expect(go.find((s) => s.provider === 'ats_public')!.status()).toEqual({ enabled: true, transport: 'board_api', reason: null });
    expect(go.find((s) => s.provider === 'user_import')!.adapter).toBeNull();
    const robo = sourcesForBrand(getBrand('roboapply'), {});
    expect(robo.map((s) => s.provider)).toEqual(['activejobs', 'bank_robohire', 'jsearch', 'ats_public', 'user_import']);
    expect(robo.map((s) => s.kind)).toEqual(['search', 'bank', 'search', 'ats', 'import']);
    // Without the built-in adapters registered a source reads as not registered, never as on.
    resetSourceAdaptersForTests();
    resetBuiltinAdaptersForTests();
    expect(jobSourcesForBrand(getBrand('goapply'), {})[0]!.status()).toEqual({ enabled: false, transport: 'off', reason: 'not_registered' });
  });
});
