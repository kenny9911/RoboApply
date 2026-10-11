// @vitest-environment node
// WP-18, MKT-4G — score-precompute cron and the job.score worker: the feed's order, the current scorer pin, the
// per-user and brand budgets. Nothing here calls a model: the cron only queues.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../platform/brand/registry.js';
import {
  DeferWorkError,
  PermanentWorkError,
  createBudget,
  drain,
  enqueue as platformEnqueue,
  registerWorker,
  resetWorkerRegistryForTests,
  type EnqueuedItem,
  type LeasedWorkItem,
  type QueueDb,
} from '../../platform/queue/index.js';
import type { RateLimitResult } from '../../platform/ratelimit/index.js';
import { calibrationFor, parseCalibrationDoc, CALIBRATION_CONFIG_KEY } from './calibration.js';
import { composeScorePrecompute, createCalibrationRefresh, createRetrievalSweepStep, createScorePrecompute, type PrecomputeDeps } from './cron.js';
import { scoreCounterKeys } from './config.js';
import { currentJobHash } from './jobHash.js';
import type { RAJobMatchScorerV4Output } from '../../roboapply/v2/agents/RAJobMatchScorerAgent.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { ScorerFailedError, createMatchService, type ScorerV4Like } from './MatchService.js';
import type { ScoreRecord } from './repo.js';
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
    /** The brand LLM-route policy's verdict for the scorer model (default: allowed). */
    routeVerdict?: boolean;
    /** The ids the feed preview lists for a user (default: every seeded job, in order). */
    preview?: (userId: string) => string[];
    /** GoApply recruitment-info mode. Default: not set, which allows postings (D5), so a GoApply run has candidates. */
    cnMode?: 'off' | 'partner_deeplink' | 'licensed';
    /** MATCH_SCORER_RUBRIC / CN_MATCH_SCORER_RUBRIC. Default: not set, which pins scorer v4. */
    rubric?: string;
    cnRubric?: string;
    /** Seeded job rows (default: `jobs` rows that list one or two skills). */
    rows?: ReturnType<typeof jobRecord>[];
    /** The repository of an earlier setup: the same people, jobs and stored scores under another configuration. */
    repo?: ReturnType<typeof createMemoryRepo>;
    /** The queue's own enqueue instead of the recording fake (the tests of a version switched and switched back). */
    enqueue?: PrecomputeDeps['enqueue'];
  } = {},
) {
  const brandId = opts.brand ?? 'roboapply';
  const model = opts.model ?? MODEL;
  const routeAllowed = () => opts.routeVerdict ?? true;
  const jobs = opts.rows ?? Array.from({ length: opts.jobs ?? 30 }, (_, i) => jobRecord({ id: `job${i}`, skills: i % 2 ? ['typescript'] : ['typescript', 'go'] }));
  const repo =
    opts.repo ??
    createMemoryRepo({
      jobs: brandId === 'goapply' ? jobs.map((j) => ({ ...j, market: 'cn' as const })) : jobs,
      active: Array.from({ length: opts.users ?? 1 }, (_, i) => ({ id: i === 0 ? 'u1' : `u${i + 1}`, brand: brandId, lastActiveAt: new Date(NOW.getTime() - 3600_000 * (i + 1)) })),
    });
  const { consume, counts } = counters();
  const env = {
    SCORE_PRECOMPUTE_PER_USER_DAY: opts.perUser,
    SCORE_DAILY_BUDGET: opts.budget,
    ...(opts.cnMode ? { CN_RECRUITMENT_INFO_MODE: opts.cnMode } : {}),
    ...(opts.rubric ? { MATCH_SCORER_RUBRIC: opts.rubric } : {}),
    ...(opts.cnRubric ? { CN_MATCH_SCORER_RUBRIC: opts.cnRubric } : {}),
  };
  const candidateIds = vi.fn(async (userId: string, limit: number) => (opts.preview ? opts.preview(userId) : jobs.map((j) => j.id)).slice(0, limit));
  const service = createMatchService({ repo, resolveModel: () => model, routeAllowed, aiAllowed: async () => true, consume, brand: () => getBrand(brandId), env, now: () => NOW });
  const enqueued: Array<{ kind: string; payload: unknown; options: Record<string, unknown> }> = [];
  const enqueue = vi.fn(async (kind: string, payload: unknown, options: Record<string, unknown>): Promise<EnqueuedItem> => {
    const dup = enqueued.some((e) => e.options.dedupeKey === options.dedupeKey);
    if (!dup) enqueued.push({ kind, payload, options });
    return { id: String(enqueued.length), kind, status: 'queued', dedupeKey: String(options.dedupeKey), created: !dup };
  });
  const aiAllowed = vi.fn(async () => opts.aiAllowed ?? true);
  const deps: PrecomputeDeps = { service, repo, aiAllowed, resolveModel: async () => model, routeAllowed, consume, enqueue: opts.enqueue ?? (enqueue as never), candidateIds, env };
  const task = createScorePrecompute(async () => deps);
  const ctx = { name: 'score-precompute', brand: getBrand(brandId), budget: createBudget(240_000), now: NOW };
  const queuedIds = () => enqueued.map((e) => (e.payload as { jobId: string }).jobId);
  return { task, ctx, repo, enqueued, queuedIds, counts, aiAllowed, consume, candidateIds };
}

/** A stored AI row of `u1` for a job of `s`, written under the default pin (scorer v4, the test model) for the posting as it is. */
function scoreRow(s: ReturnType<typeof setup>, jobId: string, over: Partial<ScoreRecord> = {}): ScoreRecord {
  return {
    userId: 'u1', jobId, resumeVariantId: 'v1', score: 80, explanation: {}, resumeContentHashAtScore: 'hash-1', modelUsed: MODEL,
    generatedAt: NOW, scoreKind: 'ai', tier: 'great', dimensions: [], promptVersion: 'scorer_v4', locale: 'en', searchProfileVersion: 1,
    jobContentHash: currentJobHash(s.repo.state.jobs.find((j) => j.id === jobId)!),
    rubricVersion: 'fit_v4',
    ...over,
  };
}

describe('score-precompute', () => {
  it('queues the first candidates of the feed up to SCORE_PRECOMPUTE_PER_USER_DAY (default 25), once per day', async () => {
    const s = setup();
    const r = await s.task(s.ctx);
    expect(r).toMatchObject({ processed: 1, enqueued: 25 });
    expect(s.enqueued).toHaveLength(25);
    expect(s.enqueued[0]).toMatchObject({ kind: MATCH_WORK_KINDS.jobScore, payload: { userId: 'u1', resumeVariantId: 'v1' }, options: { userId: 'u1', brand: 'roboapply' } });
    // The feed's own order, from its first candidate on.
    expect(s.queuedIds()).toEqual(Array.from({ length: 25 }, (_, i) => `job${i}`));
    // The payload names no scorer version: the worker scores with the pin of the moment it runs.
    expect(Object.keys(s.enqueued[0]!.payload as object).sort()).toEqual(['jobId', 'resumeVariantId', 'userId']);
    const again = await s.task(s.ctx);
    expect(again).toMatchObject({ enqueued: 0 });
  });

  it('the pick order is the order of the feed list, never a second sort by the estimate', async () => {
    // The feed lists the weaker estimate first (its own fused, ranked order): one skill of three, then all three,
    // then a posting the estimate cannot compare at all (no role, no skills: no estimate).
    const rows = [
      jobRecord({ id: 'weak', skills: ['kubernetes'], skillsDetail: null }),
      jobRecord({ id: 'strong', skills: ['typescript', 'go'], skillsDetail: null }),
      jobRecord({ id: 'unknown', title: 'Zzyzx Qwfp', taxonomyIds: [], primaryTaxonomyId: null, skills: [], skillsDetail: null }),
      jobRecord({ id: 'middle', skills: ['typescript', 'kubernetes'], skillsDetail: null }),
    ];
    const s = setup({ rows, preview: () => ['unknown', 'weak', 'middle', 'strong', 'weak'] });
    const estimates = new Map((await createMatchService({ repo: s.repo, resolveModel: () => MODEL, brand: () => getBrand('roboapply'), env: {}, now: () => NOW }).preScoreJobs('u1', rows)).map((p) => [p.jobId, p.score]));
    expect(estimates.get('unknown')).toBeNull();
    expect(estimates.get('strong')!).toBeGreaterThan(estimates.get('weak')!);
    expect(await s.task(s.ctx)).toMatchObject({ enqueued: 4 });
    // As listed, each job once; the posting with no estimate is queued like the others (the model can still judge it).
    expect(s.queuedIds()).toEqual(['unknown', 'weak', 'middle', 'strong']);

    // With a cap of two the first two of the feed are the ones queued, not the two best estimates.
    const capped = setup({ rows, preview: () => ['unknown', 'weak', 'middle', 'strong'], perUser: '2' });
    await capped.task(capped.ctx);
    expect(capped.queuedIds()).toEqual(['unknown', 'weak']);
    // The next day's allowance continues down the same list: what was scored is fresh and skipped.
    capped.repo.state.scores.push(scoreRow(capped, 'unknown'), scoreRow(capped, 'weak'));
    capped.counts.clear();
    await capped.task(capped.ctx);
    expect(capped.queuedIds()).toEqual(['unknown', 'weak', 'middle', 'strong']);
  });

  // Which routes a brand may use is the LLM policy's own rule (match/scorerRoute.ts and platform/llm, PAR-2: under
  // D5 GoApply uses the shared stack unless CN_LLM_DOMESTIC_ONLY is set). This area only has to follow its verdict.
  it('GoApply: a scorer model the brand LLM policy refuses skips the run and queues nothing; an allowed one is queued', async () => {
    const refused = setup({ brand: 'goapply', routeVerdict: false });
    expect(await refused.task(refused.ctx)).toEqual({ skipped: 'ai_unavailable' });
    expect(refused.enqueued).toHaveLength(0);
    expect(refused.consume).not.toHaveBeenCalled();

    // The shared model (no CN_ value anywhere) once the policy allows it: GoApply's public postings are queued, mode unset.
    const shared = setup({ brand: 'goapply', perUser: '2' });
    expect(await shared.task(shared.ctx)).toMatchObject({ enqueued: 2 });
    const domestic = setup({ brand: 'goapply', model: 'deepseek/deepseek-chat', perUser: '2' });
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
    s.repo.state.scores.push(scoreRow(s, 'job0', { jobContentHash: undefined }));
    await s.task(s.ctx);
    expect(s.queuedIds()).toEqual(['job1', 'job2']);
  });

  it('the planned backfill: a row of an older model, another prompt, another resume or an older posting is picked again, in feed order; a current one is not', async () => {
    const s = setup({ jobs: 7 });
    s.repo.state.scores.push(
      scoreRow(s, 'job0'), // current: the pinned model and prompt, the posting as it is
      scoreRow(s, 'job1', { modelUsed: 'test/model-old' }), // an older model
      scoreRow(s, 'job2', { promptVersion: 'scorer_v3', rubricVersion: 'fit_v3' }), // the previous scorer
      scoreRow(s, 'job3', { jobContentHash: 'hash-of-the-posting-before-it-changed' }), // the posting changed since
      scoreRow(s, 'job4', { jobContentHash: null }), // written before the hash column: counts as current
      scoreRow(s, 'job5', { resumeContentHashAtScore: 'hash-0' }), // scored for an earlier resume
      scoreRow(s, 'job6', { promptVersion: 'v2_jobs_score_v1', dimensions: null }), // a row of the legacy scorer
    );
    await s.task(s.ctx);
    // Nothing is invalidated in bulk: the stale rows are queued one by one, in the feed's order, within the budgets.
    expect(s.queuedIds()).toEqual(['job1', 'job2', 'job3', 'job5', 'job6']);
    expect(s.repo.state.scores).toHaveLength(7);

    // A changed posting gets its own queue item even when the same (person, job) was queued for the old version.
    const again = setup({ jobs: 1 });
    await again.task(again.ctx);
    const firstKey = again.enqueued[0]!.options.dedupeKey;
    again.repo.state.jobs[0] = { ...again.repo.state.jobs[0]!, qualifications: 'New requirements: Rust.' };
    again.counts.clear();
    await again.task(again.ctx);
    expect(again.enqueued).toHaveLength(2);
    expect(again.enqueued[1]!.options.dedupeKey).not.toBe(firstKey);
  });

  it('one pinned version per market: unset is scorer v4 on both brands; MATCH_SCORER_RUBRIC=fit_v3 makes v3 rows the fresh ones; CN_ overrides for GoApply alone', async () => {
    const rows = (s: ReturnType<typeof setup>) => s.repo.state.scores.push(scoreRow(s, 'job0'), scoreRow(s, 'job1', { promptVersion: 'scorer_v3', rubricVersion: 'fit_v3' }));

    const byDefault = setup({ jobs: 3 });
    rows(byDefault);
    await byDefault.task(byDefault.ctx);
    expect(byDefault.queuedIds()).toEqual(['job1', 'job2']);

    // The rollback: the v4 row is now the one to replace, the v3 row is current.
    const rollback = setup({ jobs: 3, rubric: 'fit_v3' });
    rows(rollback);
    await rollback.task(rollback.ctx);
    expect(rollback.queuedIds()).toEqual(['job0', 'job2']);
    // A queued item is keyed by the prompt too: the same person and job get a new item after the switch.
    const keyOf = (s: ReturnType<typeof setup>, jobId: string) => s.enqueued.find((e) => (e.payload as { jobId: string }).jobId === jobId)!.options.dedupeKey;
    expect(keyOf(rollback, 'job2')).not.toBe(keyOf(byDefault, 'job2'));

    // GoApply: the shared value applies when it has none of its own, and its own wins.
    const goShared = setup({ jobs: 3, brand: 'goapply', rubric: 'fit_v3' });
    rows(goShared);
    await goShared.task(goShared.ctx);
    expect(goShared.queuedIds()).toEqual(['job0', 'job2']);
    const goOwn = setup({ jobs: 3, brand: 'goapply', rubric: 'fit_v3', cnRubric: 'fit_v4' });
    rows(goOwn);
    await goOwn.task(goOwn.ctx);
    expect(goOwn.queuedIds()).toEqual(['job1', 'job2']);
    // RoboApply never reads the CN_ value.
    const roboIgnoresCn = setup({ jobs: 3, cnRubric: 'fit_v3' });
    rows(roboIgnoresCn);
    await roboIgnoresCn.task(roboIgnoresCn.ctx);
    expect(roboIgnoresCn.queuedIds()).toEqual(['job1', 'job2']);
  });

  it('after a model change a user\'s scored jobs are re-queued gradually: never more than the per-user allowance and the brand budget', async () => {
    const s = setup({ jobs: 30, perUser: '5', model: 'test/model-b' });
    // Every candidate was scored by the previous model.
    for (let i = 0; i < 30; i += 1) s.repo.state.scores.push(scoreRow(s, `job${i}`));
    expect(await s.task(s.ctx)).toMatchObject({ enqueued: 5 });
    expect(s.queuedIds()).toEqual(['job0', 'job1', 'job2', 'job3', 'job4']);
    // The same day: the allowance is spent and nothing more is queued; the other 25 rows keep serving as they are.
    expect(await s.task(s.ctx)).toMatchObject({ enqueued: 0 });
    expect(s.repo.state.scores).toHaveLength(30);

    const budget = setup({ jobs: 30, budget: '3', model: 'test/model-b' });
    for (let i = 0; i < 30; i += 1) budget.repo.state.scores.push(scoreRow(budget, `job${i}`));
    expect(await budget.task(budget.ctx)).toMatchObject({ enqueued: 3 });
    expect(budget.queuedIds()).toEqual(['job0', 'job1', 'job2']);
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

  it('GoApply with CN_RECRUITMENT_INFO_MODE=off: a third-party posting is never queued for scoring; with nothing set it is', async () => {
    const s = setup({ brand: 'goapply', cnMode: 'off' });
    expect(await s.task(s.ctx)).toMatchObject({ enqueued: 0 });
    expect(s.enqueued).toHaveLength(0);

    const byDefault = setup({ brand: 'goapply', perUser: '3' });
    expect(await byDefault.task(byDefault.ctx)).toMatchObject({ enqueued: 3 });
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

describe('score-precompute as the cron runs it: precompute, then the calibration refresh', () => {
  const refreshed = { map: 'stored' as const, pairs: 640 };

  it('runs calibration after precompute and reports both results', async () => {
    const order: string[] = [];
    const s = setup({ perUser: '2' });
    const precompute = vi.fn(async (ctx: typeof s.ctx) => {
      const r = await s.task(ctx);
      order.push('precompute');
      return r;
    });
    const refreshIfDue = vi.fn(async () => {
      order.push('calibration');
      return refreshed;
    });
    const task = composeScorePrecompute(precompute, createCalibrationRefresh(async () => ({ refreshIfDue })));
    const result = await task(s.ctx);
    expect(order).toEqual(['precompute', 'calibration']);
    expect(result).toMatchObject({ processed: 1, enqueued: 2, calibration: refreshed });
    // The refresh is for the cron's brand market, at the cron's time.
    expect(refreshIfDue).toHaveBeenCalledWith('intl', NOW);

    const cn = setup({ brand: 'goapply', perUser: '1' });
    const cnRefresh = vi.fn(async () => ({ skipped: 'not_due' as const }));
    expect(await composeScorePrecompute(cn.task, createCalibrationRefresh(async () => ({ refreshIfDue: cnRefresh })))(cn.ctx)).toMatchObject({ enqueued: 1, calibration: { skipped: 'not_due' } });
    expect(cnRefresh).toHaveBeenCalledWith('cn', NOW);
  });

  it('calibration still runs when precompute had nothing to do, calls no model, and its failure never fails the run', async () => {
    const idle = setup({ users: 0 });
    const refreshIfDue = vi.fn(async () => refreshed);
    expect(await composeScorePrecompute(idle.task, createCalibrationRefresh(async () => ({ refreshIfDue })))(idle.ctx)).toEqual({ skipped: 'no_work', processed: 0, calibration: refreshed });

    const failing = createCalibrationRefresh(async () => ({
      refreshIfDue: async () => {
        throw new Error('store down');
      },
    }));
    const s = setup({ perUser: '1' });
    expect(await composeScorePrecompute(s.task, failing)(s.ctx)).toMatchObject({ enqueued: 1, calibration: { skipped: 'failed' } });

    // With the time budget spent the refresh waits for the next run.
    const spent = { ...s.ctx, budget: createBudget(1) };
    await new Promise((r) => setTimeout(r, 5));
    const never = vi.fn(async () => refreshed);
    expect(await createCalibrationRefresh(async () => ({ refreshIfDue: never }))(spent)).toEqual({ skipped: 'no_time' });
    expect(never).not.toHaveBeenCalled();
  });

  it('end to end over the memory repo: pairs written by the scorer become the stored calibration of the market', async () => {
    const s = setup({ jobs: 3, perUser: '0' });
    // SYNTHETIC pairs: 600 AI rows that stored the estimate they were scored next to (AI about 0.6 × the estimate).
    const jobs = Array.from({ length: 600 }, (_, i) => jobRecord({ id: `p${i}` }));
    s.repo.state.jobs.push(...jobs);
    for (const [i, j] of jobs.entries()) {
      const estimate = 30 + (i % 60);
      s.repo.state.scores.push({
        userId: 'u1', jobId: j.id, resumeVariantId: 'v1', score: Math.round(estimate * 0.6), explanation: { estimateAtScore: { score: estimate, coverage: 0.8 } }, resumeContentHashAtScore: 'hash-1', modelUsed: MODEL,
        generatedAt: new Date(NOW.getTime() - 86_400_000), scoreKind: 'ai', tier: 'possible', dimensions: [{ key: 'skills', weight: 30, score: 41, status: 'scored', evidence: [] }], promptVersion: 'scorer_v4', locale: 'en', searchProfileVersion: 1,
      });
    }
    const calibration = calibrationFor(s.repo, { env: {}, now: () => NOW });
    const task = composeScorePrecompute(s.task, createCalibrationRefresh(async () => ({ refreshIfDue: (market, now) => calibration.refreshIfDue(market, now) })));
    expect(await task(s.ctx)).toMatchObject({ calibration: { map: 'stored', pairs: 600, priors: 'stored', priorsPairs: 600 } });
    const doc = parseCalibrationDoc(s.repo.state.config[CALIBRATION_CONFIG_KEY]);
    expect(doc.intl!.map!.knots.length).toBeGreaterThan(1);
    expect(doc.intl!.priors).toEqual({ skills: 41 });
    // The next run, 15 minutes later, leaves it alone.
    expect(await task({ ...s.ctx, now: new Date(NOW.getTime() + 15 * 60_000) })).toMatchObject({ calibration: { skipped: 'not_due' } });
    // No model was called for any of it (this setup has no scorer at all) and nothing was queued.
    expect(s.enqueued).toHaveLength(0);
  });
});

describe('score-precompute: the retrieval sweep is the third and last step (MKT-2H)', () => {
  const refreshed = { skipped: 'not_due' as const };

  it('runs after precompute and calibration, in that order, for the cron brand, and reports next to them', async () => {
    const order: string[] = [];
    const s = setup({ perUser: '2' });
    const precompute = async (ctx: typeof s.ctx) => {
      const r = await s.task(ctx);
      order.push('precompute');
      return r;
    };
    const calibration = createCalibrationRefresh(async () => ({
      refreshIfDue: async () => {
        order.push('calibration');
        return refreshed;
      },
    }));
    const sweep = vi.fn(async () => {
      order.push('retrieval');
      return { jobBatches: 2, jobsQueued: 100, usersQueued: 1 };
    });
    const result = await composeScorePrecompute(precompute, calibration, createRetrievalSweepStep(async () => ({ sweep })))(s.ctx);
    expect(order).toEqual(['precompute', 'calibration', 'retrieval']);
    expect(result).toMatchObject({ processed: 1, enqueued: 2, calibration: refreshed, retrieval: { jobBatches: 2, jobsQueued: 100, usersQueued: 1 } });
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith(s.ctx);
  });

  it('still runs when precompute had nothing to do or no scorer is available (indexing needs no scorer)', async () => {
    const sweep = vi.fn(async () => ({ jobBatches: 0 }));
    const step = createRetrievalSweepStep(async () => ({ sweep }));
    const calibration = createCalibrationRefresh(async () => ({ refreshIfDue: async () => refreshed }));
    const idle = setup({ users: 0 });
    expect(await composeScorePrecompute(idle.task, calibration, step)(idle.ctx)).toEqual({ skipped: 'no_work', processed: 0, calibration: refreshed, retrieval: { jobBatches: 0 } });
    const noModel = setup({ routeVerdict: false });
    expect(await composeScorePrecompute(noModel.task, calibration, step)(noModel.ctx)).toMatchObject({ skipped: 'ai_unavailable', retrieval: { jobBatches: 0 } });
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('is skipped when the time budget is gone, and its failure never fails the run', async () => {
    const s = setup({ perUser: '1' });
    const never = vi.fn(async () => ({ jobBatches: 1 }));
    const spent = { ...s.ctx, budget: createBudget(1) };
    await new Promise((r) => setTimeout(r, 5));
    expect(await createRetrievalSweepStep(async () => ({ sweep: never }))(spent)).toEqual({ skipped: 'no_time' });
    expect(never).not.toHaveBeenCalled();

    const failing = createRetrievalSweepStep(async () => ({
      sweep: async () => {
        throw new Error('queue down');
      },
    }));
    const calibration = createCalibrationRefresh(async () => ({ refreshIfDue: async () => refreshed }));
    expect(await composeScorePrecompute(s.task, calibration, failing)(s.ctx)).toMatchObject({ enqueued: 1, calibration: refreshed, retrieval: { skipped: 'failed' } });
  });

  it('without a retrieval step the composed task is the two-step one (callers that compose their own)', async () => {
    const s = setup({ perUser: '1' });
    const out = await composeScorePrecompute(s.task, createCalibrationRefresh(async () => ({ refreshIfDue: async () => refreshed })))(s.ctx);
    expect(out).toMatchObject({ enqueued: 1, calibration: refreshed });
    expect('retrieval' in out).toBe(false);
  });
});

/** The platform queue over an in-memory table: the real `enqueue`, with its dedupe key and its conflict rules. */
function memoryQueue() {
  const db = createFakePrisma({ uniqueFields: { rAWorkItem: ['dedupeKey'] }, defaults: { rAWorkItem: { status: 'queued', attempts: 0 } } });
  const enqueue: PrecomputeDeps['enqueue'] = (kind, payload, options) => platformEnqueue(kind, payload, { ...options, db: db as unknown as QueueDb, now: () => NOW });
  const items = () => db.$rows('rAWorkItem');
  const jobOf = (row: Record<string, unknown>) => (row.payload as { jobId: string }).jobId;
  /** What the drain does to an item that ran: done after a score, dead after a refused answer. */
  const settle = (status: 'done' | 'dead', only: (jobId: string) => boolean = () => true) => {
    for (const row of items()) if (row.status === 'queued' && only(jobOf(row))) Object.assign(row, { status, attempts: 1 });
  };
  const waiting = () => items().filter((r) => r.status === 'queued').map(jobOf);
  return { enqueue, items, settle, waiting, jobOf };
}

describe('score-precompute on the queue itself: one item per version of a pair must not block that pair, or the list behind it', () => {
  const v3 = { promptVersion: 'scorer_v3', rubricVersion: 'fit_v3' } as const;
  const ALL = ['job0', 'job1', 'job2'];

  it('fit_v4 -> fit_v3 -> fit_v4: the pairs scored in the first v4 period are queued again, on their finished items', async () => {
    const queue = memoryQueue();
    // The first v4 period: three candidates are queued, scored and stored.
    const first = setup({ jobs: 3, enqueue: queue.enqueue });
    expect(await first.task(first.ctx)).toMatchObject({ enqueued: 3 });
    queue.settle('done');
    first.repo.state.scores.push(...ALL.map((id) => scoreRow(first, id)));

    // The rollback: the v4 rows are stale and get items of their own (the key holds the prompt), which run too.
    const rollback = setup({ jobs: 3, rubric: 'fit_v3', enqueue: queue.enqueue, repo: first.repo });
    expect(await rollback.task(rollback.ctx)).toMatchObject({ enqueued: 3 });
    expect(queue.items()).toHaveLength(6);
    queue.settle('done');
    first.repo.state.scores.splice(0, 3, ...ALL.map((id) => scoreRow(first, id, v3)));

    // Back to v4. The v3 rows are stale, and the v4 key of each pair already exists as a FINISHED item. A plain
    // enqueue would hand that item back untouched for as long as it is kept (7 days), and the same three picks would
    // be taken again every 15 minutes. They are put back in the queue instead.
    const again = setup({ jobs: 3, enqueue: queue.enqueue, repo: first.repo });
    expect(await again.task(again.ctx)).toMatchObject({ enqueued: 3 });
    expect(queue.items()).toHaveLength(6);
    expect(queue.waiting()).toEqual(ALL);
    for (const row of queue.items().filter((r) => r.status === 'queued')) expect(row).toMatchObject({ attempts: 0, lastError: null });
    // The allowance was charged for what was really queued.
    expect(again.counts.get(scoreCounterKeys.precompute('roboapply', 'u1'))).toBe(3);
    // While they wait, a second run queues nothing more and charges nothing more.
    expect(await again.task(again.ctx)).toMatchObject({ enqueued: 0 });
    expect(again.counts.get(scoreCounterKeys.precompute('roboapply', 'u1'))).toBe(3);

    // The same after a model change and back (model A -> B -> A): the key holds the model.
    queue.settle('done');
    first.repo.state.scores.splice(0, 3, ...ALL.map((id) => scoreRow(first, id, { modelUsed: 'test/model-b' })));
    const modelBack = setup({ jobs: 3, enqueue: queue.enqueue, repo: first.repo });
    expect(await modelBack.task(modelBack.ctx)).toMatchObject({ enqueued: 3 });
    expect(queue.items()).toHaveLength(6);
  });

  it('a finished item whose pair HAS a fresh score is not touched; nothing is queued for it', async () => {
    const queue = memoryQueue();
    const s = setup({ jobs: 3, enqueue: queue.enqueue });
    await s.task(s.ctx);
    queue.settle('done');
    s.repo.state.scores.push(...ALL.map((id) => scoreRow(s, id)));
    const next = setup({ jobs: 3, enqueue: queue.enqueue, repo: s.repo });
    expect(await next.task(next.ctx)).toMatchObject({ enqueued: 0 });
    expect(queue.items().map((r) => r.status)).toEqual(['done', 'done', 'done']);
  });

  it('an item that already exists takes no slot: a dead one (its answer was refused) and one still waiting do not hold the head of the list', async () => {
    const queue = memoryQueue();
    const day1 = setup({ jobs: 6, perUser: '2', enqueue: queue.enqueue });
    expect(await day1.task(day1.ctx)).toMatchObject({ enqueued: 2 });
    expect(queue.waiting()).toEqual(['job0', 'job1']);
    // The worker refused job0's answer (dead for this version); job1 has not run yet.
    queue.settle('dead', (id) => id === 'job0');

    // The next day (a fresh allowance). The first two candidates of the feed are still the same two.
    const day2 = setup({ jobs: 6, perUser: '2', enqueue: queue.enqueue, repo: day1.repo });
    expect(await day2.task(day2.ctx)).toMatchObject({ enqueued: 2 });
    // The walk went on down the feed's order until two items were really queued.
    expect(queue.items().map((r) => [queue.jobOf(r), r.status])).toEqual([['job0', 'dead'], ['job1', 'queued'], ['job2', 'queued'], ['job3', 'queued']]);
    // The dead item was not revived, and the waiting one was not disturbed.
    expect(queue.items()[0]).toMatchObject({ status: 'dead', attempts: 1 });
    expect(day2.counts.get(scoreCounterKeys.precompute('roboapply', 'u1'))).toBe(2);
    // The brand budget bounds the walk the same way.
    const tight = setup({ jobs: 6, budget: '1', enqueue: queue.enqueue, repo: day1.repo });
    expect(await tight.task(tight.ctx)).toMatchObject({ enqueued: 1 });
    expect(queue.waiting()).toEqual(['job1', 'job2', 'job3', 'job4']);
  });
});

describe('job.score worker', () => {
  afterEach(() => resetWorkerRegistryForTests());

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

  it('an answer that was received and refused is permanent; a call that failed is thrown as it is, for the queue to retry', async () => {
    const scoreJob = vi.fn();
    const handler = createJobScoreHandler(async () => ({ scoreJob }) as never, () => NOW);
    scoreJob.mockRejectedValueOnce(new ScorerFailedError(new Error('scorer v4 checklist: 2 of the 3 copied requirement lines are not in the posting'), 'answer'));
    const refused = await handler(item({ userId: 'u1', jobId: 'job1' }), {} as never).then(() => null, (err: unknown) => err);
    expect(refused).toBeInstanceOf(PermanentWorkError);
    expect((refused as Error).message).toMatch(/fit scorer failed: scorer v4 checklist: 2 of the 3/);
    const failed = new ScorerFailedError(new Error('upstream 502'), 'call');
    scoreJob.mockRejectedValueOnce(failed);
    await expect(handler(item({ userId: 'u1', jobId: 'job1' }), {} as never)).rejects.toBe(failed);
    scoreJob.mockRejectedValueOnce(new ScorerFailedError(new Error('upstream 502')));
    await expect(handler(item({ userId: 'u1', jobId: 'job1' }), {} as never)).rejects.not.toBeInstanceOf(PermanentWorkError);
  });

  describe('through the drain, on the real service', () => {
    const OWNER = 'test-drain';
    const allowed: RateLimitResult = { allowed: true, retryAfterSec: 0, remaining: 100, windows: [] };
    /** A queue table whose lease returns the one queued job.score item of u1 for the test kit's job. */
    function leased() {
      const pending: Array<Record<string, unknown>> = [{ id: 'w1', kind: 'job.score', brand: 'roboapply', userId: 'u1', payload: { userId: 'u1', jobId: 'job1', resumeVariantId: 'v1' }, attempts: 0, maxAttempts: 5, dedupeKey: 'job.score:u1:job1:abc', priority: 200 }];
      const db = createFakePrisma({
        uniqueFields: { rAWorkItem: ['dedupeKey'] },
        sql: {
          respond: (call) => {
            if (!call.text.includes('FOR UPDATE SKIP LOCKED')) return undefined;
            const batch = pending.splice(0);
            for (const r of batch) db.$rows('rAWorkItem').push({ ...r, status: 'leased', leaseOwner: OWNER, attempts: 1 });
            return batch.map((r) => ({ ...r, attempts: 1 }));
          },
        },
      });
      return db;
    }
    function world(scorerV4: ScorerV4Like) {
      const repo = createMemoryRepo();
      const consume = vi.fn(async () => allowed);
      const service = createMatchService({ repo, scorerV4, resolveModel: () => MODEL, routeAllowed: () => true, aiAllowed: async () => true, consume, costLog: async () => undefined, profileSnapshot: async () => null, brand: () => getBrand('roboapply'), env: {}, now: () => NOW });
      registerWorker({ kind: MATCH_WORK_KINDS.jobScore, handler: createJobScoreHandler(async () => service, () => NOW) });
      return { repo, consume };
    }
    const run = (db: ReturnType<typeof leased>) => drain([MATCH_WORK_KINDS.jobScore], { db: db as unknown as QueueDb, brands: ['roboapply'], owner: OWNER, now: () => NOW.getTime() });
    /** The answer of a model that copied no requirement line of a posting that lists skills: refused by the server. */
    const noLines: RAJobMatchScorerV4Output = { requirements: [], level: { post: 'senior', resume: 'senior', direction: 'match' }, domain: { status: 'direct', evidence: '' }, trajectory: { status: 'toward', evidence: '' }, strengths: [], gaps: [], summary: null };

    it('a refused checklist marks the item dead after ONE attempt: one model call, one unit of the brand budget, never five', async () => {
      const scorerV4 = { run: vi.fn(async () => noLines) };
      const w = world(scorerV4);
      const db = leased();
      expect(await run(db)).toMatchObject({ leased: 1, dead: 1, retried: 0, done: 0 });
      expect(db.$rows('rAWorkItem')[0]).toMatchObject({ status: 'dead', attempts: 1, lastError: expect.stringMatching(/^PermanentWorkError: fit scorer failed: scorer v4 checklist: the posting lists skills or years of experience/) });
      expect(scorerV4.run).toHaveBeenCalledTimes(1);
      expect(w.consume.mock.calls.filter(([c]) => (c as { key: string }).key === scoreCounterKeys.budget('roboapply'))).toHaveLength(1);
      expect(w.repo.state.scores).toHaveLength(0);
    });

    it('an upstream 502 is still retried with backoff, and a usable answer is done', async () => {
      const failing = { run: vi.fn(async () => Promise.reject(new Error('upstream 502'))) };
      world(failing);
      const db = leased();
      expect(await run(db)).toMatchObject({ leased: 1, dead: 0, retried: 1 });
      expect(db.$rows('rAWorkItem')[0]).toMatchObject({ status: 'queued', lastError: 'ScorerFailedError: fit scorer failed: upstream 502' });

      resetWorkerRegistryForTests();
      const good = { run: vi.fn(async () => ({ ...noLines, requirements: [{ id: 'r1', kind: 'skill' as const, text: 'Kubernetes required', importance: 'must' as const, status: 'not_shown' as const, evidence: '' }] })) };
      const w = world(good);
      const ok = leased();
      expect(await run(ok)).toMatchObject({ leased: 1, done: 1, dead: 0, retried: 0 });
      expect(w.repo.state.scores).toHaveLength(1);
    });
  });
});
