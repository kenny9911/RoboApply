// backend/src/roboapply/v2/lib/raBankProviders.test.ts
//
// Unit tests for buildBankJobWhere — the retrieval WHERE must be high-recall:
// ONLY status/published/fresh are hard filters; salary/level/work-mode are
// NEVER SQL cuts (they are ranking weights). [FIX-5 / spec §3.4]

import { afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({
  default: {},
  prisma: { marker: 'active-brand-client' },
  createPrismaClientForUrl: vi.fn(() => ({ job: { findMany: vi.fn(async () => []) } })),
  activeRuntimeUrl: () => 'postgresql://active.example/db',
  cleanConnectionString: (u: string | undefined) => u,
}));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { __test, searchBank, searchBankMirror } from './raBankProviders.js';
import { __test as bankClientTest, bankReadsMirror, getBankClient, getMirrorClient, isBankEnabled, listEnabledBanks } from './raBankClients.js';

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

  it('the mirror WHERE reads only open public rows of the bank in its own market, fresh, with the same recall signals', () => {
    const where = buildMirrorJobWhere('gohire', intent) as Record<string, any>;
    expect(where).toMatchObject({ sourceBoard: 'gohire', market: 'cn', visibility: 'public', archivedAt: null, postedAt: { not: null, gte: cutoff } });
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
    expect(await searchBank('gohire', intent)).toBeNull();
  });
});
