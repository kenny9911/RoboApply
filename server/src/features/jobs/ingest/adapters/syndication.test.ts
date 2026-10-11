// @vitest-environment node
// MKT-5E: the GoHire bank over the syndication endpoint (MARKET_STRATEGY §1.4 tier 1,
// §8 "GoHire bank transport"; requirements JC-2 and JC-3).
//
//   1. the wire contract: a job is exactly the BANK_SYNC_SELECT columns plus four fields,
//      every unknown key is stripped, a page that does not fit is ONE error that never
//      quotes the payload, and a validated job maps like a database row;
//   2. the HTTP reader: the request it makes, the answers it refuses (status, redirect,
//      size, shape, a cursor that goes back or stands still), and what it never says;
//   3. the acceptance of JC-2 against an in-process stub server (node:http on 127.0.0.1),
//      through the real ingest pipeline: a cursor sync over two pages writes the rows into
//      market cn and a tombstone archives a stored row as bank_closed;
//   4. the owner's probe script (scripts/gohire-syndication-probe.mjs): its small copy of
//      the contract agrees with the schema field by field and case by case, and it prints
//      counts and the cursor only.
//
// No test reaches the network: the endpoint is an injected fetch or a server on a loopback
// port of this process. Every fixture is SYNTHETIC (no real posting, employer or person).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/prisma.js', () => ({
  default: {},
  prisma: {},
  createPrismaClientForUrl: vi.fn(() => ({ job: { findMany: vi.fn() } })),
  activeRuntimeUrl: () => 'postgresql://active.example/db',
  cleanConnectionString: (u: string | undefined) => u,
}));
vi.mock('../../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// The market hooks are another area's rules (contact strip, fraud flags): the rows pass through unchanged here.
vi.mock('../../marketHooks.js', async (orig) => {
  const real = await orig<typeof import('../../marketHooks.js')>();
  return { ...real, afterNormalize: async (job: Record<string, unknown>) => job };
});

// @ts-expect-error: a plain .mjs script, no type declarations
import * as probe from '../../../../../../scripts/gohire-syndication-probe.mjs';
import { isDirectFromEmployer } from '../../../cn/jobs/card.js';
import { __test as bankClientTest, getBankClient } from '../../../../roboapply/v2/lib/raBankClients.js';
import { resetBankPublicJobUrlWarningsForTests } from '../../../../roboapply/v2/lib/raCrossBankMatch.js';
import { logger } from '../../../../services/LoggerService.js';
import { normalizeProviderJob } from '../../normalize/index.js';
import type { SourceFetchResult, SourceQuery } from '../../sources/index.js';
import { runIngestQuery, type LeasedQueryRow, type PipelineContext } from '../pipeline.js';
import { createIngestFake } from '../testkit.js';
import { REFRESH } from '../planner.js';
import { BANK_API_MIN_REQUEST_MS, BANK_RESYNC_DAYS, BANK_SYNC_SELECT, bankPageMark, createBankAdapter, inputFromBankSyncRow, isSyncableBankJob, parseBankCursor, type BankFetchLike, type BankSyncRow } from './bank.js';
import {
  SYNDICATION_EXTRA_JOB_FIELDS,
  SYNDICATION_FIELDS,
  SYNDICATION_KEY_HEADER,
  SYNDICATION_MAX_BYTES,
  SYNDICATION_MAX_LIMIT,
  SYNDICATION_TIMEOUT_MS,
  SyndicatedJobSchema,
  SyndicationError,
  createSyndicationReader,
  fetchSyndicationPage,
  formatSyndicationProblems,
  parseSyndicationCursor,
  parseSyndicationPage,
  readIsoTime,
  syndicationStatusReason,
  syndicationUrlProblem,
  toBankSyncRow,
  toCursorPage,
  type SyndicationPage,
  type SyndicationProblem,
} from './syndication.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const KEY = 'syn_scoped_key_NEVER_LOGGED';
const TEMPLATE = 'https://example.test/p/{id}';
const MARK = bankPageMark(TEMPLATE);
/** A stored cursor as the sync writes it: the position, the posting-page mark, and when its pass began. */
const stored = (position: string, passStart: Date = NOW): string => `${position}|${MARK}|${passStart.toISOString()}`;

/** SYNTHETIC. A job as the endpoint sends it: every field of the contract, and recruiter-internal fields the schema must strip. */
function wireJob(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: 'open',
    publishedAt: '2026-10-01T09:00:00+08:00',
    updatedAt: '2026-10-05T09:00:00+08:00',
    title: '后端开发工程师',
    description: '负责后端服务开发。',
    qualifications: '三年以上后端经验。',
    hardRequirements: '熟悉 Go。',
    niceToHave: '了解 Kubernetes。',
    benefits: '五险一金。',
    location: '深圳',
    locations: [{ city: '深圳', country: 'CN', geoInternal: 'LOCATION-SECRET' }],
    workType: 'onsite',
    employmentType: 'full_time',
    experienceLevel: 'mid',
    education: '本科',
    headcount: 3,
    salaryMin: 15000,
    salaryMax: 25000,
    salaryCurrency: 'CNY',
    salaryPeriod: 'monthly',
    salaryText: '15-25K·14薪',
    companyName: '示例科技有限公司',
    requiredKeywordSet: ['go', 'postgresql'],
    company: { id: 'co1', name: '示例科技有限公司', logoUrl: null, website: 'https://example.cn', industry: '互联网', size: '51-200', headcount: 120, founded: 2015, internalNotes: 'COMPANY-NOTE-SECRET', ownerUserId: 'owner_SECRET' },
    employerVerified: false,
    syndicationConsentAt: null,
    validFrom: null,
    validUntil: null,
    // Recruiter-internal fields: whatever the server sends beyond the contract never passes.
    notes: 'INTERNAL-NOTE-SECRET',
    evaluationRules: 'EVAL-RULES-SECRET',
    passingScore: 60,
    aiInsights: { report: 'AI-INSIGHTS-SECRET' },
    clientKey: 'client-key-SECRET',
    organizationId: 'org_SECRET',
    userId: 'user_SECRET',
    hiringRequest: { id: 'hr_SECRET', title: 'HR-TITLE-SECRET' },
    ...over,
  };
}

const page = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ items: [], tombstones: [], nextCursor: null, hasMore: false, ...over });
const sorted = (problems: readonly SyndicationProblem[]) => [...problems].sort((a, b) => `${a.field}|${a.code}`.localeCompare(`${b.field}|${b.code}`));
const problemsOf = (raw: unknown): SyndicationProblem[] => {
  const parsed = parseSyndicationPage(raw);
  return parsed.ok ? [] : sorted(parsed.problems);
};
const okPage = (raw: unknown): SyndicationPage => {
  const parsed = parseSyndicationPage(raw);
  if (!parsed.ok) throw new Error(`fixture page is invalid: ${formatSyndicationProblems(parsed.problems)}`);
  return parsed.page;
};
/** Every argument of every logger call of the test so far, as one string. */
const logged = (): string => JSON.stringify(['info', 'warn', 'error', 'debug'].flatMap((level) => vi.mocked(logger[level as 'info']).mock.calls));

afterEach(() => {
  vi.unstubAllEnvs();
  resetBankPublicJobUrlWarningsForTests();
});

// ── 1. The wire contract ───────────────────────────────────────────────────

describe('the syndication wire contract', () => {
  it('a job is exactly the columns of BANK_SYNC_SELECT plus employerVerified, syndicationConsentAt, validFrom and validUntil', () => {
    expect([...SYNDICATION_FIELDS.job].sort()).toEqual([...Object.keys(BANK_SYNC_SELECT), ...SYNDICATION_EXTRA_JOB_FIELDS].sort());
    expect([...SYNDICATION_FIELDS.company].sort()).toEqual(Object.keys(BANK_SYNC_SELECT.company.select).sort());
    expect(SYNDICATION_FIELDS.page).toEqual(['items', 'tombstones', 'nextCursor', 'hasMore']);
    expect(SYNDICATION_FIELDS.tombstone).toEqual(['id', 'updatedAt', 'reason']);
    // The parity wave's two additions are among them, and nothing recruiter-internal is.
    expect(SYNDICATION_FIELDS.job).toEqual(expect.arrayContaining(['education', 'headcount']));
    for (const banned of ['notes', 'internalNotes', 'evaluationRules', 'interviewRequirements', 'userId', 'aiInsights', 'organizationId']) expect(SYNDICATION_FIELDS.job).not.toContain(banned);
  });

  it('a page with extra fields parses and they are gone from the result: notes on a job, on its company, on a tombstone and on the page', () => {
    const raw = page({
      items: [wireJob('s1')],
      tombstones: [{ id: 's0', updatedAt: '2026-10-04T00:00:00Z', reason: 'closed', closedBy: 'RECRUITER-SECRET' }],
      nextCursor: '2026-10-05T01:00:00.000Z|s1',
      debug: { sql: 'DEBUG-SECRET' },
      tenant: 'tenant_SECRET',
    });
    vi.clearAllMocks();
    const parsed = parseSyndicationPage(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Validation writes no log line at all, so no field of a response can reach one from here.
    expect(logged()).toBe('[]');
    expect(Object.keys(parsed.page).sort()).toEqual([...SYNDICATION_FIELDS.page].sort());
    expect(Object.keys(parsed.page.items[0]!).sort()).toEqual([...SYNDICATION_FIELDS.job].sort());
    expect(parsed.page.items[0]).not.toHaveProperty('notes');
    expect(Object.keys(parsed.page.items[0]!.company!).sort()).toEqual([...SYNDICATION_FIELDS.company].sort());
    expect(parsed.page.items[0]!.locations).toEqual([{ city: '深圳', country: 'CN' }]);
    expect(parsed.page.tombstones).toEqual([{ id: 's0', updatedAt: '2026-10-04T00:00:00Z', reason: 'closed' }]);
    expect(JSON.stringify(parsed)).not.toMatch(/SECRET/);
    // The row the rest of the pipeline sees holds no unknown key either.
    expect(JSON.stringify(toBankSyncRow(parsed.page.items[0]!))).not.toMatch(/SECRET/);
  });

  it.each([
    ['an empty page', page()],
    ['times with an offset, with Z, with seconds and fractions, and without seconds', page({ items: [wireJob('a', { publishedAt: '2026-10-01T09:00+08:00', updatedAt: '2026-10-05T01:00:00.123456Z', syndicationConsentAt: '2026-09-01T00:00:00+0800' })] })],
    ['a validity given as a calendar day', page({ items: [wireJob('a', { validFrom: '2026-10-01', validUntil: '2026-12-31' })] })],
    ['an unpublished job (publishedAt null) and a job with no title', page({ items: [wireJob('a', { publishedAt: null, title: null })] })],
    ['a job that sends only the keys that must be present', page({ items: [{ id: 'a', status: 'open', publishedAt: null, updatedAt: '2026-10-05T01:00:00Z', title: 'x', companyName: null, employerVerified: true, syndicationConsentAt: null, validFrom: null, validUntil: null }] })],
    ['a tombstone without a reason', page({ tombstones: [{ id: 't', updatedAt: '2026-10-05T01:00:00Z' }], nextCursor: '2026-10-05T01:00:00Z|t' })],
    ['free-form locations of another shape (dropped, never an error)', page({ items: [wireJob('a', { locations: ['深圳', 7, null] })] })],
  ])('accepts %s', (_name, raw) => {
    expect(problemsOf(raw)).toEqual([]);
  });

  it.each<[string, unknown, SyndicationProblem[]]>([
    ['a page missing items', { tombstones: [], nextCursor: null, hasMore: false }, [{ field: 'items', code: 'missing', count: 1 }]],
    ['a page missing everything', {}, [
      { field: 'hasMore', code: 'missing', count: 1 },
      { field: 'items', code: 'missing', count: 1 },
      { field: 'nextCursor', code: 'missing', count: 1 },
      { field: 'tombstones', code: 'missing', count: 1 },
    ]],
    ['the old assumed shape { data: [...] }', { data: [wireJob('a')] }, [
      { field: 'hasMore', code: 'missing', count: 1 },
      { field: 'items', code: 'missing', count: 1 },
      { field: 'nextCursor', code: 'missing', count: 1 },
      { field: 'tombstones', code: 'missing', count: 1 },
    ]],
    ['a body that is not an object', ['INTERNAL-NOTE-SECRET'], [{ field: '(page)', code: 'wrong_type', count: 1 }]],
    ['null', null, [{ field: '(page)', code: 'wrong_type', count: 1 }]],
    ['items that is not a list', page({ items: { a: 1 } }), [{ field: 'items', code: 'wrong_type', count: 1 }]],
    ['an entry that is not a job', page({ items: ['INTERNAL-NOTE-SECRET'] }), [{ field: 'items[]', code: 'wrong_type', count: 1 }]],
    ['an updatedAt that is not ISO 8601 (words)', page({ items: [wireJob('a', { updatedAt: 'yesterday' })] }), [{ field: 'items[].updatedAt', code: 'not_iso', count: 1 }]],
    ['an updatedAt that is not ISO 8601 (a local date format)', page({ items: [wireJob('a', { updatedAt: '10/05/2026 09:00' })] }), [{ field: 'items[].updatedAt', code: 'not_iso', count: 1 }]],
    ['an updatedAt that is not ISO 8601 (an impossible date)', page({ items: [wireJob('a', { updatedAt: '2026-13-40T00:00:00Z' })] }), [{ field: 'items[].updatedAt', code: 'not_iso', count: 1 }]],
    ['an updatedAt sent as epoch milliseconds', page({ items: [wireJob('a', { updatedAt: 1759626000000 })] }), [{ field: 'items[].updatedAt', code: 'wrong_type', count: 1 }]],
    ['an updatedAt that is only a day (a day is a validity, not a position)', page({ items: [wireJob('a', { updatedAt: '2026-10-05' })] }), [{ field: 'items[].updatedAt', code: 'not_iso', count: 1 }]],
    ['the same fault on three jobs is one problem, counted', page({ items: [wireJob('a', { updatedAt: 'x' }), wireJob('b', { updatedAt: 'y' }), wireJob('c', { updatedAt: 'z' })] }), [{ field: 'items[].updatedAt', code: 'not_iso', count: 3 }]],
    ['a job without employerVerified', page({ items: [(({ employerVerified: _drop, ...rest }) => rest)(wireJob('a'))] }), [{ field: 'items[].employerVerified', code: 'missing', count: 1 }]],
    ['employerVerified as text', page({ items: [wireJob('a', { employerVerified: 'true' })] }), [{ field: 'items[].employerVerified', code: 'wrong_type', count: 1 }]],
    ['a job without the validity keys', page({ items: [(({ validFrom: _a, validUntil: _b, ...rest }) => rest)(wireJob('a'))] }), [
      { field: 'items[].validFrom', code: 'missing', count: 1 },
      { field: 'items[].validUntil', code: 'missing', count: 1 },
    ]],
    ['a consent time that is not ISO', page({ items: [wireJob('a', { syndicationConsentAt: 'yes' })] }), [{ field: 'items[].syndicationConsentAt', code: 'not_iso', count: 1 }]],
    ['an id that holds the cursor separator', page({ items: [wireJob('a|b')] }), [{ field: 'items[].id', code: 'bad_id', count: 1 }]],
    ['a numeric id', page({ items: [wireJob('a', { id: 42 })] }), [{ field: 'items[].id', code: 'wrong_type', count: 1 }]],
    ['a headcount that is not a whole number', page({ items: [wireJob('a', { headcount: 2.5 })] }), [{ field: 'items[].headcount', code: 'wrong_type', count: 1 }]],
    ['keywords that are not strings', page({ items: [wireJob('a', { requiredKeywordSet: ['go', 7, null] })] }), [{ field: 'items[].requiredKeywordSet[]', code: 'wrong_type', count: 2 }]],
    ['a company that is not an object', page({ items: [wireJob('a', { company: 'INTERNAL-NOTE-SECRET' })] }), [{ field: 'items[].company', code: 'wrong_type', count: 1 }]],
    ['a company founded year sent as text', page({ items: [wireJob('a', { company: { name: 'x', founded: '2015' } })] }), [{ field: 'items[].company.founded', code: 'wrong_type', count: 1 }]],
    ['a tombstone without updatedAt', page({ tombstones: [{ id: 't' }] }), [{ field: 'tombstones[].updatedAt', code: 'missing', count: 1 }]],
    ['a cursor that is an opaque token', page({ nextCursor: 'eyJwYWdlIjoyfQ==' }), [{ field: 'nextCursor', code: 'not_cursor', count: 1 }]],
    ['hasMore as text', page({ hasMore: 'false' }), [{ field: 'hasMore', code: 'wrong_type', count: 1 }]],
  ])('rejects %s', (_name, raw, expected) => {
    expect(problemsOf(raw)).toEqual(sorted(expected));
  });

  it('one bad job rejects the whole page: nothing of it is returned (never a partial page)', () => {
    const parsed = parseSyndicationPage(page({ items: [wireJob('good1'), wireJob('bad', { updatedAt: 'not a time' }), wireJob('good2')] }));
    expect(parsed).toEqual({ ok: false, problems: [{ field: 'items[].updatedAt', code: 'not_iso', count: 1 }] });
    expect(parsed).not.toHaveProperty('page');
  });

  it('a problem names the schema field and a code, never a key or a value of the payload', () => {
    const raw = {
      items: [
        wireJob('PAYLOAD-ID-SECRET | with a bar', {
          updatedAt: 'PAYLOAD-TIME-SECRET',
          title: { text: 'PAYLOAD-TITLE-SECRET' },
          companyName: ['PAYLOAD-COMPANY-SECRET'],
          employerVerified: 'PAYLOAD-FLAG-SECRET',
          validUntil: 'PAYLOAD-VALIDITY-SECRET',
          'PAYLOAD-KEY-SECRET': 1,
        }),
      ],
      tombstones: 'PAYLOAD-TOMBSTONES-SECRET',
      nextCursor: 'PAYLOAD-CURSOR-SECRET',
      hasMore: 'PAYLOAD-MORE-SECRET',
      'PAYLOAD-TOP-KEY-SECRET': true,
    };
    const parsed = parseSyndicationPage(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const text = `${JSON.stringify(parsed)} ${formatSyndicationProblems(parsed.problems, 99)}`;
    expect(text).not.toMatch(/PAYLOAD|SECRET/);
    expect(sorted(parsed.problems).map((p) => `${p.field}: ${p.code}`)).toEqual([
      'hasMore: wrong_type',
      'items[].companyName: wrong_type',
      'items[].employerVerified: wrong_type',
      'items[].id: bad_id',
      'items[].title: wrong_type',
      'items[].updatedAt: not_iso',
      'items[].validUntil: not_iso',
      'nextCursor: not_cursor',
      'tombstones: wrong_type',
    ]);
    // The short form used in an error result lists a few and counts the rest.
    expect(formatSyndicationProblems(parsed.problems, 2)).toMatch(/^[^;]+; [^;]+; \+7 more$/);
  });

  it('reads ISO 8601 only; a time without a zone is UTC+8, and a calendar day only where a validity allows it', () => {
    expect(readIsoTime('2026-10-05T09:00:00+08:00')).toEqual({ at: new Date('2026-10-05T01:00:00.000Z'), zoned: true, dayOnly: false });
    expect(readIsoTime('2026-10-05T01:00:00.000Z')).toMatchObject({ at: new Date('2026-10-05T01:00:00.000Z'), zoned: true });
    expect(readIsoTime('2026-10-05T01:00:00.123456789Z')!.at.toISOString()).toBe('2026-10-05T01:00:00.123Z');
    expect(readIsoTime('2026-10-05T09:00:00+0800')!.at.toISOString()).toBe('2026-10-05T01:00:00.000Z');
    // No zone: the mainland wall clock.
    expect(readIsoTime('2026-10-05T09:00:00')).toEqual({ at: new Date('2026-10-05T01:00:00.000Z'), zoned: false, dayOnly: false });
    expect(readIsoTime('2026-10-05')).toBeNull();
    expect(readIsoTime('2026-10-05', { allowDay: true })).toEqual({ at: new Date('2026-10-04T16:00:00.000Z'), zoned: false, dayOnly: true });
    for (const bad of ['yesterday', '10/05/2026', '2026-10-05 09:00:00', '2026-02-30T00:00:00Z', '2026-10-05T25:00:00Z', '2026-10-05T24:00:00Z', '2026-10-05T09:60:00Z', '2026-10-05T09:00:60Z', 'October 5, 2026', '', '1759626000000']) {
      expect(readIsoTime(bad), bad).toBeNull();
    }
    expect(readIsoTime('2026-02-30', { allowDay: true })).toBeNull();
    expect(readIsoTime('2028-02-29', { allowDay: true })).not.toBeNull();
    for (const bad of [null, undefined, 1759626000000, new Date(), {}]) expect(readIsoTime(bad)).toBeNull();
    expect(parseSyndicationCursor('2026-10-05T09:00:00+08:00|job_1')).toEqual({ updatedAt: new Date('2026-10-05T01:00:00.000Z'), id: 'job_1' });
    for (const bad of ['job_1', '|job_1', '2026-10-05T01:00:00Z|', 'yesterday|job_1', '2026-10-05T01:00:00Z|a|b', '2026-10-05T01:00:00Z|a b', null, 7]) expect(parseSyndicationCursor(bad)).toBeNull();
  });

  it('toBankSyncRow: an open published job is syncable and maps exactly like a database row with the same values', () => {
    const job = okPage(page({ items: [wireJob('s1')] })).items[0]!;
    const fromWire = toBankSyncRow(job);
    // The same job as the database transport reads it (BANK_SYNC_SELECT; times are Date objects there).
    const fromDatabase: BankSyncRow = {
      id: 's1',
      status: 'open',
      publishedAt: new Date('2026-10-01T01:00:00.000Z'),
      updatedAt: new Date('2026-10-05T01:00:00.000Z'),
      title: '后端开发工程师',
      description: '负责后端服务开发。',
      qualifications: '三年以上后端经验。',
      hardRequirements: '熟悉 Go。',
      niceToHave: '了解 Kubernetes。',
      benefits: '五险一金。',
      location: '深圳',
      locations: [{ city: '深圳', country: 'CN' }],
      workType: 'onsite',
      employmentType: 'full_time',
      experienceLevel: 'mid',
      education: '本科',
      headcount: 3,
      salaryMin: 15000,
      salaryMax: 25000,
      salaryCurrency: 'CNY',
      salaryPeriod: 'monthly',
      salaryText: '15-25K·14薪',
      companyName: '示例科技有限公司',
      requiredKeywordSet: ['go', 'postgresql'],
      company: { id: 'co1', name: '示例科技有限公司', logoUrl: null, website: 'https://example.cn', industry: '互联网', size: '51-200', headcount: 120, founded: 2015 },
    };
    expect(Object.keys(fromDatabase).sort()).toEqual(Object.keys(BANK_SYNC_SELECT).sort());
    expect(isSyncableBankJob(fromWire)).toBe(true);
    const options = { publicJobUrl: () => 'https://example.test/p/s1' };
    const wireInput = inputFromBankSyncRow('gohire', fromWire, NOW, options)!;
    const databaseInput = inputFromBankSyncRow('gohire', fromDatabase, NOW, options)!;
    expect(wireInput).not.toBeNull();
    expect(wireInput).toEqual(databaseInput);
    // And so the stored row is the same row.
    expect(normalizeProviderJob(wireInput, 'bank_gohire', { market: 'cn', now: NOW })).toEqual(normalizeProviderJob(databaseInput, 'bank_gohire', { market: 'cn', now: NOW }));
    // A draft or a closed job is not syncable through this path either.
    expect(isSyncableBankJob(toBankSyncRow(okPage(page({ items: [wireJob('s2', { publishedAt: null })] })).items[0]!))).toBe(false);
    expect(isSyncableBankJob(toBankSyncRow(okPage(page({ items: [wireJob('s3', { status: 'closed' })] })).items[0]!))).toBe(false);
  });

  it('toBankSyncRow: the bank states the employer signals and the validity; a day runs through its end in UTC+8, a time without a zone is UTC+8', () => {
    const row = (over: Record<string, unknown>) => toBankSyncRow(okPage(page({ items: [wireJob('s1', over)] })).items[0]!);
    expect(row({ employerVerified: true, syndicationConsentAt: '2026-09-01T08:00:00+08:00' })).toMatchObject({ employerVerified: true, syndicationConsentAt: new Date('2026-09-01T00:00:00.000Z') });
    expect(row({})).toMatchObject({ employerVerified: false, syndicationConsentAt: null, validFrom: null, validUntil: null });
    expect(row({ validUntil: '2026-12-31' }).validUntil).toEqual(new Date('2026-12-31T15:59:59.999Z'));
    expect(row({ validUntil: '2026-12-31T18:00:00' }).validUntil).toEqual(new Date('2026-12-31T10:00:00.000Z'));
    expect(row({ validUntil: '2026-12-31T18:00:00+08:00' }).validUntil).toEqual(new Date('2026-12-31T10:00:00.000Z'));
    expect(row({ validFrom: '2026-10-01' }).validFrom).toEqual(new Date('2026-09-30T16:00:00.000Z'));
    // Times of day without a zone are counted, so the operator sees that the endpoint does not send offsets.
    // A validity given as a calendar day has no zone by nature and is not counted.
    const parsed = parseSyndicationPage(page({ items: [wireJob('s1', { updatedAt: '2026-10-05T09:00:00', validFrom: '2026-10-01', validUntil: '2026-12-31' })], tombstones: [{ id: 't', updatedAt: '2026-10-05T09:00:00' }] }));
    expect(parsed).toMatchObject({ ok: true, timesWithoutZone: 2 });
    expect(parseSyndicationPage(page({ items: [wireJob('s1', { validUntil: '2026-12-31T18:00:00' })] }))).toMatchObject({ ok: true, timesWithoutZone: 1 });
  });

  it('the schema object is the one the document and the probe are checked against', () => {
    expect(Object.keys(SyndicatedJobSchema.shape)).toEqual(SYNDICATION_FIELDS.job);
  });
});

// ── The document for the second repository ────────────────────────────────

describe('docs/jobright-clone/market/GOHIRE_SYNDICATION.md', () => {
  const doc = readFileSync(fileURLToPath(new URL('../../../../../../docs/jobright-clone/market/GOHIRE_SYNDICATION.md', import.meta.url)), 'utf8');
  /** The rows of the field table under a heading: [field, the other cells…]. */
  const table = (heading: string): string[][] => {
    const start = doc.indexOf(`### ${heading}`);
    expect(start, heading).toBeGreaterThan(-1);
    const end = doc.indexOf('\n##', start + 4);
    return doc
      .slice(start, end === -1 ? undefined : end)
      .split('\n')
      .filter((line) => /^\| `[A-Za-z]+` \|/.test(line))
      .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, '')));
  };
  /** A page that fits, with one entry of every kind. */
  const base = () => ({
    items: [wireJob('a1')],
    tombstones: [{ id: 't1', updatedAt: '2026-10-07T00:00:00.000Z', reason: 'closed' }],
    nextCursor: '2026-10-07T00:00:00.000Z|t1',
    hasMore: false,
  });
  const missingWhenRemoved = (holder: (p: ReturnType<typeof base>) => Record<string, unknown>, field: string): boolean => {
    const raw = base();
    delete holder(raw)[field];
    return problemsOf(raw).some((p) => p.code === 'missing');
  };

  it('the document lists every field of the schema, no other, and says truthfully which keys must be present', () => {
    const parts = [
      ['4.1 The page', SYNDICATION_FIELDS.page, (p: ReturnType<typeof base>) => p as unknown as Record<string, unknown>],
      ['4.2 A job (`SyndicatedJob`)', SYNDICATION_FIELDS.job, (p: ReturnType<typeof base>) => p.items[0]!],
      ['4.4 A tombstone', SYNDICATION_FIELDS.tombstone, (p: ReturnType<typeof base>) => p.tombstones[0]! as Record<string, unknown>],
    ] as const;
    for (const [heading, fields, holder] of parts) {
      const rows = table(heading);
      expect(rows.map((r) => r[0]), heading).toEqual([...fields]);
      for (const [field, , mustBePresent] of rows) expect(mustBePresent === 'yes', `${heading}: ${field}`).toBe(missingWhenRemoved(holder, field!));
    }
    // The employer record: every key may be left out.
    const company = table('4.3 The employer (`company`)');
    expect(company.map((r) => r[0])).toEqual([...SYNDICATION_FIELDS.company]);
    for (const field of SYNDICATION_FIELDS.company) expect(missingWhenRemoved((p) => p.items[0]!.company as Record<string, unknown>, field), field).toBe(false);
    // The ten keys the document says decide a row.
    expect(table('4.2 A job (`SyndicatedJob`)').filter((r) => r[2] === 'yes').map((r) => r[0])).toEqual(['id', 'status', 'publishedAt', 'updatedAt', 'title', 'companyName', 'employerVerified', 'syndicationConsentAt', 'validFrom', 'validUntil']);
  });

  it('states the route, the header, the limits and the settings the code uses', () => {
    expect(doc).toContain('GET /api/v1/syndication/jobs');
    expect(doc).toContain(`\`${SYNDICATION_KEY_HEADER}: <service key>\``);
    expect(doc).toContain(`1 to ${SYNDICATION_MAX_LIMIT}`);
    expect(doc).toContain(`${SYNDICATION_MAX_BYTES / (1024 * 1024)} MB`);
    for (const name of ['GOHIRE_SYNDICATION_URL', 'GOHIRE_SYNDICATION_KEY', 'GOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'GOHIRE_BANK_TRANSPORT', 'INGEST_BANK_PAGE', 'INGEST_BANK_RESYNC_DAYS', 'cursor_regressed', 'cursor_stalled', 'page_over_limit', 'syndication_url_not_https']) expect(doc, name).toContain(name);
    // The interval of the whole re-read is the code's.
    expect(doc).toContain(`once every ${BANK_RESYNC_DAYS} days`);
    // No secret and no real address of a person or a database.
    expect(doc).not.toMatch(/sk_live|rh_[a-z0-9]{8,}|postgres(ql)?:\/\//);
  });

  it('states the cadence as built: due 30 minutes after a completed sync and 60 after an error, pages back to back, Retry-After not read (MKT-5E review)', () => {
    const minutes = (ms: number) => ms / 60_000;
    // The planner's own numbers (REFRESH), not a copy: the document fails this test when either changes.
    expect(doc).toContain(`due again **after ${minutes(REFRESH.bankSyncMs)} minutes**`);
    expect(doc).toContain(`due again **after ${minutes(REFRESH.errorRetryMs)} minutes**`);
    expect(doc).toContain(`asks again at its next sync, ${minutes(REFRESH.bankSyncMs)} minutes later`);
    expect(doc).toContain(`tried again **${minutes(REFRESH.errorRetryMs)} minutes later**`);
    expect([minutes(REFRESH.bankSyncMs), minutes(REFRESH.errorRetryMs)]).toEqual([30, 60]);
    // "Every 10 minutes" is how often the ingest job runs, never how often the bank is synced.
    expect(doc).toContain('ingest job runs every 10 minutes');
    expect(doc).not.toMatch(/syncs every 10 minutes|next sync \(every 10 minutes\)/);
    // What a rate limit on the key must allow for.
    expect(doc).toContain('**with no pause between pages**');
    expect(doc).toContain('**`Retry-After` is not read.**');
    expect(doc).not.toContain('60 requests a minute for the key is generous');
    // A shortened request that runs out of time is not an error; the limits named are the code's.
    expect(doc).toContain(`**Each request has ${SYNDICATION_TIMEOUT_MS / 1000} seconds**`);
    expect(doc).toContain(`never under ${BANK_API_MIN_REQUEST_MS / 1000} seconds`);
    // The owner's last step names every setting without which the bank stays off on the GoApply deployment.
    const step6 = doc.split('\n').find((line) => line.startsWith('6. Set '))!;
    for (const name of ['GOHIRE_SYNDICATION_URL', 'GOHIRE_SYNDICATION_KEY', 'GOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'RA_CROSSBANK_CROSS_TENANT_CONFIRMED=true']) expect(step6, name).toContain(name);
  });

  it('the example page of the document fits the schema, and is the synthetic fixture it says it is', () => {
    const blocks = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
    const example = JSON.parse(blocks.at(-1)!) as Record<string, unknown>;
    const parsed = parseSyndicationPage(example);
    expect(parsed).toMatchObject({ ok: true, timesWithoutZone: 0 });
    if (!parsed.ok) return;
    expect(parsed.page.items).toHaveLength(1);
    expect(parsed.page.tombstones).toHaveLength(1);
    // Every field of a job is shown, so the example can be copied as a fixture.
    expect(Object.keys((example.items as Array<Record<string, unknown>>)[0]!)).toEqual([...SYNDICATION_FIELDS.job]);
    expect(probe.summarizeSyndicationPage(example)).toMatchObject({ ok: true, counts: { items: 1, tombstones: 1, verified: 1, withConsent: 1, withValidity: 1, timesWithoutZone: 0 } });
    expect(toCursorPage(parsed.page, null)).toMatchObject({ rows: [{ id: 'clx0example0001', validUntil: new Date('2026-12-31T15:59:59.999Z') }], closedIds: ['clx0example0000'], more: false });
  });
});

// ── 2. The HTTP reader (injected fetch) ───────────────────────────────────

const URL_HTTPS = 'https://api.gohire.test/api/v1/syndication/jobs';
const CONFIG = { url: URL_HTTPS, key: KEY };

interface FetchCall {
  url: string;
  headers: Record<string, string> | undefined;
  redirect: string | undefined;
}

function fakeFetch(answer: (call: FetchCall, n: number) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }): { fetch: BankFetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: BankFetchLike = async (url, init) => {
    const call = { url, headers: init.headers, redirect: init.redirect };
    calls.push(call);
    const a = answer(call, calls.length);
    const status = a.status ?? 200;
    const text = a.text ?? JSON.stringify(a.body ?? page());
    const headers = a.headers ?? {};
    return { ok: status >= 200 && status < 300, status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, text: async () => text };
  };
  return { fetch, calls };
}

const bankQuery = (cursor?: string): SourceQuery => ({ id: 'q', provider: 'bank_gohire', market: 'cn', origin: 'bank_sync', params: { q: '', country: '*', datePosted: 'all', ...(cursor ? { cursor } : {}) } });
const ADAPTER_ENV = { GOHIRE_SYNDICATION_URL: URL_HTTPS, GOHIRE_SYNDICATION_KEY: KEY, GOHIRE_PUBLIC_JOB_URL_TEMPLATE: TEMPLATE };

describe('reading the syndication endpoint', () => {
  it('TLS only: https, or plain http on this machine; anything else is refused before a request', async () => {
    expect(syndicationUrlProblem('https://api.gohire.top/api/v1/syndication/jobs')).toBeNull();
    expect(syndicationUrlProblem('http://localhost:4610/s')).toBeNull();
    expect(syndicationUrlProblem('http://127.0.0.1:4610/s')).toBeNull();
    for (const bad of ['http://api.gohire.top/api/v1/syndication/jobs', 'http://10.0.0.5/s', 'http://localhost.evil.test/s', 'ftp://api.gohire.top/s', 'api.gohire.top/s', '']) {
      expect(syndicationUrlProblem(bad), bad).toBe('syndication_url_not_https');
    }
    const api = fakeFetch(() => ({}));
    await expect(fetchSyndicationPage({ url: 'http://api.gohire.top/s?token=URL-QUERY-SECRET', key: KEY }, null, 50, { fetch: api.fetch })).rejects.toThrow(new SyndicationError('syndication_url_not_https'));
    expect(api.calls).toEqual([]);
  });

  it('asks for the page after the cursor with the key in the X-API-Key header, follows no redirect, and never asks for more than 200 entries', async () => {
    const api = fakeFetch(() => ({ body: page({ items: [wireJob('s1')], nextCursor: '2026-10-05T01:00:00.000Z|s1' }) }));
    const read = createSyndicationReader(CONFIG, { fetch: api.fetch });
    await read('gohire', { updatedAt: new Date('2026-10-04T16:00:00.000Z'), id: 'j9' }, 1000);
    await read('gohire', null, 50);
    expect(api.calls.map((c) => c.url)).toEqual([`${URL_HTTPS}?cursor=2026-10-04T16%3A00%3A00.000Z%7Cj9&limit=${SYNDICATION_MAX_LIMIT}`, `${URL_HTTPS}?limit=50`]);
    expect(SYNDICATION_KEY_HEADER).toBe('X-API-Key');
    for (const call of api.calls) {
      expect(call.headers).toEqual({ Accept: 'application/json', 'X-API-Key': KEY });
      expect(call.redirect).toBe('error');
      // The key travels in the header only.
      expect(call.url).not.toContain(KEY);
    }
    // A query the operator put on the URL is kept; ours are added to it.
    await createSyndicationReader({ url: `${URL_HTTPS}?tenant=gohire`, key: KEY }, { fetch: api.fetch })('gohire', null, 10);
    expect(api.calls[2]!.url).toBe(`${URL_HTTPS}?tenant=gohire&limit=10`);
  });

  it.each([
    [401, 'http_401 key_refused'],
    [403, 'http_403 key_lacks_scope'],
    [404, 'http_404 route_not_found'],
    [429, 'http_429 rate_limited'],
    [500, 'http_500 server_error'],
    [503, 'http_503 server_error'],
    [418, 'http_418 unexpected_status'],
    [302, 'redirect'],
  ])('HTTP %i is the error "%s": the status and a short reason, never the body, the key or the URL', async (status, code) => {
    const api = fakeFetch(() => ({ status, text: JSON.stringify({ code: 'E_UPSTREAM', message: 'UPSTREAM-BODY-SECRET', echo: KEY }) }));
    const adapter = createBankAdapter('gohire', { env: { ...ADAPTER_ENV, GOHIRE_SYNDICATION_URL: `${URL_HTTPS}?token=URL-QUERY-SECRET` }, fetch: api.fetch });
    const out = await adapter.fetch(bankQuery(stored('2026-10-04T16:00:00.000Z|j9')), { now: NOW });
    expect(out).toEqual({ jobs: [], calls: 1, error: `GoHire bank read failed: ${code}` });
    expect(JSON.stringify(out)).not.toMatch(/SECRET|syn_scoped|gohire\.test/);
    expect(syndicationStatusReason(status)).toBe(status === 302 ? 'unexpected_status' : code.split(' ')[1]);
  });

  it('a body that is not JSON, a timeout and a network failure are short codes; the runtime message (it can quote the URL) is never passed on', async () => {
    const adapter = (fetch: BankFetchLike) => createBankAdapter('gohire', { env: ADAPTER_ENV, fetch, timeoutMs: 20 });
    const html = fakeFetch(() => ({ text: '<html>UPSTREAM-BODY-SECRET</html>' }));
    expect((await adapter(html.fetch).fetch(bankQuery(), { now: NOW })).error).toBe('GoHire bank read failed: not_json');
    const stalled: BankFetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error(`aborted ${URL_HTTPS}?key=${KEY}`))));
    expect((await adapter(stalled).fetch(bankQuery(), { now: NOW })).error).toBe('GoHire bank read failed: timeout');
    const refused: BankFetchLike = async () => {
      throw new Error(`connect ECONNREFUSED ${URL_HTTPS}?key=${KEY}`);
    };
    expect((await adapter(refused).fetch(bankQuery(), { now: NOW })).error).toBe('GoHire bank read failed: network');
    // Node's fetch reports a redirect under `redirect: 'error'` as a failure with this cause.
    const redirected: BankFetchLike = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
    };
    expect((await adapter(redirected).fetch(bankQuery(), { now: NOW })).error).toBe('GoHire bank read failed: redirect');
  });

  it('a request ends inside what the ingest tick can still give (never under 2 s, never over its own 20 s); running out of a shortened limit is a sync cut short, running out of the full 20 s is an error', async () => {
    vi.useFakeTimers();
    try {
      const stalled: BankFetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error(`aborted ${URL_HTTPS}?key=${KEY}`))));
      const adapter = createBankAdapter('gohire', { env: ADAPTER_ENV, fetch: stalled });
      const cursor = stored('2026-10-04T16:00:00.000Z|j9');
      /** The fetch result once `waitMs` have passed, or null while the request is still running. */
      const settledAfter = async (budgetMs: number | undefined, waitMs: number, query: SourceQuery = bankQuery(cursor)): Promise<SourceFetchResult | null> => {
        let result: SourceFetchResult | undefined;
        void adapter.fetch(query, { now: NOW, ...(budgetMs === undefined ? {} : { budgetMs }) }).then((out) => (result = out));
        await vi.advanceTimersByTimeAsync(waitMs);
        const seen = result ?? null;
        await vi.advanceTimersByTimeAsync(60_000);
        return seen;
      };
      // Nothing was read: no rows, no closure, no listing, no error. The stored cursor is handed back as it is and the sync says it has more.
      const cutShort = { jobs: [], calls: 1, cursor, exhausted: false, notes: { bank_pass_cut_short: 1 } };
      // A nearly spent tick: the floor, so the attempt is a real one.
      expect(await settledAfter(30, 1_999)).toBeNull();
      expect(await settledAfter(30, 2_000)).toEqual(cutShort);
      expect(await settledAfter(0, 2_000)).toEqual(cutShort);
      // A tick with 5 s left gives the request 5 s.
      expect(await settledAfter(5_000, 4_999)).toBeNull();
      expect(await settledAfter(5_000, 5_000)).toEqual(cutShort);
      // One millisecond under the full limit is still a shortened one.
      expect(await settledAfter(19_999, 19_999)).toEqual(cutShort);
      // A first sync (no stored cursor) cut short stores none.
      expect(await settledAfter(5_000, 5_000, bankQuery())).toEqual({ ...cutShort, cursor: null });
      // The request's own 20 s, with or without a limit from the caller: an endpoint that does not answer in it is failing.
      const failed = { jobs: [], calls: 1, error: 'GoHire bank read failed: timeout' };
      expect(await settledAfter(undefined, 19_999)).toBeNull();
      expect(await settledAfter(undefined, 20_000)).toEqual(failed);
      expect(await settledAfter(20_000, 20_000)).toEqual(failed);
      expect(await settledAfter(96_000, 20_000)).toEqual(failed);
    } finally {
      vi.useRealTimers();
    }
  });

  it('only a timeout is ever "cut short": any other failure of a shortened request is the error it is', async () => {
    const short = { now: NOW, budgetMs: 3_000 };
    const refused: BankFetchLike = async () => {
      throw new Error(`connect ECONNREFUSED ${URL_HTTPS}`);
    };
    expect(await createBankAdapter('gohire', { env: ADAPTER_ENV, fetch: refused }).fetch(bankQuery(), short)).toEqual({ jobs: [], calls: 1, error: 'GoHire bank read failed: network' });
    const limited = fakeFetch(() => ({ status: 429 }));
    expect(await createBankAdapter('gohire', { env: ADAPTER_ENV, fetch: limited.fetch }).fetch(bankQuery(), short)).toEqual({ jobs: [], calls: 1, error: 'GoHire bank read failed: http_429 rate_limited' });
    // A shortened request that is answered in time is an ordinary page.
    const answered = fakeFetch(() => ({ body: page({ items: [wireJob('s1')], nextCursor: '2026-10-05T01:00:00.000Z|s1' }) }));
    const ok = await createBankAdapter('gohire', { env: ADAPTER_ENV, fetch: answered.fetch }).fetch(bankQuery(), short);
    expect(ok.error).toBeUndefined();
    expect(ok.jobs.map((j) => j.externalId)).toEqual(['s1']);
    expect(ok.notes).toEqual({ bank_synced: 1 });
  });

  it('a response over 5 MB is refused: by its declared length without reading it, or by the bytes read', async () => {
    expect(SYNDICATION_MAX_BYTES).toBe(5 * 1024 * 1024);
    const text = vi.fn(async () => '{}');
    const declared: BankFetchLike = async () => ({ ok: true, status: 200, headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(6 * 1024 * 1024) : null) }, text });
    await expect(fetchSyndicationPage(CONFIG, null, 50, { fetch: declared })).rejects.toThrow(new SyndicationError('response_too_large'));
    expect(text).not.toHaveBeenCalled();
    // No declared length: the text itself is measured (in bytes, not characters).
    const big = JSON.stringify(page({ items: [wireJob('s1', { description: '职'.repeat(2 * 1024 * 1024) })] }));
    expect(big.length).toBeLessThan(SYNDICATION_MAX_BYTES);
    expect(Buffer.byteLength(big)).toBeGreaterThan(SYNDICATION_MAX_BYTES);
    const out = await createBankAdapter('gohire', { env: ADAPTER_ENV, fetch: fakeFetch(() => ({ text: big })).fetch }).fetch(bankQuery(), { now: NOW });
    expect(out).toEqual({ jobs: [], calls: 1, error: 'GoHire bank read failed: response_too_large' });
    // A streamed body is cut at the cap and the rest is never read.
    let reads = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const streamed: BankFetchLike = async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return { done: false, value: chunk };
          },
          cancel: async () => {
            cancelled = true;
          },
        }),
      },
      text: async () => {
        throw new Error('the stream is read, not text()');
      },
    });
    await expect(fetchSyndicationPage(CONFIG, null, 50, { fetch: streamed })).rejects.toThrow(new SyndicationError('response_too_large'));
    expect(reads).toBe(6);
    expect(cancelled).toBe(true);
  });

  it('a page that does not fit the contract is one error result that writes nothing and quotes nothing', async () => {
    vi.clearAllMocks();
    for (const body of [{ data: [wireJob('s1')] }, page({ items: [wireJob('s1'), wireJob('s2', { updatedAt: 'INTERNAL-NOTE-SECRET' })] })]) {
      const out = await createBankAdapter('gohire', { env: ADAPTER_ENV, fetch: fakeFetch(() => ({ body })).fetch }).fetch(bankQuery(), { now: NOW });
      expect(out.jobs).toEqual([]);
      expect(out.closedExternalIds).toBeUndefined();
      expect(out.cursor).toBeUndefined();
      expect(out.error).toMatch(/^GoHire bank read failed: invalid_page \(/);
      expect(JSON.stringify(out)).not.toMatch(/SECRET|后端/);
    }
    // Nothing of a refused page, the key or the address was logged on the way.
    expect(logged()).not.toMatch(/SECRET|后端|syn_scoped|gohire\.test/);
    const missing = await createBankAdapter('gohire', { env: ADAPTER_ENV, fetch: fakeFetch(() => ({ body: { tombstones: [], nextCursor: null, hasMore: false } })).fetch }).fetch(bankQuery(), { now: NOW });
    expect(missing.error).toBe('GoHire bank read failed: invalid_page (items: missing)');
    const notIso = await createBankAdapter('gohire', { env: ADAPTER_ENV, fetch: fakeFetch(() => ({ body: page({ items: [wireJob('s1', { updatedAt: '05.10.2026' })] }) })).fetch }).fetch(bankQuery(), { now: NOW });
    expect(notIso.error).toBe('GoHire bank read failed: invalid_page (items[].updatedAt: not_iso)');
    // More entries than were asked for is a contract fault too.
    const over = fakeFetch(() => ({ body: page({ items: [wireJob('a'), wireJob('b')], tombstones: [{ id: 'c', updatedAt: '2026-10-05T01:00:00Z' }], nextCursor: '2026-10-05T01:00:00Z|c' }) }));
    await expect(fetchSyndicationPage(CONFIG, null, 2, { fetch: over.fetch })).rejects.toThrow(new SyndicationError('page_over_limit'));
  });

  it('the cursor is the page\'s own position: one that goes back is cursor_regressed, one that stands still with more to come is cursor_stalled', async () => {
    const sent = { updatedAt: new Date('2026-10-05T01:00:00.000Z'), id: 'j9' };
    const at = (nextCursor: string | null, over: Record<string, unknown> = {}) => okPage(page({ nextCursor, ...over }));
    // Forward, by time or by id at the same time.
    expect(toCursorPage(at('2026-10-06T00:00:00Z|a'), sent)).toMatchObject({ next: { updatedAt: new Date('2026-10-06T00:00:00.000Z'), id: 'a' }, more: false });
    expect(toCursorPage(at('2026-10-05T09:00:00+08:00|k1'), sent).next).toEqual({ updatedAt: new Date('2026-10-05T01:00:00.000Z'), id: 'k1' });
    // Back in time, or back by id at the same time: refused, whatever the page holds.
    expect(() => toCursorPage(at('2026-10-04T23:59:59Z|z'), sent)).toThrow(new SyndicationError('cursor_regressed'));
    expect(() => toCursorPage(at('2026-10-05T01:00:00Z|j8'), sent)).toThrow(new SyndicationError('cursor_regressed'));
    expect(() => toCursorPage(at('2026-10-05T01:00:00Z|a', { hasMore: true }), sent)).toThrow(new SyndicationError('cursor_regressed'));
    expect(() => toCursorPage(at('2026-10-04T23:59:59Z|z', { items: [wireJob('s1')] }), sent)).toThrow(new SyndicationError('cursor_regressed'));
    // The same position: fine when the endpoint has nothing more (an idle bank), a loop when it says it has.
    expect(toCursorPage(at('2026-10-05T01:00:00Z|j9'), sent)).toMatchObject({ next: sent, more: false });
    expect(() => toCursorPage(at('2026-10-05T01:00:00Z|j9', { hasMore: true }), sent)).toThrow(new SyndicationError('cursor_stalled'));
    expect(() => toCursorPage(at(null, { hasMore: true }), null)).toThrow(new SyndicationError('cursor_stalled'));
    // An empty page with no position keeps the one we sent; with none sent there is none to store.
    expect(toCursorPage(at(null), sent)).toMatchObject({ rows: [], closedIds: [], next: sent, more: false });
    expect(toCursorPage(at(null), null).next).toBeNull();
    // No position stated on a page with entries: the last entry is the position.
    expect(toCursorPage(at(null, { items: [wireJob('s1', { updatedAt: '2026-10-06T00:00:00Z' })], tombstones: [{ id: 't9', updatedAt: '2026-10-07T00:00:00Z' }] }), sent).next).toEqual({ updatedAt: new Date('2026-10-07T00:00:00.000Z'), id: 't9' });

    // Through the adapter: an error result, nothing written, the stored cursor untouched.
    for (const [nextCursor, hasMore, code] of [['2026-10-01T00:00:00Z|a', false, 'cursor_regressed'], ['2026-10-05T01:00:00Z|j9', true, 'cursor_stalled']] as const) {
      const api = fakeFetch(() => ({ body: page({ items: [wireJob('s1')], nextCursor, hasMore }) }));
      const out = await createBankAdapter('gohire', { env: ADAPTER_ENV, fetch: api.fetch }).fetch(bankQuery(stored('2026-10-05T01:00:00.000Z|j9')), { now: NOW });
      expect(out).toEqual({ jobs: [], calls: 1, error: `GoHire bank read failed: ${code}` });
    }
  });

  it('an id is one entry per page: sent as a job and as a tombstone, the later updatedAt decides and a tie closes it', () => {
    const both = (jobAt: string, stoneAt: string) =>
      toCursorPage(okPage(page({ items: [wireJob('x', { updatedAt: jobAt }), wireJob('y')], tombstones: [{ id: 'x', updatedAt: stoneAt }, { id: 'z', updatedAt: stoneAt }], nextCursor: '2026-10-09T00:00:00Z|z' })), null);
    // Closed after it was last published: the tombstone stands and the job is not emitted.
    expect(both('2026-10-06T00:00:00Z', '2026-10-07T00:00:00Z')).toMatchObject({ rows: [{ id: 'y' }], closedIds: ['x', 'z'] });
    // Published again after it closed: the job stands.
    const reopened = both('2026-10-08T00:00:00Z', '2026-10-07T00:00:00Z');
    expect(reopened.rows.map((r) => r.id)).toEqual(['x', 'y']);
    expect(reopened.closedIds).toEqual(['z']);
    // The same instant: closing is the safe side.
    expect(both('2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z')).toMatchObject({ rows: [{ id: 'y' }], closedIds: ['x', 'z'] });
  });

  it('times sent without a zone are counted in the run tally', async () => {
    const api = fakeFetch(() => ({ body: page({ items: [wireJob('s1', { updatedAt: '2026-10-05T09:00:00', publishedAt: '2026-10-01T09:00:00' })], nextCursor: '2026-10-05T01:00:00Z|s1' }) }));
    const out = await createBankAdapter('gohire', { env: ADAPTER_ENV, fetch: api.fetch }).fetch(bankQuery(), { now: NOW });
    expect(out.notes).toEqual({ bank_time_without_zone: 2, bank_synced: 1 });
    // Read as UTC+8: 09:00 on the mainland wall clock is 01:00 UTC.
    expect(parseBankCursor(out.cursor)).toEqual({ updatedAt: new Date('2026-10-05T01:00:00.000Z'), id: 's1' });
    expect(out.jobs[0]!.postedAt).toEqual(new Date('2026-10-01T01:00:00.000Z'));
  });
});

// ── 3. JC-2 against a stub server, through the ingest pipeline ────────────

interface StubRequest {
  path: string;
  search: URLSearchParams;
  key: string | undefined;
}

describe('a cursor sync against a stub syndication server (JC-2), through the ingest pipeline', () => {
  const requests: StubRequest[] = [];
  let respond: (req: StubRequest, res: http.ServerResponse) => void = (_req, res) => res.end();
  let server: http.Server;
  let endpoint = '';

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const key = req.headers['x-api-key'];
      const seen: StubRequest = { path: url.pathname, search: url.searchParams, key: Array.isArray(key) ? key[0] : key };
      requests.push(seen);
      res.on('error', () => undefined);
      respond(seen, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/syndication/jobs`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests.length = 0;
    vi.clearAllMocks();
    bankClientTest.resetCache();
    // The whole configuration of the transport: the URL, its key, the posting page. No database URL anywhere.
    vi.stubEnv('GOHIRE_SYNDICATION_URL', endpoint);
    vi.stubEnv('GOHIRE_SYNDICATION_KEY', KEY);
    vi.stubEnv('GOHIRE_API_KEY', '');
    vi.stubEnv('GOHIRE_BANK_TRANSPORT', '');
    vi.stubEnv('GOHIRE_PUBLIC_JOB_URL_TEMPLATE', TEMPLATE);
    vi.stubEnv('DATABASE_URL_GOHIRE', '');
    vi.stubEnv('DATABASE_URL_LIGHTARK', '');
    vi.stubEnv('RA_CROSSBANK_DISABLED', '');
    vi.stubEnv('RA_CROSSBANK_GOHIRE_DISABLED', '');
    vi.stubEnv('RA_CROSSBANK_CROSS_TENANT_CONFIRMED', 'true');
    vi.stubEnv('INGEST_BANK_PAGE', '');
  });

  const lease = (cursor?: string): LeasedQueryRow => ({
    id: 'q-bank-gohire',
    market: 'cn',
    provider: 'bank_gohire',
    params: { q: '', country: '*', datePosted: 'all', ...(cursor ? { cursor } : {}) },
    origin: 'bank_sync',
    demandScore: 0,
    priority: 50,
    consecutiveEmpty: 0,
  });
  const ctxFor = (db: PipelineContext['db']): PipelineContext => ({ db, brand: 'goapply', market: 'cn', now: NOW, enqueueMany: async (items) => ({ inserted: items.length }), publicDisplayProviders: [] });
  /** The cursor the run stored on its RAIngestQuery row (null: the run stored none). */
  const storedCursor = (fake: ReturnType<typeof createIngestFake>['fake']): string | null => {
    const finish = fake.$sql.calls.filter((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "lastRunAt"')).at(-1)!;
    const value = finish.values[6];
    return typeof value === 'string' ? value : null;
  };

  it('two pages are written into market cn with the bank\'s own signals, and a tombstone archives a stored row as bank_closed', async () => {
    const PAGE_1 = '2026-10-05T03:00:00.000Z|s4';
    const PAGE_2 = '2026-10-06T02:00:00.000Z|old1';
    respond = (req, res) => {
      if (req.key !== KEY) return json(res, 401, { code: 'unauthorized' });
      if (!req.search.get('cursor')) {
        return json(res, 200, {
          items: [
            // A verified employer that consented to syndication, with a stated validity.
            wireJob('s1', { updatedAt: '2026-10-05T08:00:00+08:00', employerVerified: true, syndicationConsentAt: '2026-09-01T10:00:00+08:00', validUntil: '2026-12-31' }),
            // Nothing recorded: a recruiter's posting for a named employer, for signed-in users only.
            wireJob('s2', { updatedAt: '2026-10-05T09:00:00+08:00', title: '软件测试工程师', companyName: '样例数据有限公司', company: null }),
            // Two recruiter test postings: an empty employer, and a title that names no job.
            wireJob('s3', { updatedAt: '2026-10-05T10:00:00+08:00', companyName: '', company: null }),
            wireJob('s4', { updatedAt: '2026-10-05T11:00:00+08:00', title: '测试岗位请勿投递' }),
          ],
          tombstones: [],
          nextCursor: PAGE_1,
          hasMore: true,
        });
      }
      if (req.search.get('cursor') === PAGE_1) {
        return json(res, 200, {
          items: [
            // Verified, but the employer named is a staffing firm: never 企业直招.
            wireJob('s5', { updatedAt: '2026-10-06T09:00:00+08:00', employerVerified: true, companyName: '样例人力资源服务有限公司', company: null }),
          ],
          tombstones: [{ id: 'old1', updatedAt: '2026-10-06T10:00:00+08:00', reason: 'closed' }],
          nextCursor: PAGE_2,
          hasMore: false,
        });
      }
      return json(res, 400, { code: 'unexpected_cursor' });
    };
    const { db, written, fake } = createIngestFake({
      seed: {
        rAJob: [
          { id: 'j-old1', sourceBoard: 'gohire', externalId: 'old1', market: 'cn', archivedAt: null, visibility: 'public' },
          { id: 'j-keep', sourceBoard: 'gohire', externalId: 'keep1', market: 'cn', archivedAt: null, visibility: 'public' },
        ],
      },
    });
    // The adapter as production builds it: its transport and its key come from the environment.
    const adapter = createBankAdapter('gohire');
    expect(adapter.transport?.()).toBe('syndication');
    expect(adapter.isEnabled()).toBe(true);

    const first = await runIngestQuery(ctxFor(db), adapter, lease());
    expect(first).toMatchObject({ status: 'ok', calls: 1, more: true, closed: 0 });
    expect(first.notes).toMatchObject({ bank_synced: 2, bank_no_company: 1, bank_test_posting: 1 });
    const cursor1 = storedCursor(fake);
    expect(cursor1).toBe(stored(PAGE_1));

    const second = await runIngestQuery(ctxFor(db), adapter, lease(cursor1!));
    expect(second).toMatchObject({ status: 'ok', calls: 1, more: false, closed: 1 });
    expect(second.notes).toMatchObject({ bank_synced: 1, bank_closed: 1 });
    expect(storedCursor(fake)).toBe(stored(PAGE_2));

    // What was asked: from the beginning, then after the first page's own position; the key in the header only.
    expect(requests.map((r) => [r.path, r.search.get('cursor'), r.search.get('limit'), r.key])).toEqual([
      ['/api/v1/syndication/jobs', null, '200', KEY],
      ['/api/v1/syndication/jobs', PAGE_1, '200', KEY],
    ]);

    // What was written: the three listable jobs, in GoApply's market, as GoHire bank rows that open GoHire's page.
    expect(written.map((r) => r.externalId)).toEqual(['s1', 's2', 's5']);
    for (const row of written) {
      expect(row).toMatchObject({ market: 'cn', sourceBoard: 'gohire', sourceName: 'GoHire', fromRecruiterBank: true, sourcePriority: 3, applyUrl: `https://example.test/p/${row.externalId}`, headcount: 3 });
    }
    const [s1, s2, s5] = written;
    // employerVerified true and not an agency (stated, so false and never null): the one row that may carry 企业直招.
    // Consent makes it publicly displayable; the validity is its deadline.
    expect(s1).toMatchObject({ employerVerified: true, isAgency: false, publicDisplay: true, expiresAt: new Date('2026-12-31T15:59:59.999Z') });
    expect(isDirectFromEmployer(s1 as never)).toBe(true);
    // Not verified: 代招, never 企业直招; no consent on record: signed-in users only; no validity: never closed by date.
    expect(s2).toMatchObject({ employerVerified: false, isAgency: true, publicDisplay: false, expiresAt: null, title: '软件测试工程师' });
    expect(isDirectFromEmployer(s2 as never)).toBe(false);
    // Verified, but the named employer is an agency: the unchanged rule still refuses 企业直招.
    expect(s5).toMatchObject({ employerVerified: true, isAgency: true, publicDisplay: false });
    expect(isDirectFromEmployer(s5 as never)).toBe(false);

    // The tombstone archived the stored row with the reason the upsert revives; the other stored row is untouched.
    const rows = fake.$rows('rAJob');
    expect(rows.find((r) => r.id === 'j-old1')).toMatchObject({ archivedAt: NOW, closedAt: NOW, closeReason: 'bank_closed' });
    expect(rows.find((r) => r.id === 'j-keep')).toMatchObject({ archivedAt: null });

    // Nothing recruiter-internal, no key and no endpoint address reached a row, a statement or a log line.
    const everything = `${JSON.stringify(written)} ${JSON.stringify(fake.$sql.calls)} ${JSON.stringify([first, second])} ${logged()}`;
    expect(everything).not.toMatch(/SECRET/);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(endpoint);
    expect(everything).not.toContain('127.0.0.1');
    // No database client of the bank was opened at any point.
    expect(getBankClient('gohire')).toBeNull();
  });

  it('a 401 is an error result: nothing is written, nothing is archived, the cursor stays, and the body is never repeated', async () => {
    respond = (_req, res) => json(res, 401, { code: 'invalid_key', message: 'UPSTREAM-BODY-SECRET', hint: KEY });
    const { db, written, fake } = createIngestFake({ seed: { rAJob: [{ id: 'j-keep', sourceBoard: 'gohire', externalId: 'keep1', market: 'cn', archivedAt: null, visibility: 'public' }] } });
    const result = await runIngestQuery(ctxFor(db), createBankAdapter('gohire'), lease(stored('2026-10-05T03:00:00.000Z|s4')));
    expect(result).toMatchObject({ status: 'error', calls: 1, error: 'GoHire bank read failed: http_401 key_refused' });
    expect(written).toEqual([]);
    expect(fake.$rows('rAJob').find((r) => r.id === 'j-keep')).toMatchObject({ archivedAt: null });
    expect(storedCursor(fake)).toBeNull();
    expect(requests).toHaveLength(1);
    expect(`${JSON.stringify(result)} ${JSON.stringify(fake.$sql.calls)} ${logged()}`).not.toMatch(/SECRET|syn_scoped|127\.0\.0\.1/);
  });

  it('a 6 MB body is refused while it is read: an error result, nothing written (streamed, and with a declared length)', async () => {
    const megabyte = 'x'.repeat(1024 * 1024);
    for (const declare of [false, true]) {
      respond = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', ...(declare ? { 'content-length': String(6 * 1024 * 1024 + 16) } : {}) });
        res.write('{"items":[],"pad":"');
        for (let i = 0; i < 6; i += 1) res.write(megabyte);
        res.end('"}');
      };
      const { db, written, fake } = createIngestFake();
      const result = await runIngestQuery(ctxFor(db), createBankAdapter('gohire'), lease());
      expect(result).toMatchObject({ status: 'error', error: 'GoHire bank read failed: response_too_large' });
      expect(written).toEqual([]);
      expect(storedCursor(fake)).toBeNull();
    }
  });

  it('a redirect is never followed: the key is not sent to the second address, and the run is an error', async () => {
    respond = (req, res) => {
      if (req.path === '/elsewhere') return json(res, 200, page({ items: [wireJob('s1')], nextCursor: '2026-10-05T01:00:00Z|s1' }));
      res.writeHead(302, { location: endpoint.replace('/api/v1/syndication/jobs', '/elsewhere') });
      res.end();
    };
    const { db, written } = createIngestFake();
    const result = await runIngestQuery(ctxFor(db), createBankAdapter('gohire'), lease());
    expect(result).toMatchObject({ status: 'error', error: 'GoHire bank read failed: redirect' });
    expect(requests.map((r) => r.path)).toEqual(['/api/v1/syndication/jobs']);
    expect(written).toEqual([]);
  });

  it('a cursor that goes back is refused: nothing of that page is written', async () => {
    respond = (_req, res) => json(res, 200, page({ items: [wireJob('s1')], nextCursor: '2026-10-01T00:00:00.000Z|a', hasMore: true }));
    const { db, written, fake } = createIngestFake();
    const result = await runIngestQuery(ctxFor(db), createBankAdapter('gohire'), lease(stored('2026-10-05T03:00:00.000Z|s4')));
    expect(result).toMatchObject({ status: 'error', error: 'GoHire bank read failed: cursor_regressed' });
    expect(written).toEqual([]);
    expect(storedCursor(fake)).toBeNull();
  });

  it('a page that does not fit the contract writes nothing, even when most of its jobs are fine', async () => {
    respond = (_req, res) => json(res, 200, page({ items: [wireJob('s1'), wireJob('s2', { employerVerified: 'yes' }), wireJob('s3')], nextCursor: '2026-10-05T01:00:00.000Z|s3' }));
    const { db, written } = createIngestFake();
    const result = await runIngestQuery(ctxFor(db), createBankAdapter('gohire'), lease());
    expect(result).toMatchObject({ status: 'error', error: 'GoHire bank read failed: invalid_page (items[].employerVerified: wrong_type)' });
    expect(written).toEqual([]);
  });

  it('seen again: 7 days after its pass began the sync asks from the beginning, the jobs the bank still lists are written again, and a tombstone is applied again', async () => {
    respond = (req, res) =>
      req.search.get('cursor')
        ? json(res, 200, page())
        : json(res, 200, page({ items: [wireJob('s1'), wireJob('s2', { updatedAt: '2026-10-05T10:00:00+08:00' })], tombstones: [{ id: 'old1', updatedAt: '2026-10-05T11:00:00+08:00' }], nextCursor: '2026-10-05T03:00:00.000Z|old1' }));
    const existing = (externalId: string) => ({ id: `j-${externalId}`, sourceBoard: 'gohire', externalId, market: 'cn', archivedAt: null, visibility: 'public' });
    const { db, written, fake } = createIngestFake({ seed: { rAJob: [existing('s1'), existing('s2'), existing('old1')] } });
    const adapter = createBankAdapter('gohire');
    const position = '2026-10-05T03:00:00.000Z|old1';

    // Six days into its pass: the stored position is asked for, and an idle bank answers nothing.
    const sixDays = await runIngestQuery(ctxFor(db), adapter, lease(stored(position, new Date(NOW.getTime() - 6 * 86_400_000))));
    expect(requests.at(-1)!.search.get('cursor')).toBe(position);
    expect(sixDays).toMatchObject({ status: 'ok', more: false });
    expect(written).toEqual([]);

    // Seven days: no cursor is sent, so the endpoint answers from its first job.
    const sevenDays = await runIngestQuery(ctxFor(db), adapter, lease(stored(position, new Date(NOW.getTime() - 7 * 86_400_000))));
    expect(requests.at(-1)!.search.get('cursor')).toBeNull();
    expect(sevenDays).toMatchObject({ status: 'ok', more: false, closed: 1 });
    expect(sevenDays.notes).toMatchObject({ bank_reread_started: 1, bank_synced: 2, bank_closed: 1 });
    // Both open jobs are written again (the upsert moves lastSeenAt: the mainland "45 days unseen" rule cannot close a job the bank lists).
    expect(written.map((r) => r.externalId)).toEqual(['s1', 's2']);
    expect(fake.$rows('rAJob').find((r) => r.id === 'j-old1')).toMatchObject({ closeReason: 'bank_closed' });
    // The stored cursor is the same position, in a pass that began now.
    expect(storedCursor(fake)).toBe(stored(position, NOW));
  });

  it('a job first stored as 代招 loses the label on the sync after the bank verifies its employer, and gets it back when the verification ends', async () => {
    // The bank's state for one job. A change of the employer's verification moves the job's updatedAt (GOHIRE_SYNDICATION.md 5.4).
    let employerVerified = false;
    let updatedAt = '2026-10-05T09:00:00+08:00';
    respond = (_req, res) => json(res, 200, page({ items: [wireJob('s1', { employerVerified, updatedAt })], nextCursor: `${updatedAt}|s1` }));
    const { db, written, fake } = createIngestFake();
    const adapter = createBankAdapter('gohire');
    /**
     * The stored value after the upsert. The ingest fake records the rows and does not play ON CONFLICT, so the
     * statement's rule is restated here: `"isAgency" = COALESCE(EXCLUDED."isAgency", "RAJob"."isAgency")`
     * (upsert.ts), a stored value survives only an incoming NULL.
     */
    const afterUpsert = (storedValue: boolean | null, incoming: boolean | null): boolean | null => incoming ?? storedValue;
    const card = (isAgency: boolean | null) => ({ ...written.at(-1)!, isAgency });

    // Not verified yet (every job of the list reader, and every syndicated job until the bank has the record): 代招.
    await runIngestQuery(ctxFor(db), adapter, lease());
    expect(written.at(-1)).toMatchObject({ externalId: 's1', employerVerified: false, isAgency: true });
    let storedIsAgency = afterUpsert(null, written.at(-1)!.isAgency);
    expect(isDirectFromEmployer(card(storedIsAgency) as never)).toBe(false);

    // The bank verifies the employer. The row is written with isAgency FALSE: a null would leave the stored `true` in place.
    employerVerified = true;
    updatedAt = '2026-10-06T09:00:00+08:00';
    await runIngestQuery(ctxFor(db), adapter, lease(storedCursor(fake)!));
    expect(written.at(-1)).toMatchObject({ externalId: 's1', employerVerified: true, isAgency: false });
    storedIsAgency = afterUpsert(storedIsAgency, written.at(-1)!.isAgency);
    expect(storedIsAgency).toBe(false);
    expect(isDirectFromEmployer(card(storedIsAgency) as never)).toBe(true);

    // The verification runs out or is revoked: 代招 again.
    employerVerified = false;
    updatedAt = '2026-10-07T09:00:00+08:00';
    await runIngestQuery(ctxFor(db), adapter, lease(storedCursor(fake)!));
    expect(written.at(-1)).toMatchObject({ externalId: 's1', employerVerified: false, isAgency: true });
    storedIsAgency = afterUpsert(storedIsAgency, written.at(-1)!.isAgency);
    expect(isDirectFromEmployer(card(storedIsAgency) as never)).toBe(false);
    expect(written).toHaveLength(3);
    // The stand-in above is the statement that ran: its isAgency clause reads the incoming value first, never the stored one.
    const upsertSql = fake.$sql.calls.find((c) => c.text.includes('INSERT INTO "RAJob"'))!.text;
    expect(upsertSql).toMatch(/"isAgency" = [^\n]*EXCLUDED\."isAgency"/);
    expect(upsertSql).not.toMatch(/"isAgency" = COALESCE\("RAJob"/);
  });

  it('a request cut short by what the tick could still give is not a failed sync: no error is stored, the cursor stays, and the query is due at once', async () => {
    vi.useFakeTimers();
    try {
      // A healthy endpoint that needs longer than the few seconds left of the tick (no network: the request never resolves).
      const slow: BankFetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      const { db, written, fake } = createIngestFake({ seed: { rAJob: [{ id: 'j-keep', sourceBoard: 'gohire', externalId: 'keep1', market: 'cn', archivedAt: null, visibility: 'public' }] } });
      const adapter = createBankAdapter('gohire', { fetch: slow });
      const cursor = stored('2026-10-05T03:00:00.000Z|s4');
      /** The run's last UPDATE of its RAIngestQuery row: [lastRunAt, nextRunAt, seen, new, consecutiveEmpty, lastError, cursor, …]. */
      const finish = () => fake.$sql.calls.filter((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "lastRunAt"')).at(-1)!.values;

      // In the middle of a pass, with 5 s of the tick left: the request is given those 5 s and runs out of them.
      const short = runIngestQuery({ ...ctxFor(db), budgetMs: 5_000 }, adapter, lease(cursor));
      await vi.advanceTimersByTimeAsync(5_000);
      const cut = await short;
      expect(cut).toMatchObject({ status: 'ok', calls: 1, more: true, closed: 0 });
      expect(cut.error).toBeUndefined();
      expect(cut.notes).toEqual({ bank_pass_cut_short: 1 });
      // No error on the Sources panel, no hour of waiting: the query is due now and its cursor is the one it had.
      expect(finish()[1]).toEqual(NOW);
      expect(finish()[5]).toBeNull();
      expect(storedCursor(fake)).toBe(cursor);
      expect(written).toEqual([]);
      expect(fake.$rows('rAJob').find((r) => r.id === 'j-keep')).toMatchObject({ archivedAt: null });

      // The next tick asks again with the full 20 s. An endpoint that does not answer in them is failing: an error, retried in an hour.
      const full = runIngestQuery(ctxFor(db), adapter, lease(cursor));
      await vi.advanceTimersByTimeAsync(20_000);
      const failed = await full;
      expect(failed).toMatchObject({ status: 'error', calls: 1, error: 'GoHire bank read failed: timeout' });
      expect(finish()[1]).toEqual(new Date(NOW.getTime() + 3_600_000));
      expect(finish()[5]).toBe('GoHire bank read failed: timeout');
      expect(storedCursor(fake)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an idle bank: an empty page keeps the stored position and the sync is exhausted', async () => {
    respond = (_req, res) => json(res, 200, page());
    const { db, written, fake } = createIngestFake();
    const result = await runIngestQuery(ctxFor(db), createBankAdapter('gohire'), lease(stored('2026-10-05T03:00:00.000Z|s4')));
    expect(result).toMatchObject({ status: 'ok', more: false, closed: 0 });
    expect(written).toEqual([]);
    expect(storedCursor(fake)).toBe(stored('2026-10-05T03:00:00.000Z|s4'));
  });

  // ── 4. The owner's probe, against the same stub ──────────────────────────

  const probeEnv = () => ({ GOHIRE_SYNDICATION_URL: `${endpoint}?token=URL-QUERY-SECRET`, GOHIRE_SYNDICATION_KEY: KEY });
  const runProbe = async (argv: string[] = [], env: Record<string, string> = probeEnv()) => {
    const lines: string[] = [];
    const exitCode: number = await probe.main(argv, { env, out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) });
    return { exitCode, lines, text: lines.join('\n') };
  };

  it('the probe prints counts and the cursor for a page that fits, and exits 0; nothing else of the payload is in its output', async () => {
    respond = (req, res) =>
      req.key === KEY
        ? json(res, 200, {
            items: [
              wireJob('probe_job_1', { employerVerified: true, syndicationConsentAt: '2026-09-01T10:00:00+08:00', validUntil: '2026-12-31' }),
              wireJob('probe_job_2', { syndicationConsentAt: '2026-09-02T10:00:00', title: '软件测试工程师' }),
              wireJob('probe_job_3', { companyName: '样例数据有限公司' }),
            ],
            tombstones: [{ id: 'probe_gone_1', updatedAt: '2026-10-06T10:00:00+08:00', reason: 'REASON-SECRET' }],
            nextCursor: '2026-10-06T10:00:00+08:00|probe_gone_1',
            hasMore: true,
          })
        : json(res, 401, {});
    const { exitCode, lines, text } = await runProbe(['--limit', '25']);
    expect(exitCode).toBe(0);
    expect(lines).toEqual([
      'GoHire syndication probe: one GET, nothing is written.',
      `Endpoint: ${endpoint}`,
      'Key: set (GOHIRE_SYNDICATION_KEY)',
      'Asked for: limit 25, from the beginning',
      'HTTP status: 200',
      'Items: 3',
      'Tombstones: 1',
      'Jobs with a verified employer: 1',
      'Jobs with a consent to syndicate: 2',
      'Jobs with a validity end: 1',
      'Times sent without a zone (read as UTC+8; send an offset): 1',
      'More pages: yes',
      'Cursor of this page: 2026-10-06T02:00:00.000Z|probe_gone_1',
      'Schema: OK',
      'PASS',
    ]);
    // One read-only request, with the key in the header and the limit asked for.
    expect(requests.map((r) => [r.path, r.search.get('limit'), r.search.get('cursor'), r.key])).toEqual([['/api/v1/syndication/jobs', '25', null, KEY]]);
    // No job text, no company name, no id but the cursor's, no key, no query of the URL.
    expect(text).not.toMatch(/SECRET|syn_scoped|后端|测试|示例|样例|有限公司|深圳|probe_job|15-25K|token=/);
  });

  it('the probe prints schema problems by field name for a bad page and exits 1', async () => {
    respond = (_req, res) => json(res, 200, { items: [wireJob('probe_job_1', { updatedAt: 'INTERNAL-NOTE-SECRET' }), wireJob('probe_job_2', { updatedAt: 'x', employerVerified: null })], tombstones: [], hasMore: false });
    const { exitCode, lines, text } = await runProbe();
    expect(exitCode).toBe(1);
    expect(lines.slice(4)).toEqual([
      'HTTP status: 200',
      'Schema problems (by field):',
      '  items[].updatedAt: not_iso (2)',
      '  items[].employerVerified: wrong_type (1)',
      '  nextCursor: missing (1)',
      'FAIL: the page does not fit the contract. See docs/jobright-clone/market/GOHIRE_SYNDICATION.md.',
    ]);
    expect(text).not.toMatch(/SECRET|syn_scoped|后端|示例|probe_job/);
  });

  it('the probe reports a refused key, a page over the limit and an unreadable answer as FAIL (exit 1), never with a body', async () => {
    respond = (_req, res) => json(res, 401, { message: 'UPSTREAM-BODY-SECRET' });
    const refused = await runProbe();
    expect(refused.exitCode).toBe(1);
    expect(refused.lines.slice(4)).toEqual(['HTTP status: 401', 'FAIL: key_refused']);
    respond = (_req, res) => json(res, 200, page({ items: [wireJob('a'), wireJob('b')], nextCursor: '2026-10-05T01:00:00Z|b' }));
    const over = await runProbe(['--limit', '1']);
    expect(over.exitCode).toBe(1);
    expect(over.lines.at(-1)).toBe('FAIL: the page holds more than the 1 entries that were asked for.');
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>UPSTREAM-BODY-SECRET</html>');
    };
    const html = await runProbe();
    expect(html.exitCode).toBe(1);
    expect(html.lines.at(-1)).toBe('FAIL: not_json');
    expect(`${refused.text}${over.text}${html.text}`).not.toMatch(/SECRET|syn_scoped/);
    // A cursor to continue from is sent in its canonical spelling.
    respond = (_req, res) => json(res, 200, page());
    const next = await runProbe(['--cursor', '2026-10-06T10:00:00+08:00|probe_gone_1']);
    expect(next.exitCode).toBe(0);
    expect(requests.at(-1)!.search.get('cursor')).toBe('2026-10-06T02:00:00.000Z|probe_gone_1');
    expect(next.lines[3]).toBe('Asked for: limit 50, after 2026-10-06T02:00:00.000Z|probe_gone_1');
  });
});

// ── 4. The probe script's copy of the contract ────────────────────────────

describe('scripts/gohire-syndication-probe.mjs', () => {
  const SCRIPT_PATH = fileURLToPath(new URL('../../../../../../scripts/gohire-syndication-probe.mjs', import.meta.url));

  /** A page that fits, with one entry of every kind (the base of the mutation table). */
  const validPage = () => ({
    items: [wireJob('a1', { employerVerified: true, syndicationConsentAt: '2026-09-01T10:00:00+08:00', validFrom: '2026-10-01', validUntil: '2026-12-31T18:00:00+08:00' })],
    tombstones: [{ id: 't1', updatedAt: '2026-10-07T00:00:00.000Z', reason: 'closed' }],
    nextCursor: '2026-10-07T00:00:00.000Z|t1',
    hasMore: false,
  });

  it('holds the same field names as the schema, for the page, a job, its company and a tombstone', () => {
    for (const part of ['page', 'job', 'company', 'tombstone'] as const) {
      expect(Object.keys(probe.SYNDICATION_PROBE_FIELDS[part]).sort(), part).toEqual([...SYNDICATION_FIELDS[part]].sort());
    }
    expect(probe.KEY_HEADER).toBe(SYNDICATION_KEY_HEADER);
    expect(probe.PROBE_MAX_BYTES).toBe(SYNDICATION_MAX_BYTES);
    expect(probe.PROBE_MAX_LIMIT).toBe(SYNDICATION_MAX_LIMIT);
  });

  it('judges every field exactly as the schema does: each field of the contract, changed in each way, gets the same verdict and the same problems', () => {
    const changes: Array<[string, (holder: Record<string, unknown>, key: string) => void]> = [
      ['removed', (o, k) => delete o[k]],
      ['null', (o, k) => (o[k] = null)],
      ['a whole number', (o, k) => (o[k] = 7)],
      ['a fraction', (o, k) => (o[k] = 1.5)],
      ['a word', (o, k) => (o[k] = 'x')],
      ['an empty string', (o, k) => (o[k] = '')],
      ['a time with an offset', (o, k) => (o[k] = '2026-10-06T08:00:00+08:00')],
      ['a time without a zone', (o, k) => (o[k] = '2026-10-06T08:00:00')],
      ['a calendar day', (o, k) => (o[k] = '2026-10-06')],
      ['a time that is not ISO', (o, k) => (o[k] = '06/10/2026 08:00')],
      ['a cursor', (o, k) => (o[k] = '2026-10-06T08:00:00Z|abc')],
      ['a string with a bar and a space', (o, k) => (o[k] = 'a |b')],
      ['true', (o, k) => (o[k] = true)],
      ['a list of numbers', (o, k) => (o[k] = [1, 2])],
      ['a list of strings', (o, k) => (o[k] = ['a'])],
      ['an empty list', (o, k) => (o[k] = [])],
      ['an empty object', (o, k) => (o[k] = {})],
    ];
    const holders = {
      page: (p: ReturnType<typeof validPage>) => p as unknown as Record<string, unknown>,
      job: (p: ReturnType<typeof validPage>) => p.items[0]!,
      company: (p: ReturnType<typeof validPage>) => p.items[0]!.company as Record<string, unknown>,
      tombstone: (p: ReturnType<typeof validPage>) => p.tombstones[0]! as Record<string, unknown>,
    };
    let cases = 0;
    let rejected = 0;
    for (const part of ['page', 'job', 'company', 'tombstone'] as const) {
      for (const field of SYNDICATION_FIELDS[part]) {
        for (const [name, change] of changes) {
          const raw = validPage();
          change(holders[part](raw), field);
          const label = `${part}.${field} ${name}`;
          const schema = parseSyndicationPage(raw);
          const script = probe.validateSyndicationPage(raw);
          expect(script.ok, label).toBe(schema.ok);
          expect(sorted(script.problems), label).toEqual(schema.ok ? [] : sorted(schema.problems));
          const summary = probe.summarizeSyndicationPage(raw);
          expect(summary.ok, label).toBe(schema.ok);
          if (schema.ok) expect(summary.counts.timesWithoutZone, label).toBe(schema.timesWithoutZone);
          cases += 1;
          if (!schema.ok) rejected += 1;
        }
      }
    }
    // Every field of the contract was exercised, and the table holds both verdicts.
    expect(cases).toBe((4 + SYNDICATION_FIELDS.job.length + 8 + 3) * changes.length);
    expect(rejected).toBeGreaterThan(150);
    expect(cases - rejected).toBeGreaterThan(150);
    // Bodies that are no page at all.
    for (const raw of [null, undefined, [], 'INTERNAL-NOTE-SECRET', 7, true]) {
      expect(probe.validateSyndicationPage(raw).problems).toEqual(problemsOf(raw));
      expect(problemsOf(raw)).toEqual([{ field: '(page)', code: 'wrong_type', count: 1 }]);
    }
    // And the two readers of a time and of a cursor agree on every spelling.
    for (const value of ['2026-10-05T09:00:00+08:00', '2026-10-05T01:00:00.123456789Z', '2026-10-05T09:00:00+0800', '2026-10-05T09:00', '2026-10-05', '2026-02-30', '2026-02-30T00:00:00Z', '2026-10-05T24:00:00Z', '2026-10-05T09:00:60', 'yesterday', '', null, 7]) {
      for (const allowDay of [false, true]) {
        const ours = readIsoTime(value, { allowDay });
        const theirs = probe.readIsoTime(value, { allowDay });
        expect(theirs, String(value)).toEqual(ours);
      }
    }
    for (const value of ['2026-10-05T09:00:00+08:00|job_1', '2026-10-05T01:00:00Z|a|b', 'job_1', null]) {
      const ours = parseSyndicationCursor(value);
      expect(probe.canonicalCursor(value)).toBe(ours ? `${ours.updatedAt.toISOString()}|${ours.id}` : null);
    }
    for (const status of [401, 403, 404, 429, 500, 503, 418]) expect(probe.statusReason(status)).toBe(syndicationStatusReason(status));
  });

  it('the summariser is pure and returns counts, the cursor and problems only', () => {
    const raw = {
      items: [
        wireJob('sum_job_1', { employerVerified: true, syndicationConsentAt: '2026-09-01T10:00:00+08:00', validUntil: '2026-12-31' }),
        wireJob('sum_job_2', { employerVerified: true, validUntil: '2026-11-30T18:00:00+08:00' }),
        wireJob('sum_job_3', { updatedAt: '2026-10-05T09:00:00' }),
      ],
      tombstones: [{ id: 'sum_gone_1', updatedAt: '2026-10-06T10:00:00+08:00' }, { id: 'sum_gone_2', updatedAt: '2026-10-06T11:00:00+08:00' }],
      nextCursor: '2026-10-06T11:00:00+08:00|sum_gone_2',
      hasMore: false,
    };
    const before = JSON.stringify(raw);
    const summary = probe.summarizeSyndicationPage(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(summary).toEqual({
      ok: true,
      problems: [],
      counts: { items: 3, tombstones: 2, verified: 2, withConsent: 1, withValidity: 2, timesWithoutZone: 1 },
      hasMore: false,
      nextCursor: '2026-10-06T03:00:00.000Z|sum_gone_2',
    });
    expect(JSON.stringify(summary)).not.toMatch(/SECRET|后端|示例|sum_job|深圳/);
    expect(probe.formatSummary(summary, 50).at(-1)).toBe('PASS');
    expect(probe.formatSummary(summary, 4).at(-1)).toMatch(/^FAIL: the page holds more than the 4 entries/);
    // A page that does not fit has no counts at all: nothing is counted from a body that was not validated.
    const bad = probe.summarizeSyndicationPage({ ...raw, items: [wireJob('sum_job_1', { id: 'INTERNAL NOTE SECRET' })] });
    expect(bad).toEqual({ ok: false, problems: [{ field: 'items[].id', code: 'bad_id', count: 1 }], counts: null, hasMore: null, nextCursor: null });
  });

  it('refuses to run without its settings or against plain http on a public host: exit 2, before any request', async () => {
    const fetch = vi.fn();
    const run = async (env: Record<string, string>, argv: string[] = []) => {
      const lines: string[] = [];
      const exitCode: number = await probe.main(argv, { env, fetch, out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) });
      return { exitCode, text: lines.join('\n') };
    };
    expect(await run({})).toMatchObject({ exitCode: 2, text: expect.stringContaining('GOHIRE_SYNDICATION_URL is not set.') });
    expect(await run({ GOHIRE_SYNDICATION_URL: 'https://api.gohire.test/s' })).toMatchObject({ exitCode: 2, text: expect.stringContaining('Neither GOHIRE_SYNDICATION_KEY nor GOHIRE_API_KEY is set.') });
    const plain = await run({ GOHIRE_SYNDICATION_URL: 'http://api.gohire.test/s?token=URL-QUERY-SECRET', GOHIRE_API_KEY: KEY });
    expect(plain).toMatchObject({ exitCode: 2, text: expect.stringContaining('must be https') });
    expect(plain.text).not.toMatch(/SECRET|syn_scoped/);
    expect(await run({ GOHIRE_SYNDICATION_URL: 'https://api.gohire.test/s', GOHIRE_API_KEY: KEY }, ['--limit', '500'])).toMatchObject({ exitCode: 2 });
    expect(await run({ GOHIRE_SYNDICATION_URL: 'https://api.gohire.test/s', GOHIRE_API_KEY: KEY }, ['--cursor', 'not a cursor'])).toMatchObject({ exitCode: 2 });
    expect(await run({ GOHIRE_SYNDICATION_URL: 'https://api.gohire.test/s', GOHIRE_API_KEY: KEY }, ['--verbose'])).toMatchObject({ exitCode: 2 });
    expect(fetch).not.toHaveBeenCalled();
    // The fallback key is named as what it is, never printed.
    expect(probe.resolveTarget({ GOHIRE_SYNDICATION_URL: 'https://user:pw@api.gohire.test/s?token=x', GOHIRE_API_KEY: KEY })).toEqual({
      url: 'https://user:pw@api.gohire.test/s?token=x',
      shown: 'https://api.gohire.test/s',
      key: KEY,
      keyFrom: 'GOHIRE_API_KEY',
    });
    // As a process, with nothing set: usage on stderr, exit 2, no request possible.
    const child = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 20_000 });
    expect(child.status).toBe(2);
    expect(child.stderr).toContain('GOHIRE_SYNDICATION_URL is not set.');
    expect(child.stdout).toBe('');
  });
});
