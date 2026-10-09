// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../services/LoggerService.js', () => ({ logger }));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { Prisma } from '../../../generated/prisma/client.js';
import { ENRICH_COST_SKU, createPrismaEnrichRepository, toJobUpdateData, type EnrichDb } from './repository.js';

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
