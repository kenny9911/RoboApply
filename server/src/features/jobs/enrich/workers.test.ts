// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../lib/modelPricing.js', () => ({ calculateModelCost: vi.fn(() => 0) }));

import { DeferWorkError, PermanentWorkError, createBudget, enqueue, type LeasedWorkItem, type QueueDb } from '../../../platform/queue/index.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { ENRICH_CONCURRENCY, jobEnrichWorker, setEnrichDepsForTests, workers } from './workers.js';
import { enqueueJobEnrich } from './index.js';
import { enrichDedupeKey, type EnrichDeps } from './service.js';
import { ENRICH_VERSION } from './schema.js';
import { makeJob } from './__tests__/fixtures.js';

const ctx = { budget: createBudget(60_000), leaseOwner: 'test' };

function item(payload: Prisma.JsonValue, attempts = 1): LeasedWorkItem {
  return { id: 'w1', kind: 'job.enrich', brand: 'roboapply', userId: null, payload, attempts, maxAttempts: 5, dedupeKey: null, priority: 100 };
}

function deps(overrides: Partial<EnrichDeps> = {}): EnrichDeps {
  const job = makeJob();
  return {
    repo: { loadJob: async () => job, saveJob: async () => undefined, saveKeywords: async () => undefined, logCost: async () => undefined },
    llm: { chatWithUsage: vi.fn(async () => ({ content: '{}', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, model: 'm' })) },
    budget: async () => ({ allowed: true, retryAfterSec: 0, limit: 1 }),
    aiAllowed: async () => true,
    afterEnrich: async () => undefined,
    // A default model on the shared stack: without one enrichment finishes rules only before the budget is read.
    env: { LLM_MODEL: 'stack-default-model' },
    now: () => new Date('2026-10-10T00:00:00.000Z'),
    ...overrides,
  };
}

afterEach(() => setEnrichDepsForTests(null));

describe('job.enrich worker', () => {
  it('registers one job.enrich handler with concurrency 10', () => {
    expect(workers).toEqual([jobEnrichWorker]);
    expect(jobEnrichWorker.kind).toBe('job.enrich');
    expect(jobEnrichWorker.concurrency).toBe(ENRICH_CONCURRENCY);
    expect(ENRICH_CONCURRENCY).toBe(10);
  });

  it('marks an invalid payload dead at once', async () => {
    await expect(jobEnrichWorker.handler(item({ nope: true }), ctx)).rejects.toBeInstanceOf(PermanentWorkError);
  });

  it('turns an over-budget outcome into a deferral that spends no attempt', async () => {
    setEnrichDepsForTests(deps({ budget: async () => ({ allowed: false, retryAfterSec: 120, limit: 1 }) }));
    const err = await jobEnrichWorker.handler(item({ jobId: 'job_1' }), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeferWorkError);
    expect((err as DeferWorkError).delayMs).toBe(120_000);
  });

  it('passes the attempt number through and completes', async () => {
    const d = deps();
    setEnrichDepsForTests(d);
    await expect(jobEnrichWorker.handler(item({ jobId: 'job_1' }), ctx)).resolves.toBeUndefined();
    expect(d.llm.chatWithUsage).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueJobEnrich (idempotent via dedupeKey)', () => {
  function db() {
    return createFakePrisma({ uniqueFields: { rAWorkItem: ['dedupeKey'] }, defaults: { rAWorkItem: { status: 'queued', attempts: 0 } } });
  }
  const asDb = (fake: ReturnType<typeof db>) => fake as unknown as QueueDb;

  it('enqueues once per job per version, on the brand of the job market', async () => {
    const fake = db();
    const first = await enqueueJobEnrich('j1', { market: 'cn', db: asDb(fake) });
    const second = await enqueueJobEnrich('j1', { market: 'cn', db: asDb(fake) });
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ id: first.id, created: false });
    expect(fake.$rows('rAWorkItem')).toHaveLength(1);
    expect(fake.$rows('rAWorkItem')[0]).toMatchObject({
      kind: 'job.enrich',
      brand: 'goapply',
      dedupeKey: `job.enrich:j1:v${ENRICH_VERSION}`,
      payload: { jobId: 'j1' },
    });
  });

  it('puts a finished item back with force when the job changed', async () => {
    const fake = createFakePrisma({
      uniqueFields: { rAWorkItem: ['dedupeKey'] },
      seed: { rAWorkItem: [{ id: 'w_done', kind: 'job.enrich', status: 'done', dedupeKey: enrichDedupeKey('j2'), attempts: 1, payload: { jobId: 'j2' } }] },
    });
    const result = await enqueueJobEnrich('j2', { changed: true, brand: 'roboapply', db: asDb(fake) });
    expect(result).toMatchObject({ id: 'w_done', status: 'queued', created: false });
    expect(fake.$rows('rAWorkItem')[0]).toMatchObject({ status: 'queued', payload: { jobId: 'j2', force: true }, attempts: 0 });
  });

  it('uses the same kind and key the generic enqueue would', async () => {
    const fake = db();
    await enqueue('job.enrich', { jobId: 'j3' }, { dedupeKey: enrichDedupeKey('j3'), brand: 'roboapply', db: asDb(fake) });
    const again = await enqueueJobEnrich('j3', { brand: 'roboapply', db: asDb(fake) });
    expect(again.created).toBe(false);
  });
});
