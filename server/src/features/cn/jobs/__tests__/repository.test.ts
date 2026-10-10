// @vitest-environment node
// WP-41 / WP-93: the GoApply fraud check logs its model cost under its own
// SKU, `ra_cn_fraud_check` (registered in raFeatureCatalog.ts and the
// DeductionSku union), not under job enrichment.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { CLONE_SKUS, PLATFORM_SKUS, featureForSku } from '../../../../roboapply/v2/lib/raFeatureCatalog.js';
import { ENRICH_COST_SKU } from '../../../jobs/enrich/repository.js';
import { FRAUD_COST_SKU, createPrismaCnJobsRepository } from '../repository.js';

const entry = { userId: 'sys_goapply', jobId: 'job_1', model: 'deepseek-chat', promptTokens: 800, completionTokens: 60, costUsd: 0.0004, requestId: 'req-1' };

describe('fraud-check cost rows', () => {
  it('are written under ra_cn_fraud_check: one unit, platform-paid, tied to the job', async () => {
    const created: unknown[] = [];
    const db = { usageDeductionLog: { create: async (args: unknown) => (created.push(args), { id: 'log_1' }) } };
    await createPrismaCnJobsRepository(async () => db as never).logCost(entry);
    expect(created).toEqual([
      {
        data: {
          userId: 'sys_goapply',
          sku: 'ra_cn_fraud_check',
          source: 'free_tier',
          units: 1,
          platformCostUsd: 0.0004,
          requestId: 'req-1',
          relatedEntityType: 'job',
          relatedEntityId: 'job_1',
          metadata: { task: 'cn_fraud_check', brand: 'goapply', market: 'cn', model: 'deepseek-chat', promptTokens: 800, completionTokens: 60 },
        },
        select: { id: true },
      },
    ]);
  });

  it('the SKU is registered: its own feature, a platform cost, and no longer the enrichment SKU', () => {
    expect(FRAUD_COST_SKU).toBe('ra_cn_fraud_check');
    expect(FRAUD_COST_SKU).not.toBe(ENRICH_COST_SKU);
    expect(CLONE_SKUS).toContain(FRAUD_COST_SKU);
    expect(PLATFORM_SKUS.has(FRAUD_COST_SKU)).toBe(true);
    expect(featureForSku(FRAUD_COST_SKU).key).toBe('job_fraud_check');
  });

  it('a failed audit write never fails the check', async () => {
    const db = { usageDeductionLog: { create: async () => Promise.reject(new Error('db down')) } };
    await expect(createPrismaCnJobsRepository(async () => db as never).logCost(entry)).resolves.toBeUndefined();
  });
});
