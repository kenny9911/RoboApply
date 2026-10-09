// @vitest-environment node
// WP-16b: source adapters — RapidAPI params (Taiwan → country=tw, the seam
// WP-42 asserts), provider-stated extras, the bank cursor sync, the bank
// employer-signal adapter, the GoHire TLS rule (CN-E-05) and the registry.
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
import { __test as bankClientTest, bankForMarket, bankMarket, bankTlsSatisfied, getBankClient, isBankEnabled } from '../../../../roboapply/v2/lib/raBankClients.js';
import { normalizeFantasticJob } from '../../../../roboapply/v2/lib/raFantasticJobs.js';
import { normalizeJSearchJob } from '../../../../roboapply/v2/lib/raRapidApiJobs.js';
import { getBrand } from '../../../../platform/brand/index.js';
import { getSourceAdapter, registerSourceAdapter, resetSourceAdaptersForTests } from '../../sources/index.js';
import type { JobSourceAdapter } from '../../sources/index.js';
import { adaptersForBrand, ingestProvidersForBrand, resetBuiltinAdaptersForTests } from '../providers.js';
import {
  BANK_SYNC_SELECT,
  bankCursorWhere,
  createBankAdapter,
  formatBankCursor,
  inputFromBankSyncRow,
  isSyncableBankJob,
  parseBankCursor,
  readBankEmployerSignals,
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

  it('company facts from the bank carry the bank as their source', () => {
    const input = inputFromBankSyncRow(
      'robohire',
      { id: 'r1', status: 'open', publishedAt: NOW, updatedAt: NOW, title: 'QA', companyName: 'Acme', company: { name: 'Acme', size: '51-200', industry: 'Software' } },
      NOW,
    )!;
    expect(input.companyFacts).toMatchObject({ source: 'bank:robohire', industries: ['Software'], size: '51-200' });
    expect(input.applyUrl).toMatch(/\/jobs\/r1$/);
    const noFacts = inputFromBankSyncRow('robohire', { id: 'r2', status: 'open', publishedAt: NOW, updatedAt: NOW, title: 'QA', companyName: 'Acme' }, NOW)!;
    expect(noFacts.companyFacts).toBeUndefined();
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

  it('a GoHire URL without TLS disables the bank', () => {
    vi.stubEnv('DATABASE_URL_GOHIRE', 'postgresql://u:p@db.gohire.example/gh');
    vi.stubEnv('RA_CROSSBANK_CROSS_TENANT_CONFIRMED', 'true');
    expect(isBankEnabled('gohire')).toBe(false);
    vi.stubEnv('DATABASE_URL_GOHIRE', 'postgresql://u:p@db.gohire.example/gh?sslmode=require');
    expect(isBankEnabled('gohire')).toBe(true);
    vi.stubEnv('RA_CROSSBANK_GOHIRE_DISABLED', 'true');
    expect(isBankEnabled('gohire')).toBe(false);
    bankClientTest.resetCache();
    vi.unstubAllEnvs();
  });

  it('warns once (without the URL) when a configured GoHire URL is rejected for missing TLS', () => {
    bankClientTest.resetCache();
    const warn = vi.mocked(logger.warn);
    warn.mockClear();
    vi.stubEnv('DATABASE_URL_GOHIRE', 'postgresql://u:secret@db.gohire.example/gh?sslmode=disable');
    vi.stubEnv('RA_CROSSBANK_CROSS_TENANT_CONFIRMED', 'true');
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

describe('providers per brand and the adapter registry', () => {
  afterEach(() => {
    resetSourceAdaptersForTests();
    resetBuiltinAdaptersForTests();
  });

  it('RoboApply runs activejobs → bank_robohire → linkedin → jsearch; GoApply only the GoHire bank unless CN_EXTERNAL_PROVIDERS', () => {
    expect(ingestProvidersForBrand(getBrand('roboapply'), {})).toEqual(['activejobs', 'bank_robohire', 'linkedin', 'jsearch']);
    expect(ingestProvidersForBrand(getBrand('goapply'), {})).toEqual(['bank_gohire']);
    expect(ingestProvidersForBrand(getBrand('goapply'), { CN_EXTERNAL_PROVIDERS: 'jsearch,linkedin,boss' })).toEqual(['bank_gohire', 'jsearch']);
    expect(adaptersForBrand(getBrand('roboapply'), {}).map((a) => a.provider)).toEqual(['activejobs', 'bank_robohire', 'linkedin', 'jsearch']);
    expect(adaptersForBrand(getBrand('goapply'), {}).map((a) => a.provider)).toEqual(['bank_gohire']);
  });

  it('WP-42 can register ats_public for a market; a second adapter for a provider is refused', () => {
    const ats: JobSourceAdapter = {
      provider: 'ats_public',
      kind: 'search',
      markets: ['intl'],
      sourceBoards: ['greenhouse', 'lever'],
      isEnabled: () => true,
      supportsCountry: () => true,
      dailyCallLimit: () => null,
      fetch: async () => ({ jobs: [], calls: 0 }),
    };
    registerSourceAdapter(ats);
    registerSourceAdapter(ats);
    expect(() => registerSourceAdapter({ ...ats })).toThrow(/already registered/);
    expect(getSourceAdapter('ats_public')).toBe(ats);
    expect(adaptersForBrand(getBrand('roboapply'), {}).map((a) => a.provider)).toEqual(['activejobs', 'bank_robohire', 'linkedin', 'jsearch', 'ats_public']);
    expect(adaptersForBrand(getBrand('goapply'), {}).map((a) => a.provider)).toEqual(['bank_gohire']);
  });
});
