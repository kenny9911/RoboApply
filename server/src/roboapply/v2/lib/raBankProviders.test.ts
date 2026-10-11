// backend/src/roboapply/v2/lib/raBankProviders.test.ts
//
// Unit tests for buildBankJobWhere — the retrieval WHERE must be high-recall:
// ONLY status/published/fresh are hard filters; salary/level/work-mode are
// NEVER SQL cuts (they are ranking weights). [FIX-5 / spec §3.4]
// Market wave (MKT-5E): the bank's TRANSPORT decides where a live search
// reads. On the syndication endpoint (or the interim list endpoint) the GoHire
// leg reads our RAJob mirror: no database client of the bank is asked for and
// no HTTP call is made, whatever database URL is configured.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

/** The active-brand client that holds the RAJob mirror, and the client a bank's database URL would open. */
const db = vi.hoisted(() => ({
  mirrorFindMany: vi.fn(async (_args: unknown): Promise<Record<string, unknown>[]> => []),
  mirrorFindFirst: vi.fn(async (_args: unknown): Promise<Record<string, unknown> | null> => null),
  syncFindFirst: vi.fn(async (_args: unknown): Promise<Record<string, unknown> | null> => null),
  bankFindMany: vi.fn(async (_args: unknown): Promise<Record<string, unknown>[]> => []),
}));

vi.mock('../../../lib/prisma.js', () => ({
  default: {},
  prisma: {
    marker: 'active-brand-client',
    rAJob: { findMany: (args: unknown) => db.mirrorFindMany(args), findFirst: (args: unknown) => db.mirrorFindFirst(args) },
    rAIngestQuery: { findFirst: (args: unknown) => db.syncFindFirst(args) },
  },
  createPrismaClientForUrl: vi.fn(() => ({ job: { findMany: (args: unknown) => db.bankFindMany(args) } })),
  activeRuntimeUrl: () => 'postgresql://active.example/db',
  cleanConnectionString: (u: string | undefined) => u,
}));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// Every export keeps its real behaviour and records its calls, so "no database client was asked for" is a fact, not an inference.
vi.mock('./raBankClients.js', { spy: true });

import { createPrismaClientForUrl } from '../../../lib/prisma.js';
import { __test, bankMirrorSyncAge, searchBank, searchBankMirror } from './raBankProviders.js';
import { __test as bankClientTest, bankReadsMirror, bankTransport, getBankClient, getMirrorClient, isBankEnabled, listEnabledBanks } from './raBankClients.js';

const { buildBankJobWhere, buildMirrorJobWhere, mirrorRowToBankJobRow, MIRROR_SELECT } = __test;

const cutoff = new Date('2026-06-01T00:00:00.000Z');

describe('buildBankJobWhere', () => {
  const where = buildBankJobWhere({
    titles: ['Backend Engineer', 'Platform Engineer'],
    mustKeywords: ['go', 'postgres'],
    tags: ['lang:go', 'kubernetes'],
    freshnessCutoff: cutoff,
    take: 60,
  }) as Record<string, any>;

  it('only hard-filters on status open + fresh publishedAt', () => {
    expect(where.status).toBe('open');
    expect(where.publishedAt).toEqual({ not: null, gte: cutoff });
  });

  it('never puts salary / level / work-mode in the WHERE (no starvation)', () => {
    const json = JSON.stringify(where);
    expect(json).not.toContain('salaryMin');
    expect(json).not.toContain('salaryMax');
    expect(json).not.toContain('experienceLevel');
    expect(json).not.toContain('workType');
  });

  it('ORs title/keyword/tag signals for recall', () => {
    const or = where.OR as Record<string, any>[];
    expect(or.some((c) => c.title?.contains === 'Backend Engineer')).toBe(true);
    expect(or.some((c) => c.description?.contains === 'go')).toBe(true);
    expect(or.some((c) => c.qualifications?.contains === 'postgres')).toBe(true);
    expect(or.some((c) => Array.isArray(c.requiredTagSet?.hasSome))).toBe(true);
    expect(or.some((c) => Array.isArray(c.preferredTagSet?.hasSome))).toBe(true);
  });

  it('canonicalizes tag forms into hasSome (both bare + namespaced)', () => {
    const or = where.OR as Record<string, any>[];
    const tagClause = or.find((c) => c.requiredTagSet)?.requiredTagSet.hasSome as string[];
    expect(tagClause).toContain('go'); // bare form of lang:go
    expect(tagClause).toContain('kubernetes');
  });

  it('omits the OR block entirely when no signals are given (pure recall by freshness)', () => {
    const bare = buildBankJobWhere({ titles: [], mustKeywords: [], tags: [], freshnessCutoff: cutoff, take: 60 }) as Record<string, any>;
    expect(bare.OR).toBeUndefined();
    expect(bare.status).toBe('open');
  });
});

// ── Parity wave (PAR-7): a bank read over HTTPS is searched in our synced mirror ──

const intent = { titles: ['后端工程师'], mustKeywords: ['Go', 'postgres'], tags: ['lang:go'], freshnessCutoff: cutoff, take: 60 };

describe('the synced mirror of a bank with no database client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    bankClientTest.resetCache();
  });

  it('isBankEnabled reports the api transport: GoHire with a non-TLS database URL and an API key is on, with no database client', () => {
    vi.stubEnv('DATABASE_URL_GOHIRE', 'postgresql://u:p@db.gohire.example/gh');
    vi.stubEnv('GOHIRE_API_KEY', 'rh_key');
    vi.stubEnv('GOHIRE_BANK_TRANSPORT', '');
    vi.stubEnv('RA_CROSSBANK_CROSS_TENANT_CONFIRMED', 'true');
    expect(isBankEnabled('gohire')).toBe(true);
    expect(listEnabledBanks()).toContain('gohire');
    expect(getBankClient('gohire')).toBeNull();
    expect(bankReadsMirror('gohire')).toBe(true);
    expect(bankReadsMirror('robohire')).toBe(false);
    expect(getMirrorClient()).toMatchObject({ marker: 'active-brand-client' });
    // With TLS on the database URL the database transport is used and the mirror is not read.
    vi.stubEnv('DATABASE_URL_GOHIRE', 'postgresql://u:p@db.gohire.example/gh?sslmode=require');
    expect(bankReadsMirror('gohire')).toBe(false);
    expect(getBankClient('gohire')).not.toBeNull();
  });

  it('the mirror WHERE reads only open, public, canonical rows of the bank in its own market, fresh and inside their validity, with the same recall signals', () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    const where = buildMirrorJobWhere('gohire', intent, now) as Record<string, any>;
    expect(where).toMatchObject({ sourceBoard: 'gohire', market: 'cn', visibility: 'public', archivedAt: null, isCanonical: true, postedAt: { not: null, gte: cutoff } });
    // A validity the bank stated and that has passed is out at once (maintenance archives the row later).
    expect(where.AND).toEqual([{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }]);
    // The freshness bound is the live bank search's own (the same cutoff on the posting date).
    expect((buildBankJobWhere(intent) as Record<string, any>).publishedAt).toEqual(where.postedAt);
    const or = where.OR as Record<string, any>[];
    expect(or.some((c) => c.title?.contains === '后端工程师')).toBe(true);
    expect(or.some((c) => c.descriptionPlain?.contains === 'Go')).toBe(true);
    expect(or.find((c) => c.skills)?.skills.hasSome).toEqual(['go', 'postgres']);
    expect(buildMirrorJobWhere('robohire', intent)).toMatchObject({ sourceBoard: 'robohire', market: 'intl' });
    // No salary / level cut, like the bank WHERE.
    expect(JSON.stringify(where)).not.toMatch(/salaryMin|seniority|workModel/);
    // Never a recruiter-internal column: the mirror is our own index.
    expect(Object.keys(MIRROR_SELECT)).not.toEqual(expect.arrayContaining(['seedTags', 'ownerUserId']));
  });

  it('maps a mirrored row to the pre-matcher\'s shape; fields the mirror does not hold stay empty', () => {
    const row = mirrorRowToBankJobRow('gohire', {
      externalId: 'gh1', title: '后端工程师', description: '负责后端开发', location: '深圳', locationCity: '深圳', locationCountry: 'CN', workModel: 'onsite',
      employmentType: 'full_time', salaryMin: 15000, salaryMax: 25000, salaryCurrency: 'CNY', salaryPeriod: 'month', skills: ['go'],
      postedAt: new Date('2026-06-10T00:00:00Z'), companyName: '某某科技', companyLogoUrl: null,
    });
    expect(row).toMatchObject({
      bank: 'gohire',
      job: { id: 'gh1', title: '后端工程师', locationCountry: 'CN', requiredKeywordSet: ['go'], requiredTagSet: [], matchInviteScore: null, qualifications: null, publishedAt: new Date('2026-06-10T00:00:00Z') },
      company: { companyName: '某某科技', companyLogoUrl: null },
    });
  });

  it('searchBankMirror queries RAJob through the given client and never throws', async () => {
    const findMany = vi.fn(async () => [{ externalId: 'gh1', title: '后端工程师', companyName: '某某科技', postedAt: new Date('2026-06-10T00:00:00Z'), skills: [] }]);
    const rows = await searchBankMirror('gohire', intent, {}, { rAJob: { findMany } } as never);
    expect(rows!.map((r) => r.job.id)).toEqual(['gh1']);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ sourceBoard: 'gohire', market: 'cn' }), orderBy: { postedAt: 'desc' } }));
    const failing = { rAJob: { findMany: vi.fn(async () => { throw new Error('db down'); }) } };
    expect(await searchBankMirror('gohire', intent, {}, failing as never)).toBeNull();
  });

  it('searchBank: no client and no HTTPS transport → null (the bank degrades, as before)', async () => {
    vi.stubEnv('DATABASE_URL_GOHIRE', '');
    vi.stubEnv('DATABASE_URL_LIGHTARK', '');
    vi.stubEnv('GOHIRE_API_KEY', '');
    vi.stubEnv('GOHIRE_SYNDICATION_URL', '');
    expect(await searchBank('gohire', intent)).toBeNull();
  });
});

// ── Market wave (MKT-5E): the transport decides where a live search reads ──────

describe('live cross-bank search by transport', () => {
  const TLS_URL = 'postgresql://u:p@db.gohire.example/gh?sslmode=require';
  const PLAIN_URL = 'postgresql://u:p@db.gohire.example/gh';
  const mirrored = (externalId: string, over: Record<string, unknown> = {}) => ({
    externalId,
    title: '后端工程师',
    description: '负责后端开发',
    location: '深圳',
    locationCity: '深圳',
    locationCountry: 'CN',
    workModel: 'onsite',
    employmentType: 'full_time',
    salaryMin: 15000,
    salaryMax: 25000,
    salaryCurrency: 'CNY',
    salaryPeriod: 'month',
    skills: ['go'],
    postedAt: new Date('2026-06-10T00:00:00Z'),
    companyName: '某某科技',
    companyLogoUrl: null,
    ...over,
  });
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    bankClientTest.resetCache();
    db.mirrorFindMany.mockResolvedValue([]);
    db.mirrorFindFirst.mockResolvedValue(null);
    db.syncFindFirst.mockResolvedValue(null);
    db.bankFindMany.mockResolvedValue([]);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('a live search makes no HTTP call'));
    vi.stubEnv('RA_CROSSBANK_CROSS_TENANT_CONFIRMED', 'true');
    vi.stubEnv('RA_CROSSBANK_DISABLED', '');
    vi.stubEnv('RA_CROSSBANK_GOHIRE_DISABLED', '');
    vi.stubEnv('GOHIRE_BANK_TRANSPORT', '');
    vi.stubEnv('GOHIRE_API_KEY', '');
    vi.stubEnv('GOHIRE_SYNDICATION_KEY', '');
    vi.stubEnv('GOHIRE_SYNDICATION_URL', '');
    vi.stubEnv('DATABASE_URL_GOHIRE', '');
    vi.stubEnv('DATABASE_URL_LIGHTARK', '');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    bankClientTest.resetCache();
  });

  const syndication = (databaseUrl = '') => {
    vi.stubEnv('GOHIRE_SYNDICATION_URL', 'https://api.gohire.test/api/v1/syndication/jobs');
    vi.stubEnv('GOHIRE_SYNDICATION_KEY', 'syn_key');
    vi.stubEnv('DATABASE_URL_GOHIRE', databaseUrl);
  };

  it.each([
    ['no database URL at all', ''],
    ['a database URL that satisfies TLS', TLS_URL],
    ['a database URL that does not require TLS', PLAIN_URL],
  ])('transport syndication with %s: the GoHire leg reads the mirror, asks for no database client and makes no HTTP call', async (_name, databaseUrl) => {
    syndication(databaseUrl);
    expect(bankTransport('gohire')).toBe('syndication');
    expect(isBankEnabled('gohire')).toBe(true);
    db.mirrorFindMany.mockResolvedValue([mirrored('gh_job_1'), mirrored('gh_job_2', { title: 'Go 开发工程师' })]);
    vi.mocked(getBankClient).mockClear();

    const rows = await searchBank('gohire', intent);

    // The recruiter job id (RAJob.externalId) is the row's id, so the materialisation keys are the database transport's.
    expect(rows!.map((r) => [r.bank, r.job.id])).toEqual([['gohire', 'gh_job_1'], ['gohire', 'gh_job_2']]);
    expect(rows![0]).toMatchObject({ job: { title: '后端工程师', locationCountry: 'CN', workType: 'onsite', requiredKeywordSet: ['go'], salaryCurrency: 'CNY' }, company: { companyName: '某某科技' } });
    expect(db.mirrorFindMany).toHaveBeenCalledTimes(1);
    expect(db.mirrorFindMany.mock.calls[0]![0]).toMatchObject({
      where: { market: 'cn', sourceBoard: 'gohire', visibility: 'public', archivedAt: null, isCanonical: true, postedAt: { not: null, gte: cutoff } },
      orderBy: { postedAt: 'desc' },
    });
    // Zero calls to getBankClient('gohire'), no pool opened, the bank's own database never queried, no HTTP.
    expect(vi.mocked(getBankClient)).not.toHaveBeenCalled();
    expect(vi.mocked(createPrismaClientForUrl)).not.toHaveBeenCalled();
    expect(db.bankFindMany).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the interim list endpoint (transport api) reads the mirror the same way, even with GOHIRE_BANK_TRANSPORT=api over a TLS database', async () => {
    vi.stubEnv('GOHIRE_API_KEY', 'rh_key');
    vi.stubEnv('DATABASE_URL_GOHIRE', TLS_URL);
    vi.stubEnv('GOHIRE_BANK_TRANSPORT', 'api');
    expect(bankTransport('gohire')).toBe('api');
    db.mirrorFindMany.mockResolvedValue([mirrored('gh_job_1')]);
    vi.mocked(getBankClient).mockClear();
    expect((await searchBank('gohire', intent))!.map((r) => r.job.id)).toEqual(['gh_job_1']);
    expect(vi.mocked(getBankClient)).not.toHaveBeenCalled();
    expect(vi.mocked(createPrismaClientForUrl)).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an empty mirror is an empty list, not an error; a mirror read that fails degrades to null and never throws', async () => {
    syndication();
    expect(await searchBank('gohire', intent)).toEqual([]);
    db.mirrorFindMany.mockRejectedValueOnce(new Error('db down'));
    expect(await searchBank('gohire', intent)).toBeNull();
  });

  it('transport db: the bank\'s database is queried as before and the mirror is not read', async () => {
    vi.stubEnv('DATABASE_URL_GOHIRE', TLS_URL);
    expect(bankTransport('gohire')).toBe('db');
    expect(bankReadsMirror('gohire')).toBe(false);
    db.bankFindMany.mockResolvedValue([{ id: 'gh_job_9', title: '后端工程师', companyName: '某某科技', publishedAt: new Date('2026-06-10T00:00:00Z') }]);
    vi.mocked(getBankClient).mockClear();
    const rows = await searchBank('gohire', intent);
    expect(rows!.map((r) => r.job.id)).toEqual(['gh_job_9']);
    expect(vi.mocked(getBankClient)).toHaveBeenCalledWith('gohire');
    expect(db.bankFindMany).toHaveBeenCalledTimes(1);
    expect(db.bankFindMany.mock.calls[0]![0]).toMatchObject({ where: { status: 'open', publishedAt: { not: null, gte: cutoff } }, orderBy: { publishedAt: 'desc' } });
    expect(db.mirrorFindMany).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('RoboHire is unchanged: its database, never the mirror', async () => {
    vi.stubEnv('DATABASE_URL_ROBOHIRE', 'postgresql://u:p@db.robohire.example/rh');
    syndication();
    expect(bankReadsMirror('robohire')).toBe(false);
    await searchBank('robohire', intent);
    expect(db.bankFindMany).toHaveBeenCalledTimes(1);
    expect(db.mirrorFindMany).not.toHaveBeenCalled();
  });

  it('the mirror\'s sync age: the newest lastSeenAt of the bank\'s rows, beside the last run of the sync itself', async () => {
    const now = new Date('2026-10-10T08:00:00.000Z');
    db.mirrorFindFirst.mockResolvedValue({ lastSeenAt: new Date('2026-10-10T05:30:00.000Z') });
    db.syncFindFirst.mockResolvedValue({ lastRunAt: new Date('2026-10-10T07:50:00.000Z'), lastError: null });
    expect(await bankMirrorSyncAge('gohire', now)).toEqual({ newestSeenAt: '2026-10-10T05:30:00.000Z', ageMs: 9_000_000, lastSyncAt: '2026-10-10T07:50:00.000Z', lastSyncFailed: false });
    // Every row of the bank counts (an archived row was seen too), in the bank's own market.
    expect(db.mirrorFindFirst).toHaveBeenCalledWith({ where: { sourceBoard: 'gohire', market: 'cn' }, orderBy: { lastSeenAt: 'desc' }, select: { lastSeenAt: true } });
    expect(db.syncFindFirst).toHaveBeenCalledWith({
      where: { provider: 'bank_gohire', market: 'cn', origin: 'bank_sync' },
      orderBy: { lastRunAt: { sort: 'desc', nulls: 'last' } },
      select: { lastRunAt: true, lastError: true },
    });
    // A sync whose last run failed says so (the code only, never the error text).
    db.syncFindFirst.mockResolvedValue({ lastRunAt: new Date('2026-10-10T07:50:00.000Z'), lastError: 'GoHire bank read failed: http_401 key_refused' });
    expect(await bankMirrorSyncAge('gohire', now)).toMatchObject({ lastSyncFailed: true });
    // An empty mirror and a sync that never ran: nulls, not an error.
    db.mirrorFindFirst.mockResolvedValue(null);
    db.syncFindFirst.mockResolvedValue(null);
    expect(await bankMirrorSyncAge('gohire', now)).toEqual({ newestSeenAt: null, ageMs: null, lastSyncAt: null, lastSyncFailed: false });
    // Telemetry never throws.
    db.mirrorFindFirst.mockRejectedValueOnce(new Error('db down'));
    expect(await bankMirrorSyncAge('gohire', now)).toBeNull();
  });
});
