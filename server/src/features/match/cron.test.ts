// @vitest-environment node
// WP-18 — score-precompute cron and the job.score worker.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../platform/brand/registry.js';
import { DeferWorkError, createBudget, type EnqueuedItem, type LeasedWorkItem } from '../../platform/queue/index.js';
import type { RateLimitResult } from '../../platform/ratelimit/index.js';
import { SCORER_PROMPT_VERSION } from './contract.js';
import { createScorePrecompute, type PrecomputeDeps } from './cron.js';
import { createMatchService } from './MatchService.js';
import { createMemoryRepo, jobRecord } from './testkit.js';
import { createJobScoreHandler, MATCH_WORK_KINDS, workers } from './workers.js';

const NOW = new Date('2026-10-10T08:00:00Z');
const MODEL = 'test/model-a';

function counters(limits: Record<string, number> = {}) {
  const counts = new Map<string, number>();
  const consume = vi.fn(async ({ key, windows, cost = 1 }: { key: string; windows: readonly { limit: number }[]; cost?: number }): Promise<RateLimitResult> => {
    const next = (counts.get(key) ?? 0) + cost;
    counts.set(key, next);
    const limit = limits[key] ?? windows[0]!.limit;
    return { allowed: next <= limit, retryAfterSec: 0, remaining: Math.max(0, limit - next), windows: [] };
  });
  return { consume, counts };
}

function setup(
  opts: {
    jobs?: number;
    perUser?: string;
    budget?: string;
    aiAllowed?: boolean;
    users?: number;
    brand?: 'roboapply' | 'goapply';
    model?: string;
    realPolicy?: boolean;
    /** The ids the feed preview lists for a user (default: every seeded job, in order). */
    preview?: (userId: string) => string[];
    /** GoApply recruitment-info mode (default: postings allowed, so a GoApply run has candidates). */
    cnMode?: 'off' | 'partner_deeplink' | 'licensed';
  } = {},
) {
  const brandId = opts.brand ?? 'roboapply';
  const model = opts.model ?? MODEL;
  const routeAllowed = opts.realPolicy ? undefined : () => true;
  const jobs = Array.from({ length: opts.jobs ?? 30 }, (_, i) => jobRecord({ id: `job${i}`, skills: i % 2 ? ['typescript'] : ['typescript', 'go'] }));
  const repo = createMemoryRepo({
    jobs: brandId === 'goapply' ? jobs.map((j) => ({ ...j, market: 'cn' as const })) : jobs,
    active: Array.from({ length: opts.users ?? 1 }, (_, i) => ({ id: i === 0 ? 'u1' : `u${i + 1}`, brand: brandId, lastActiveAt: new Date(NOW.getTime() - 3600_000 * (i + 1)) })),
  });
  const { consume, counts } = counters();
  const env = { SCORE_PRECOMPUTE_PER_USER_DAY: opts.perUser, SCORE_DAILY_BUDGET: opts.budget, CN_RECRUITMENT_INFO_MODE: opts.cnMode ?? 'partner_deeplink' };
  const candidateIds = vi.fn(async (userId: string, limit: number) => (opts.preview ? opts.preview(userId) : jobs.map((j) => j.id)).slice(0, limit));
  const service = createMatchService({ repo, resolveModel: () => model, routeAllowed, aiAllowed: async () => true, consume, brand: () => getBrand(brandId), env, now: () => NOW });
  const enqueued: Array<{ kind: string; payload: unknown; options: Record<string, unknown> }> = [];
  const enqueue = vi.fn(async (kind: string, payload: unknown, options: Record<string, unknown>): Promise<EnqueuedItem> => {
    const dup = enqueued.some((e) => e.options.dedupeKey === options.dedupeKey);
    if (!dup) enqueued.push({ kind, payload, options });
    return { id: String(enqueued.length), kind, status: 'queued', dedupeKey: String(options.dedupeKey), created: !dup };
  });
  const aiAllowed = vi.fn(async () => opts.aiAllowed ?? true);
  const deps: PrecomputeDeps = { service, repo, aiAllowed, resolveModel: async () => model, routeAllowed, consume, enqueue: enqueue as never, candidateIds, env };
  const task = createScorePrecompute(async () => deps);
  const ctx = { name: 'score-precompute', brand: getBrand(brandId), budget: createBudget(240_000), now: NOW };
  return { task, ctx, repo, enqueued, counts, aiAllowed, consume, candidateIds };
}

describe('score-precompute', () => {
  it('queues the best pre-scores up to SCORE_PRECOMPUTE_PER_USER_DAY (default 25), once per day', async () => {
    const s = setup();
    const r = await s.task(s.ctx);
    expect(r).toMatchObject({ processed: 1, enqueued: 25 });
    expect(s.enqueued).toHaveLength(25);
    expect(s.enqueued[0]).toMatchObject({ kind: MATCH_WORK_KINDS.jobScore, payload: { userId: 'u1', resumeVariantId: 'v1' }, options: { userId: 'u1', brand: 'roboapply' } });
    // Higher pre-score first: even ids have both skills.
    expect((s.enqueued[0]!.payload as { jobId: string }).jobId).toMatch(/^job\d*[02468]$/);
    const again = await s.task(s.ctx);
    expect(again).toMatchObject({ enqueued: 0 });
  });

  it('GoApply with an international scorer model: skips the run, queues nothing (brand LLM policy, R-13)', async () => {
    const s = setup({ brand: 'goapply', model: 'openrouter/openai/gpt-5.6-luna', realPolicy: true });
    expect(await s.task(s.ctx)).toEqual({ skipped: 'ai_unavailable' });
    expect(s.enqueued).toHaveLength(0);
    expect(s.consume).not.toHaveBeenCalled();

    const domestic = setup({ brand: 'goapply', model: 'deepseek/deepseek-chat', realPolicy: true, perUser: '2' });
    expect(await domestic.task(domestic.ctx)).toMatchObject({ enqueued: 2 });
  });

  it('respects a smaller per-user cap and the brand budget', async () => {
    const small = setup({ perUser: '3' });
    expect(await small.task(small.ctx)).toMatchObject({ enqueued: 3 });

    const budget = setup({ budget: '2', users: 3 });
    const r = await budget.task(budget.ctx);
    expect(r).toMatchObject({ enqueued: 2 });
    const spent = setup({ budget: '0' });
    expect(await spent.task(spent.ctx)).toEqual({ skipped: 'budget' });
  });

  it('skips jobs that already have a fresh AI score', async () => {
    const s = setup({ jobs: 3 });
    s.repo.state.scores.push({
      userId: 'u1', jobId: 'job0', resumeVariantId: 'v1', score: 80, explanation: {}, resumeContentHashAtScore: 'hash-1', modelUsed: MODEL,
      generatedAt: NOW, scoreKind: 'ai', tier: 'great', dimensions: [], promptVersion: SCORER_PROMPT_VERSION, locale: 'en', searchProfileVersion: 1,
    });
    await s.task(s.ctx);
    expect(s.enqueued.map((e) => (e.payload as { jobId: string }).jobId).sort()).toEqual(['job1', 'job2']);
  });

  it('candidates are exactly the ids the feed preview lists for the user (WP-93 #25): nothing outside it is queued', async () => {
    // 30 jobs exist; the feed lists only these four for u1 (their search, order and visibility rules).
    const s = setup({ preview: () => ['job7', 'job3', 'job20', 'job11'] });
    expect(await s.task(s.ctx)).toMatchObject({ processed: 1, enqueued: 4 });
    expect(s.candidateIds).toHaveBeenCalledTimes(1);
    expect(s.candidateIds).toHaveBeenCalledWith('u1', 50, expect.objectContaining({ id: 'roboapply' }));
    expect(s.enqueued.map((e) => (e.payload as { jobId: string }).jobId).sort()).toEqual(['job11', 'job20', 'job3', 'job7']);
  });

  it('an id the feed lists but the job table no longer has is skipped; an empty preview queues nothing', async () => {
    const gone = setup({ preview: () => ['job1', 'deleted_job', 'job2'] });
    await gone.task(gone.ctx);
    expect(gone.enqueued.map((e) => (e.payload as { jobId: string }).jobId).sort()).toEqual(['job1', 'job2']);

    // A GoApply user without 个性化推荐 (or a brand that may not show postings) has an empty preview.
    const none = setup({ preview: () => [] });
    expect(await none.task(none.ctx)).toMatchObject({ processed: 1, enqueued: 0 });
    expect(none.enqueued).toHaveLength(0);
  });

  it('one user whose feed preview throws does not end the run: the next user is still queued, and the failure is counted', async () => {
    const s = setup({
      users: 3,
      perUser: '2',
      preview: (userId) => {
        // u1 is read first every run (most recently active).
        if (userId === 'u1') throw new Error('preview failed: profile load');
        return ['job1', 'job2', 'job3'];
      },
    });
    // u2 and u3 have a resume and a profile like u1.
    for (const id of ['u2', 'u3']) {
      s.repo.state.resumes.push({ ...s.repo.state.resumes[0]!, userId: id });
      s.repo.state.users[id] = s.repo.state.users.u1!;
    }
    const r = await s.task(s.ctx);
    expect(r).toMatchObject({ processed: 3, enqueued: 4, failed: 1 });
    expect(s.candidateIds).toHaveBeenCalledTimes(3);
    const byUser = s.enqueued.map((e) => (e.payload as { userId: string }).userId);
    expect(byUser.filter((u) => u === 'u1')).toHaveLength(0);
    expect(byUser.filter((u) => u === 'u2')).toHaveLength(2);
    expect(byUser.filter((u) => u === 'u3')).toHaveLength(2);
    // The failing user was charged nothing; a clean run reports no failures.
    expect([...s.counts.entries()].filter(([k]) => k.includes('u1')).every(([, n]) => n === 0)).toBe(true);
    const clean = setup();
    expect(await clean.task(clean.ctx)).toMatchObject({ failed: 0 });
  });

  it('GoApply with recruitment-info mode off: a third-party posting is never queued for scoring (R-14)', async () => {
    const s = setup({ brand: 'goapply', model: 'deepseek/deepseek-chat', realPolicy: true, cnMode: 'off' });
    expect(await s.task(s.ctx)).toMatchObject({ enqueued: 0 });
    expect(s.enqueued).toHaveLength(0);
  });

  it('GoApply users without AI consent are skipped (zero model work queued)', async () => {
    const s = setup({ aiAllowed: false });
    expect(await s.task(s.ctx)).toMatchObject({ enqueued: 0, skippedConsent: 1 });
  });

  it('answers quickly when idle or when no model is configured', async () => {
    const s = setup({ users: 0 });
    expect(await s.task(s.ctx)).toMatchObject({ skipped: 'no_work' });
    const noModel = createScorePrecompute(async () => ({ resolveModel: async () => null }) as unknown as PrecomputeDeps);
    expect(await noModel(s.ctx)).toEqual({ skipped: 'ai_unavailable' });
  });
});

describe('job.score worker', () => {
  function item(payload: unknown): LeasedWorkItem<unknown> {
    return { id: 'w1', kind: 'job.score', brand: 'roboapply', userId: 'u1', payload, attempts: 1, maxAttempts: 5, dedupeKey: null, priority: 200 };
  }

  it('is registered for job.score', () => {
    expect(workers.map((w) => w.kind)).toEqual(['job.score']);
  });

  it('scores in precompute mode; a spent budget defers to tomorrow; a gone job is done', async () => {
    const scoreJob = vi.fn(async () => ({ estimateReason: null }));
    const handler = createJobScoreHandler(async () => ({ scoreJob }) as never, () => NOW);
    await handler(item({ userId: 'u1', jobId: 'job1', resumeVariantId: 'v1' }), {} as never);
    expect(scoreJob).toHaveBeenCalledWith('u1', 'job1', { resumeVariantId: 'v1', mode: 'precompute', onAiFailure: 'throw' });

    scoreJob.mockResolvedValueOnce({ estimateReason: 'budget' });
    await expect(handler(item({ userId: 'u1', jobId: 'job1' }), {} as never)).rejects.toBeInstanceOf(DeferWorkError);

    scoreJob.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'not_found' }));
    await expect(handler(item({ userId: 'u1', jobId: 'job1' }), {} as never)).resolves.toBeUndefined();

    scoreJob.mockRejectedValueOnce(new Error('fit scorer failed'));
    await expect(handler(item({ userId: 'u1', jobId: 'job1' }), {} as never)).rejects.toThrow('fit scorer failed');

    await handler(item({ nope: true }), {} as never);
    expect(scoreJob).toHaveBeenCalledTimes(4);
  });
});
