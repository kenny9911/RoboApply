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
import { ENRICH_CONCURRENCY, JOBS_ENRICH_WORK_KINDS, jobEnrichWorker, setEnrichDepsForTests, workers } from './workers.js';
import { enqueueJobEnrich } from './index.js';
import { enrichDedupeKey, type EnrichDeps } from './service.js';
import { ENRICH_VERSION } from './schema.js';
import { fakeSkillsPort, makeJob } from './__tests__/fixtures.js';
import type { EnrichUpdate } from './reconcile.js';
import { RETRIEVAL_WORK_KINDS, retrievalWorkers } from '../../retrieval/index.js';

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
  it('registers the job.enrich handler with concurrency 10, and the retrieval kinds through the same array', () => {
    // The queue registry imports this array, so job.index and user.embed (features/retrieval) need no registry edit.
    expect(workers.map((w) => w.kind)).toEqual(['job.enrich', 'job.index', 'user.embed']);
    expect(workers[0]).toBe(jobEnrichWorker);
    expect(workers.slice(1)).toEqual(retrievalWorkers);
    // Every registered kind is declared by this area (server/src/test/areaStubs.test.ts), with the retrieval area's own strings.
    expect(Object.values(JOBS_ENRICH_WORK_KINDS)).toEqual(workers.map((w) => w.kind));
    expect(JOBS_ENRICH_WORK_KINDS).toMatchObject(RETRIEVAL_WORK_KINDS);
    expect(workers.slice(1).every((w) => w.concurrency === 4)).toBe(true);
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

  it('version 3: a row at version 2 is enriched by the item jobs-maintain queues (no `force`); delivered again it does nothing', async () => {
    const row = makeJob({ skills: ['postgres', 'python'], enrichedAt: new Date('2026-09-01T00:00:00.000Z'), enrichVersion: 2, enrichModel: 'openai/gpt-cheap' });
    const saves: EnrichUpdate[] = [];
    const indexed: string[] = [];
    const vocab = fakeSkillsPort();
    const d = deps({
      repo: {
        loadJob: async () => ({ ...row }),
        saveJob: async (_id, update) => {
          saves.push(update);
          Object.assign(row, update);
        },
        saveKeywords: async () => undefined,
        logCost: async () => undefined,
      },
      skills: vocab.port,
      enqueueIndex: async (ref) => {
        indexed.push(ref.id);
      },
    });
    setEnrichDepsForTests(d);
    await expect(jobEnrichWorker.handler(item({ jobId: 'job_1' }), ctx)).resolves.toBeUndefined();
    expect(d.llm.chatWithUsage).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ enrichVersion: 3, skillIds: ['postgresql', 'python'] });
    // The request id of the work item reaches the vocabulary call (one per job).
    expect(vocab.calls).toEqual([{ terms: ['postgres', 'python'], options: { brand: 'roboapply', write: true, requestId: 'job-enrich-w1' } }]);
    expect(indexed).toEqual(['job_1']);
    // The item delivered a second time: the row is at version 3.
    await expect(jobEnrichWorker.handler(item({ jobId: 'job_1' }), ctx)).resolves.toBeUndefined();
    expect(d.llm.chatWithUsage).toHaveBeenCalledTimes(1);
    expect(saves).toHaveLength(1);
    expect(indexed).toEqual(['job_1']);
    expect(ENRICH_VERSION).toBe(3);
    expect(enrichDedupeKey('job_1')).toBe('job.enrich:job_1:v3');
  });
});

describe('job.enrich worker: a skills-only item', () => {
  it('maps the skills of a row at the current version without a model call, and completes', async () => {
    const row = makeJob({
      skills: ['postgres', 'made-up tool'],
      skillsDetail: [
        { skill: 'postgres', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias' },
        { skill: 'made-up tool', kind: 'hard', required: false, skillId: null, via: 'none' },
      ],
      skillIds: ['postgresql'],
      enrichedAt: new Date('2026-10-01T00:00:00.000Z'),
      enrichVersion: ENRICH_VERSION,
      enrichModel: 'openai/gpt-cheap',
    });
    const saves: EnrichUpdate[] = [];
    const indexed: string[] = [];
    const vocab = fakeSkillsPort();
    const d = deps({
      repo: {
        loadJob: async () => ({ ...row }),
        saveJob: async (_id, update) => {
          saves.push(update);
          Object.assign(row, update);
        },
        saveKeywords: async () => undefined,
        logCost: async () => undefined,
      },
      budget: async () => Promise.reject(new Error('the budget is not read')),
      skills: vocab.port,
      enqueueIndex: async (ref) => {
        indexed.push(ref.id);
      },
    });
    setEnrichDepsForTests(d);
    await expect(jobEnrichWorker.handler(item({ jobId: 'job_1', skillsOnly: true }), ctx)).resolves.toBeUndefined();
    expect(d.llm.chatWithUsage).not.toHaveBeenCalled();
    expect(vocab.calls).toEqual([{ terms: ['postgres', 'made-up tool'], options: { brand: 'roboapply', write: true, requestId: 'job-enrich-w1' } }]);
    expect(row).toMatchObject({ skillIds: ['postgresql', 'madeuptool'], enrichVersion: ENRICH_VERSION, enrichModel: 'openai/gpt-cheap', enrichedAt: new Date('2026-10-01T00:00:00.000Z') });
    expect(saves).toHaveLength(1);
    expect(indexed).toEqual(['job_1']);
    // The plain item for the same row still does nothing.
    await expect(jobEnrichWorker.handler(item({ jobId: 'job_1' }), ctx)).resolves.toBeUndefined();
    expect(saves).toHaveLength(1);
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
