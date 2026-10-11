// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../services/LoggerService.js', () => ({ logger }));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { Prisma } from '../../../generated/prisma/client.js';
import { ENRICH_COST_SKU, createPrismaEnrichRepository, resetMissingCostUsersForTests, toJobUpdateData, type EnrichDb } from './repository.js';

function fakeDb(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Record<string, unknown[]> = { findUnique: [], update: [], upsert: [], create: [] };
  const db = {
    rAJob: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.findUnique!.push(args);
        return null;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.update!.push(args);
        return { id: 'j1' };
      }),
    },
    rAKeywordExtraction: {
      upsert: vi.fn(async (args: unknown) => {
        calls.upsert!.push(args);
        return { id: 'k1' };
      }),
    },
    usageDeductionLog: {
      create:
        (overrides.create as (args: unknown) => Promise<unknown>) ??
        vi.fn(async (args: unknown) => {
          calls.create!.push(args);
          return { id: 'u1' };
        }),
    },
  } as unknown as EnrichDb;
  return { db, calls };
}

describe('toJobUpdateData', () => {
  it('maps only the keys that are present, with array sets and JSON nulls', () => {
    const at = new Date('2026-10-10T00:00:00.000Z');
    expect(
      toJobUpdateData({
        taxonomyIds: ['a', 'b'],
        skills: ['python'],
        employerTags: [],
        skillsDetail: [{ skill: 'python', kind: 'hard', required: true }],
        marketTags: null,
        fraudFlags: [{ rule: 'intl_fee_required', evidence: 'fee', at: at.toISOString() }],
        sponsorship: null,
        enrichedAt: at,
        enrichVersion: 1,
        enrichModel: 'rules',
      }),
    ).toEqual({
      taxonomyIds: { set: ['a', 'b'] },
      skills: { set: ['python'] },
      employerTags: { set: [] },
      skillsDetail: [{ skill: 'python', kind: 'hard', required: true }],
      marketTags: Prisma.DbNull,
      fraudFlags: [{ rule: 'intl_fee_required', evidence: 'fee', at: at.toISOString() }],
      sponsorship: null,
      enrichedAt: at,
      enrichVersion: 1,
      enrichModel: 'rules',
    });
    expect(toJobUpdateData({})).toEqual({});
  });

  it('SM-2: writes the title match score, and null when the title names no role', () => {
    expect(toJobUpdateData({ titleMatchScore: 0.85 })).toEqual({ titleMatchScore: 0.85 });
    expect(toJobUpdateData({ titleMatchScore: null })).toEqual({ titleMatchScore: null });
    expect(toJobUpdateData({ primaryTaxonomyId: 'software_architect', taxonomyIds: ['software_engineering', 'swe_leadership', 'software_architect'], titleMatchScore: 1 })).toEqual({
      primaryTaxonomyId: 'software_architect',
      taxonomyIds: { set: ['software_engineering', 'swe_leadership', 'software_architect'] },
      titleMatchScore: 1,
    });
  });
});

describe('prisma enrich repository', () => {
  it('loads with a select, updates only when there is data and upserts keywords', async () => {
    const { db, calls } = fakeDb();
    const repo = createPrismaEnrichRepository(db);
    expect(await repo.loadJob('j1')).toBeNull();
    expect((calls.findUnique![0] as { where: unknown }).where).toEqual({ id: 'j1' });

    await repo.saveJob('j1', {});
    expect(calls.update).toHaveLength(0);
    await repo.saveJob('j1', { summary: 'Two sentences.' });
    expect(calls.update![0]).toMatchObject({ where: { id: 'j1' }, data: { summary: 'Two sentences.' } });

    const generatedAt = new Date('2026-10-10T00:00:00.000Z');
    await repo.saveKeywords('j1', { keywords: [{ keyword: 'python', importance: 'high', frequency: 2 }], modelUsed: 'm', tokenCost: 0.001, generatedAt });
    expect(calls.upsert![0]).toMatchObject({
      where: { jobId: 'j1' },
      create: { jobId: 'j1', modelUsed: 'm', tokenCost: 0.001, generatedAt },
      update: { modelUsed: 'm', tokenCost: 0.001, generatedAt },
    });
  });

  it('SM-2 / SM-10: loadJob selects the stored title score and the company the industry is written to; saveJob writes the score', async () => {
    const { db, calls } = fakeDb();
    const repo = createPrismaEnrichRepository(db);
    await repo.loadJob('j1');
    expect((calls.findUnique![0] as { select: Record<string, boolean> }).select).toMatchObject({ titleMatchScore: true, companyId: true, title: true, primaryTaxonomyId: true });
    await repo.saveJob('j1', { titleMatchScore: 0.883 });
    expect(calls.update![0]).toMatchObject({ where: { id: 'j1' }, data: { titleMatchScore: 0.883 } });
  });

  it('loadJob also selects the place and link columns the market hooks read (no second read of the row)', async () => {
    const { db, calls } = fakeDb();
    await createPrismaEnrichRepository(db).loadJob('j1');
    expect((calls.findUnique![0] as { select: Record<string, boolean> }).select).toMatchObject({ locationCountry: true, locations: true, sourceUrl: true, applyUrl: true, fraudFlags: true, marketTags: true });
  });

  it('clearedScamRules reads the rules of the job’s LATEST restore decision (RAJobReview); none → nothing cleared', async () => {
    const reviews = [
      { jobId: 'j1', decision: 'restore', at: new Date('2026-10-01T00:00:00Z'), clearedRules: ['intl_fee_required', 'intl_pay_to_apply'] },
      { jobId: 'j1', decision: 'close', at: new Date('2026-10-05T00:00:00Z'), clearedRules: [] },
      { jobId: 'j1', decision: 'restore', at: new Date('2026-10-08T00:00:00Z'), clearedRules: ['intl_fee_required'] },
      { jobId: 'other', decision: 'restore', at: new Date('2026-10-09T00:00:00Z'), clearedRules: ['intl_messaging_app_only'] },
    ];
    const seen: unknown[] = [];
    const db = {
      ...fakeDb().db,
      rAJobReview: {
        findFirst: async (args: { where: { jobId: string; decision: string }; orderBy: { at: 'desc' }; select: unknown }) => {
          seen.push(args);
          const rows = reviews.filter((r) => r.jobId === args.where.jobId && r.decision === args.where.decision).sort((a, b) => b.at.getTime() - a.at.getTime());
          return rows[0] ? { clearedRules: rows[0].clearedRules } : null;
        },
      },
    };
    const repo = createPrismaEnrichRepository(db as never);
    expect(await repo.clearedScamRules!('j1')).toEqual(['intl_fee_required']);
    expect(await repo.clearedScamRules!('other')).toEqual(['intl_messaging_app_only']);
    expect(await repo.clearedScamRules!('never_reviewed')).toEqual([]);
    expect(seen[0]).toEqual({ where: { jobId: 'j1', decision: 'restore' }, orderBy: { at: 'desc' }, select: { clearedRules: true } });
  });

  it('writes one ra_job_enrich cost row', async () => {
    const { db, calls } = fakeDb();
    await createPrismaEnrichRepository(db).logCost({
      userId: 'sys',
      jobId: 'j1',
      brand: 'roboapply',
      market: 'intl',
      model: 'm',
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 0.002,
      requestId: 'r1',
    });
    expect(calls.create![0]).toMatchObject({
      data: {
        userId: 'sys',
        sku: ENRICH_COST_SKU,
        source: 'free_tier',
        units: 1,
        platformCostUsd: 0.002,
        requestId: 'r1',
        relatedEntityType: 'job',
        relatedEntityId: 'j1',
        metadata: { brand: 'roboapply', market: 'intl', model: 'm', promptTokens: 10, completionTokens: 5 },
      },
    });
    expect(ENRICH_COST_SKU).toBe('ra_job_enrich');
  });

  it('FIX-3: a system user id that names no account is one warning, then skipped (not an ERROR per job)', async () => {
    resetMissingCostUsersForTests();
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.warn).mockClear();
    const fk = Object.assign(new Error('Foreign key constraint violated on the constraint: `UsageDeductionLog_userId_fkey`'), { code: 'P2003', meta: { constraint: 'UsageDeductionLog_userId_fkey' } });
    const create = vi.fn(async () => Promise.reject(fk));
    const { db } = fakeDb({ create });
    const repo = createPrismaEnrichRepository(db);
    const entry = { userId: 'system_cron_ra_v2', brand: 'roboapply', market: 'intl', model: 'm', promptTokens: 1, completionTokens: 1, costUsd: 0.001, requestId: null } as const;
    for (let i = 0; i < 10; i++) await expect(repo.logCost({ ...entry, jobId: `j${i}` })).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(logger.warn).mock.calls[0]![1])).toMatch(/RA_SYSTEM_USER_ID/);
    // The database is asked once, not once per job.
    expect(create).toHaveBeenCalledTimes(1);
    // Another (real) user is unaffected.
    const ok = fakeDb();
    await createPrismaEnrichRepository(ok.db).logCost({ ...entry, userId: 'real_user', jobId: 'j1' });
    expect(ok.calls.create).toHaveLength(1);
    resetMissingCostUsersForTests();
  });

  it('never throws when the cost row cannot be written', async () => {
    const { db } = fakeDb({ create: async () => Promise.reject(new Error('FK violation')) });
    await expect(
      createPrismaEnrichRepository(db).logCost({
        userId: 'missing',
        jobId: 'j1',
        brand: 'roboapply',
        market: 'intl',
        model: 'm',
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        requestId: null,
      }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
