// @vitest-environment node
// The fit contract (MARKET_STRATEGY 2.2; SM-5): getFit, getFits and getVariantFit over the in-memory repo with a
// counting fake scorer. No network, no database, no model.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../platform/brand/registry.js';
import type { RateLimitResult } from '../../platform/ratelimit/index.js';
import type { RAJobMatchScorerV3Output } from '../../roboapply/v2/agents/RAJobMatchScorerAgent.js';
import { currentScorerPin } from './config.js';
import { DEFAULT_MATCH_PRIORS, DEFAULT_MATCH_TIERS, DEFAULT_MATCH_WEIGHTS, FitSnapshotSchema, readFitSnapshot, type MatchDimension } from './contract.js';
import {
  ADHOC_POSTING_ID,
  assembleFit,
  createFitService,
  estimateForPosting,
  fitFunctions,
  fitSnapshot,
  fitToListResult,
  fitToView,
  getFit,
  getFits,
  getVariantFit,
  hysteresisTier,
  setFitServiceForTests,
  storedFitStatus,
  toWireKind,
  type AdhocPosting,
  type Fit,
} from './fit.js';
import { toMatchJob } from './context.js';
import { currentJobHash, jobContentHash } from './jobHash.js';
import { FITS_MAX_IDS, createMatchService, type MatchServiceDeps, type ScorerLike } from './MatchService.js';
import { preScore } from './preScore.js';
import type { ScoreRecord } from './repo.js';
import { createMemoryRepo, jobRecord, matchUser, resumeRecord } from './testkit.js';

const NOW = new Date('2026-10-10T08:00:00Z');
const MODEL_A = 'test/model-a';
const MODEL_B = 'test/model-b';
const TIERS = { ...DEFAULT_MATCH_TIERS };
const CFG = { weights: { ...DEFAULT_MATCH_WEIGHTS }, tiers: TIERS, priors: { ...DEFAULT_MATCH_PRIORS } };

function scorerOutput(over: Partial<Record<'title_level' | 'skills' | 'industry' | 'career_path', number | null>> = {}): RAJobMatchScorerV3Output {
  const s = { title_level: 90, skills: 60, industry: 80, career_path: null, ...over };
  return {
    dimensions: {
      title_level: { score: s.title_level, evidence: [] },
      skills: { score: s.skills, evidence: [] },
      industry: { score: s.industry, evidence: [] },
      career_path: { score: s.career_path, evidence: [] },
    },
    strengths: ['Your payments APIs in Go'],
    gaps: ['No Kubernetes work shown'],
    keywordsMatched: [],
    keywordsMissing: [],
    summary: 'Your payments work lines up well.',
  };
}

const allow = (): RateLimitResult => ({ allowed: true, retryAfterSec: 0, remaining: 100, windows: [] });

function setup(over: Partial<MatchServiceDeps> & { repo?: ReturnType<typeof createMemoryRepo>; output?: () => RAJobMatchScorerV3Output } = {}) {
  const { output, ...deps } = over;
  const repo = deps.repo ?? createMemoryRepo();
  /** The counting fake scorer: every model call the fit contract makes lands here. */
  const scorer = { run: vi.fn(async () => (output ? output() : scorerOutput())) } satisfies ScorerLike;
  const service = createMatchService({
    repo,
    scorer,
    resolveModel: () => MODEL_A,
    routeAllowed: () => true,
    aiAllowed: async () => true,
    consume: async () => allow(),
    costLog: async () => undefined,
    profileSnapshot: async () => null,
    brand: () => getBrand('roboapply'),
    env: {},
    now: () => NOW,
    ...deps,
  });
  return { service, repo, scorer, fits: fitFunctions(service) };
}

/** What every surface must agree on (invariant I1). */
const shown = (f: Fit | undefined) => (f ? { score: f.score, tier: f.tier, kind: f.kind } : null);

/** The person edits their saved search (the memory repo's stored filters). */
function setFilters(repo: ReturnType<typeof createMemoryRepo>, change: Record<string, unknown>, version: number) {
  const current = repo.state.users.u1!.searchProfile!.filters as Record<string, unknown>;
  repo.state.users.u1!.searchProfile = { version, filters: { ...current, ...change } };
}

afterEach(() => setFitServiceForTests(null));

describe('getFit and getFits answer the same fit (I1); the list form never calls a model', () => {
  it('an estimate: the same score, tier and kind from both, and no model call', async () => {
    const { fits, scorer, repo } = setup({ repo: createMemoryRepo({ jobs: [jobRecord(), jobRecord({ id: 'job2', skills: [], skillsDetail: null })] }) });
    const list = await fits.getFits('u1', ['job1', 'job2']);
    for (const id of ['job1', 'job2']) {
      const one = await fits.getFit('u1', id);
      expect(shown(one), id).toEqual(shown(list.get(id)));
      expect(one.kind).toBe('estimate');
      expect(one).toMatchObject({ coverage: list.get(id)!.coverage, confidence: list.get(id)!.confidence, confidenceReason: list.get(id)!.confidenceReason });
    }
    expect(scorer.run).not.toHaveBeenCalled();
    expect(repo.state.scores).toHaveLength(0);
  });

  it('an AI score: the same from both, after the one model call that wrote it', async () => {
    const { fits, scorer } = setup();
    const scored = await fits.getFit('u1', 'job1', { allowModelCall: true });
    expect(scored.kind).toBe('ai');
    expect(scorer.run).toHaveBeenCalledTimes(1);
    const one = await fits.getFit('u1', 'job1');
    const list = await fits.getFits('u1', ['job1']);
    expect(shown(one)).toEqual(shown(scored));
    expect(shown(list.get('job1'))).toEqual(shown(scored));
    expect(list.get('job1')!.dimensions).toEqual(one.dimensions);
    expect(scorer.run).toHaveBeenCalledTimes(1);
  });

  it('the list never calls a model, never writes and never spends a counter, whatever is stored', async () => {
    const consume = vi.fn(async () => allow());
    const { fits, scorer, repo } = setup({ consume, repo: createMemoryRepo({ jobs: [jobRecord(), jobRecord({ id: 'job2' }), jobRecord({ id: 'job3' })] }) });
    await fits.getFit('u1', 'job1', { allowModelCall: true });
    scorer.run.mockClear();
    consume.mockClear();
    const saves = repo.calls.saveScore;
    const list = await fits.getFits('u1', ['job1', 'job2', 'job3', 'missing', 'job1']);
    expect([...list.keys()]).toEqual(['job1', 'job2', 'job3']);
    expect([...list.values()].map((f) => f.kind)).toEqual(['ai', 'estimate', 'estimate']);
    expect(scorer.run).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(repo.calls.saveScore).toBe(saves);
    // A list read carries no prose; the single read does.
    expect(list.get('job1')!.prose).toBeNull();
    expect((await fits.getFit('u1', 'job1')).prose).toMatchObject({ summary: 'Your payments work lines up well.', locale: 'en' });
  });

  it('at most 500 ids are read; a job of another market or someone else\'s import has no entry', async () => {
    const jobs = [jobRecord(), jobRecord({ id: 'cn1', market: 'cn' }), jobRecord({ id: 'priv', visibility: 'private', ownerUserId: 'u2' }), jobRecord({ id: 'mine', visibility: 'private', ownerUserId: 'u1' })];
    const { fits } = setup({ repo: createMemoryRepo({ jobs }) });
    expect([...(await fits.getFits('u1', ['job1', 'cn1', 'priv', 'mine'])).keys()]).toEqual(['job1', 'mine']);
    expect((await fits.getFits('u1', [])).size).toBe(0);
    expect(FITS_MAX_IDS).toBe(500);
    const many = Array.from({ length: 520 }, (_, i) => jobRecord({ id: `j${i}` }));
    const big = setup({ repo: createMemoryRepo({ jobs: many }) });
    expect((await big.fits.getFits('u1', many.map((j) => j.id))).size).toBe(500);
    await expect(fits.getFit('u1', 'cn1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a caller may hand the person\'s side it already read; the fits are the same and it is not read again', async () => {
    const { service, fits, repo } = setup();
    const context = await service.userContext('u1');
    const getUserInputs = vi.spyOn(repo, 'getUserInputs');
    const withContext = await fits.getFits('u1', ['job1'], { context });
    expect(getUserInputs).not.toHaveBeenCalled();
    expect(withContext.get('job1')).toEqual((await fits.getFits('u1', ['job1'])).get('job1'));
  });

  it('a stored score that cannot be read still answers the estimate for the whole list', async () => {
    const { fits, repo } = setup();
    repo.listAiScores = async () => {
      throw new Error('db down');
    };
    expect((await fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ kind: 'estimate' });
  });
});

describe('a fresh AI row beats the estimate (I2)', () => {
  it('the stored AI score is the fit on both forms, and its own total is not the estimate\'s', async () => {
    const { fits, repo } = setup();
    const before = (await fits.getFits('u1', ['job1'])).get('job1')!;
    expect(before.kind).toBe('estimate');
    const scored = await fits.getFit('u1', 'job1', { allowModelCall: true });
    // 35 × 90 + 30 × 60 + 15 × 80 + 10 × 100 over 90 (career_path not stated drops out): the AI arithmetic.
    expect(scored.score).toBe(Math.round((35 * 90 + 30 * 60 + 15 * 80 + 10 * 100) / 90));
    expect(scored.score).not.toBe(before.score);
    const after = (await fits.getFits('u1', ['job1'])).get('job1')!;
    expect(after).toMatchObject({ kind: 'ai', score: scored.score, tier: scored.tier, stale: false, calibrated: false, estimateReason: null });
    // The estimate behind it is still reported, on its own scale: ranking blends the two.
    expect(after.estimateScore).toBe(before.score);
    expect(after.version).toEqual({ rubric: 'fit_v3', estimator: 'est_v2', model: MODEL_A, prompt: 'scorer_v3' });
    expect(after.scoredAt).toBe(NOW.toISOString());
    // The row stores what the fit key needs, and the estimate it was scored next to.
    expect(repo.state.scores[0]).toMatchObject({ jobContentHash: jobContentHash(jobRecord()), rubricVersion: 'fit_v3', modelUsed: MODEL_A });
    expect((repo.state.scores[0]!.explanation as { estimateAtScore: unknown }).estimateAtScore).toEqual({ score: before.score, coverage: before.coverage });
  });

  it('a row of the legacy v2 scorer (no components) is never read as a fit', async () => {
    const legacy: ScoreRecord = {
      userId: 'u1', jobId: 'job1', resumeVariantId: 'v1', score: 96, explanation: { signals: {} }, resumeContentHashAtScore: 'hash-1', modelUsed: MODEL_A,
      generatedAt: NOW, scoreKind: 'ai', tier: 'great', dimensions: null, promptVersion: 'v2_jobs_score_v1', locale: 'en', searchProfileVersion: 1,
    };
    const { fits } = setup({ repo: createMemoryRepo({ scores: [legacy] }) });
    expect((await fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ kind: 'estimate' });
    expect((await fits.getFit('u1', 'job1')).kind).toBe('estimate');
    // The same row with a fit prompt but nothing scored is not a fit either.
    const empty = setup({ repo: createMemoryRepo({ scores: [{ ...legacy, promptVersion: 'scorer_v3', dimensions: [] }] }) });
    expect((await empty.fits.getFits('u1', ['job1'])).get('job1')!.kind).toBe('estimate');
  });

  it('a score for an older resume is not the fit', async () => {
    const { fits, repo, scorer } = setup();
    await fits.getFit('u1', 'job1', { allowModelCall: true });
    repo.state.resumes[0]!.resumeContentHash = 'hash-2';
    expect((await fits.getFits('u1', ['job1'])).get('job1')!.kind).toBe('estimate');
    expect((await fits.getFit('u1', 'job1')).kind).toBe('estimate');
    expect(scorer.run).toHaveBeenCalledTimes(1);
  });
});

describe('a model or prompt change is a version bump, never a silent miss (I7)', () => {
  it('a row of the previous model keeps serving with stale: true on every form; no surface drops to an estimate', async () => {
    const repo = createMemoryRepo();
    const a = setup({ repo });
    const scored = await a.fits.getFit('u1', 'job1', { allowModelCall: true });

    // The pinned model changes.
    const b = setup({ repo, resolveModel: () => MODEL_B });
    const list = (await b.fits.getFits('u1', ['job1'])).get('job1')!;
    const one = await b.fits.getFit('u1', 'job1');
    for (const f of [list, one]) {
      expect(f).toMatchObject({ kind: 'ai', score: scored.score, tier: scored.tier, stale: true });
      // Its own version is reported, not the pin's.
      expect(f.version).toMatchObject({ model: MODEL_A, prompt: 'scorer_v3', rubric: 'fit_v3' });
    }
    expect(fitToView(one).stale).toBe(true);
    expect(b.scorer.run).not.toHaveBeenCalled();
  });

  it('precompute (or an on-demand call) replaces it; until a model may run the stale row is what answers', async () => {
    const repo = createMemoryRepo();
    const scored = await setup({ repo }).fits.getFit('u1', 'job1', { allowModelCall: true });

    // Over the daily cap: an on-demand call cannot re-score; the stored fit stays, never an estimate.
    const capped = setup({ repo, resolveModel: () => MODEL_B, consume: async ({ key }) => (key.includes(':score:user:') ? { ...allow(), allowed: false, remaining: 0 } : allow()) });
    expect(await capped.fits.getFit('u1', 'job1', { allowModelCall: true })).toMatchObject({ kind: 'ai', score: scored.score, stale: true });
    expect(capped.scorer.run).not.toHaveBeenCalled();
    // The model call fails: the same.
    const failing = setup({ repo, resolveModel: () => MODEL_B, scorer: { run: vi.fn(async () => Promise.reject(new Error('upstream 502'))) } });
    expect(await failing.fits.getFit('u1', 'job1', { allowModelCall: true })).toMatchObject({ kind: 'ai', stale: true });
    // No model this brand may call at all: the same.
    const noRoute = setup({ repo, resolveModel: () => MODEL_B, routeAllowed: () => false });
    expect(await noRoute.fits.getFit('u1', 'job1', { allowModelCall: true })).toMatchObject({ kind: 'ai', stale: true });

    // The precompute worker re-scores it with the pinned model.
    const b = setup({ repo, resolveModel: () => MODEL_B, output: () => scorerOutput({ skills: 80 }) });
    const view = await b.service.scoreJob('u1', 'job1', { mode: 'precompute', onAiFailure: 'throw' });
    expect(b.scorer.run).toHaveBeenCalledTimes(1);
    expect(view).toMatchObject({ kind: 'ai', stale: false, cached: false });
    expect(repo.state.scores).toHaveLength(1);
    expect(repo.state.scores[0]).toMatchObject({ modelUsed: MODEL_B });
    const after = (await b.fits.getFits('u1', ['job1'])).get('job1')!;
    expect(after).toMatchObject({ kind: 'ai', stale: false, version: { model: MODEL_B } });
    expect(after.score).not.toBe(scored.score);
    // Fresh now: another precompute run makes no call.
    await b.service.scoreJob('u1', 'job1', { mode: 'precompute' });
    expect(b.scorer.run).toHaveBeenCalledTimes(1);
  });

  it('a spent budget tells the queued precompute item so (the worker defers it), while lists keep the stale fit', async () => {
    const repo = createMemoryRepo();
    await setup({ repo }).fits.getFit('u1', 'job1', { allowModelCall: true });
    const spent = setup({ repo, resolveModel: () => MODEL_B, consume: async () => ({ ...allow(), allowed: false, remaining: 0 }) });
    expect(await spent.service.scoreJob('u1', 'job1', { mode: 'precompute' })).toMatchObject({ kind: 'pre', estimateReason: 'budget' });
    expect((await spent.fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ kind: 'ai', stale: true });
  });

  it('storedFitStatus: the model, the prompt and the posting\'s hash decide staleness, never usability', () => {
    const row = { dimensions: [{ key: 'skills', weight: 30, score: 60, status: 'scored', evidence: [] }], promptVersion: 'scorer_v3', modelUsed: MODEL_A, jobContentHash: 'h1', resumeContentHashAtScore: 'r1' };
    const ctx = { resumeContentHash: 'r1', jobContentHash: 'h1', pin: currentScorerPin('roboapply', MODEL_A) };
    expect(storedFitStatus(row, ctx)).toMatchObject({ usable: true, stale: false });
    expect(storedFitStatus(row, { ...ctx, pin: currentScorerPin('roboapply', MODEL_B) })).toMatchObject({ usable: true, stale: true });
    // The next scorer's rows are fits too, and stale against today's pin.
    expect(storedFitStatus({ ...row, promptVersion: 'scorer_v4' }, ctx)).toMatchObject({ usable: true, stale: true });
    // No model configured: nothing can be re-scored, so nothing is called stale for its model.
    expect(storedFitStatus(row, { ...ctx, pin: currentScorerPin('roboapply', null) })).toMatchObject({ usable: true, stale: false });
    expect(storedFitStatus({ ...row, resumeContentHashAtScore: 'r0' }, ctx).usable).toBe(false);
    // Written for an earlier version of the posting: stale, never absent.
    expect(storedFitStatus({ ...row, jobContentHash: 'h0' }, ctx)).toMatchObject({ usable: true, stale: true });
    // A row older than the hash column, and a posting whose hash is not known here, count as current.
    expect(storedFitStatus({ ...row, jobContentHash: null }, ctx)).toMatchObject({ usable: true, stale: false });
    expect(storedFitStatus(row, { ...ctx, jobContentHash: null })).toMatchObject({ usable: true, stale: false });
    expect(storedFitStatus({ ...row, promptVersion: 'v2_jobs_score_v1' }, ctx).usable).toBe(false);
    expect(storedFitStatus({ ...row, promptVersion: null }, ctx).usable).toBe(false);
    expect(storedFitStatus({ ...row, dimensions: 'nope' }, ctx).usable).toBe(false);
    expect(storedFitStatus(null, ctx).usable).toBe(false);
  });
});

describe('a changed posting makes the stored row stale, and the next allowed model call re-scores it', () => {
  it('the stored score keeps serving, flagged stale, on both forms; a list never re-scores; an allowed call does', async () => {
    const { fits, repo, scorer } = setup();
    const scored = await fits.getFit('u1', 'job1', { allowModelCall: true });
    const oldHash = repo.state.scores[0]!.jobContentHash;
    expect(scored).toMatchObject({ kind: 'ai', stale: false });

    // The employer rewrites a requirement line.
    repo.state.jobs[0] = { ...repo.state.jobs[0]!, qualifications: '8+ years of backend experience. Rust required.' };
    expect(currentJobHash(repo.state.jobs[0]!)).not.toBe(oldHash);
    const list = (await fits.getFits('u1', ['job1'])).get('job1')!;
    const one = await fits.getFit('u1', 'job1');
    // No surface drops to a quick estimate because the posting changed: the AI score serves until it is replaced.
    for (const fit of [list, one]) expect(fit).toMatchObject({ kind: 'ai', score: scored.score, tier: scored.tier });
    // The single-job read holds the full row: it names the posting's hash now and flags the score.
    expect(one).toMatchObject({ stale: true, basis: { jobContentHash: currentJobHash(repo.state.jobs[0]!) } });
    // The list reads no description. Once the row stores its hash (RAJob.contentHash) it flags the score too.
    expect(list.basis.jobContentHash).toBeNull();
    repo.state.jobs[0] = { ...repo.state.jobs[0]!, contentHash: jobContentHash(repo.state.jobs[0]!) };
    expect((await fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ kind: 'ai', stale: true, score: scored.score, basis: { jobContentHash: repo.state.jobs[0]!.contentHash } });
    expect(scorer.run).toHaveBeenCalledTimes(1);

    const rescored = await fits.getFit('u1', 'job1', { allowModelCall: true });
    expect(scorer.run).toHaveBeenCalledTimes(2);
    expect(rescored).toMatchObject({ kind: 'ai', stale: false });
    expect(repo.state.scores).toHaveLength(1);
    expect(repo.state.scores[0]!.jobContentHash).toBe(currentJobHash(repo.state.jobs[0]!));
    const after = (await fits.getFits('u1', ['job1'])).get('job1')!;
    expect(shown(after)).toEqual(shown(rescored));
    expect(after.stale).toBe(false);
    expect(scored.basis.jobContentHash).toBe(oldHash);
    expect(rescored.basis.jobContentHash).not.toBe(oldHash);
  });

  it('enrichment adds a skill to the posting: the AI score keeps serving, never a quick estimate in its place, and a capped call keeps it', async () => {
    const repo = createMemoryRepo();
    const first = setup({ repo, output: () => scorerOutput({ title_level: 79, skills: 79, industry: 79 }) });
    const scored = await first.fits.getFit('u1', 'job1', { allowModelCall: true });
    expect(scored.kind).toBe('ai');
    const estimate = preScore((await first.service.userContext('u1')).user, toMatchJob(repo.state.jobs[0]!), CFG).score;
    expect(estimate).not.toBe(scored.score);

    // Enrichment appends a grounded skill: the hash moves although the posting's text did not.
    repo.state.jobs[0] = { ...repo.state.jobs[0]!, skills: [...repo.state.jobs[0]!.skills, 'docker'] };
    const list = (await first.fits.getFits('u1', ['job1'])).get('job1')!;
    expect(list).toMatchObject({ kind: 'ai', score: scored.score, tier: scored.tier });
    expect(await first.fits.getFit('u1', 'job1')).toMatchObject({ kind: 'ai', stale: true, score: scored.score, tier: scored.tier });
    expect(first.scorer.run).toHaveBeenCalledTimes(1);

    // The day's cap is spent: the planned re-score cannot run, and the stale AI fit is what answers.
    const capped = setup({ repo, consume: async () => ({ allowed: false, retryAfterSec: 60, remaining: 0, windows: [] }) });
    expect(await capped.fits.getFit('u1', 'job1', { allowModelCall: true })).toMatchObject({ kind: 'ai', stale: true, score: scored.score });
    expect(capped.scorer.run).not.toHaveBeenCalled();
  });

  it('a change that is not content (pay, location, spacing) leaves the row current; a row older than the hash column keeps serving, not stale', async () => {
    const { fits, repo, scorer } = setup();
    await fits.getFit('u1', 'job1', { allowModelCall: true });
    repo.state.jobs[0] = { ...repo.state.jobs[0]!, qualifications: '5+  years of backend experience.\nKubernetes required.', salaryAnnualMax: 95000, benefits: 'Gym' };
    expect((await fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ kind: 'ai', stale: false });
    await fits.getFit('u1', 'job1', { allowModelCall: true });
    expect(scorer.run).toHaveBeenCalledTimes(1);

    // Written before the column existed: no hash to compare, so it serves as current and nothing re-scores it for the posting.
    repo.state.scores[0] = { ...repo.state.scores[0]!, jobContentHash: null };
    repo.state.jobs[0] = { ...repo.state.jobs[0]!, qualifications: 'Entirely new requirements.' };
    expect((await fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ kind: 'ai', stale: false });
    expect(await fits.getFit('u1', 'job1', { allowModelCall: true })).toMatchObject({ kind: 'ai', stale: false });
    expect(scorer.run).toHaveBeenCalledTimes(1);
  });
});

describe('what a list reads: no description, no row the caller already has', () => {
  const LONG = 'Build and run payment systems. '.repeat(400);
  const jobs = () => ['a', 'b', 'c', 'd', 'e'].map((id) => jobRecord({ id, qualifications: null, descriptionPlain: LONG, description: LONG }));
  /** Every read a list of fits makes. */
  const READS = ['getFitJobs', 'listAiScores', 'getJob', 'getJobs', 'getScore', 'getKeywords'] as const;
  const spies = (repo: ReturnType<typeof createMemoryRepo>) => Object.fromEntries(READS.map((name) => [name, vi.spyOn(repo, name)])) as Record<(typeof READS)[number], ReturnType<typeof vi.spyOn>>;

  it('the list projection carries no long text, and no posting text is read for a list, with or without stored scores', async () => {
    const repo = createMemoryRepo({ jobs: jobs() });
    const { fits } = setup({ repo });
    for (const id of ['b', 'd']) await fits.getFit('u1', id, { allowModelCall: true });
    const light = await repo.getFitJobs(['a', 'b']);
    for (const row of light) expect([row.description, row.descriptionPlain, row.responsibilities, row.benefits]).toEqual(['', '', null, null]);

    const read = spies(repo);
    const list = await fits.getFits('u1', ['a', 'b', 'c', 'd', 'e']);
    expect(list.size).toBe(5);
    // Two reads for the jobs' side of a list: the light rows and the stored scores. Never a full row.
    expect(read.getFitJobs).toHaveBeenCalledTimes(1);
    expect(read.listAiScores).toHaveBeenCalledTimes(1);
    for (const name of ['getJob', 'getJobs', 'getScore', 'getKeywords'] as const) expect(read[name], name).not.toHaveBeenCalled();
    // No hash is computed for a posting that stores none (that would need its description).
    for (const fit of list.values()) expect(fit.basis.jobContentHash).toBeNull();
    expect([...list.values()].map((f) => f.kind)).toEqual(['estimate', 'ai', 'estimate', 'ai', 'estimate']);
    // The single-job form holds the full row and always names the hash; what is shown is the same (I1).
    for (const id of ['a', 'b']) {
      const one = await fits.getFit('u1', id);
      expect(one.basis.jobContentHash).toBe(jobContentHash(repo.state.jobs.find((j) => j.id === id)!));
      expect(shown(one), id).toEqual(shown(list.get(id)));
    }
  });

  it('rows the caller hands over are not read again; only the missing ids are', async () => {
    const repo = createMemoryRepo({ jobs: jobs() });
    const { fits, service } = setup({ repo });
    await fits.getFit('u1', 'b', { allowModelCall: true });
    const context = await service.userContext('u1');
    const read = spies(repo);
    // What the feed hands over: its own rows, without any description text.
    const handed = repo.state.jobs.map((j) => ({ ...j, description: '', descriptionPlain: '', responsibilities: null, benefits: null }));
    const all = await fits.getFits('u1', ['a', 'b', 'c', 'd', 'e'], { context, rows: handed });
    // A feed window costs one read here: the stored scores.
    expect(read.getFitJobs).not.toHaveBeenCalled();
    expect(read.listAiScores).toHaveBeenCalledTimes(1);
    for (const name of ['getJob', 'getJobs', 'getScore', 'getKeywords'] as const) expect(read[name], name).not.toHaveBeenCalled();
    expect(all.size).toBe(5);
    // The same fits as a call that reads the rows itself.
    const plain = await fits.getFits('u1', ['a', 'b', 'c', 'd', 'e']);
    for (const id of all.keys()) expect(shown(all.get(id)), id).toEqual(shown(plain.get(id)));
    expect(all.get('b')!.kind).toBe('ai');
    read.getFitJobs.mockClear();
    await fits.getFits('u1', ['a', 'b', 'c'], { context, rows: handed.slice(0, 2) });
    expect(read.getFitJobs).toHaveBeenCalledTimes(1);
    expect(read.getFitJobs).toHaveBeenCalledWith(['c']);
    // A handed row is still checked: another market's job or someone else's import gets no fit.
    const foreign = await fits.getFits('u1', ['a', 'x'], { context, rows: [handed[0]!, { ...handed[1]!, id: 'x', market: 'cn' }] });
    expect([...foreign.keys()]).toEqual(['a']);
  });

  it('a row that stores its hash is judged on it, with no text read; a row older than the hash column counts as current', async () => {
    const repo = createMemoryRepo({ jobs: [...jobs(), jobRecord({ id: 'hashed', contentHash: 'stored-with-the-search-document' })] });
    const { fits, service } = setup({ repo });
    for (const id of ['d', 'hashed']) await fits.getFit('u1', id, { allowModelCall: true });
    expect(repo.state.scores.find((x) => x.jobId === 'hashed')!.jobContentHash).toBe('stored-with-the-search-document');
    repo.state.scores = repo.state.scores.map((x) => (x.jobId === 'd' ? { ...x, jobContentHash: null } : x));
    const context = await service.userContext('u1');
    const handed = repo.state.jobs.map((j) => ({ ...j, description: '', descriptionPlain: '' }));

    const list = await fits.getFits('u1', handed.map((j) => j.id), { context, rows: handed });
    expect(list.get('hashed')).toMatchObject({ kind: 'ai', stale: false, basis: { jobContentHash: 'stored-with-the-search-document' } });
    expect(list.get('d')).toMatchObject({ kind: 'ai', stale: false, basis: { jobContentHash: null } });

    // The stored hash of the row moves (the search document was rewritten): stale on the list and on the single read alike.
    repo.state.jobs = repo.state.jobs.map((j) => (j.id === 'hashed' ? { ...j, contentHash: 'rewritten' } : j));
    const moved = handed.map((j) => (j.id === 'hashed' ? { ...j, contentHash: 'rewritten' } : j));
    const again = (await fits.getFits('u1', ['hashed'], { context, rows: moved })).get('hashed')!;
    const one = await fits.getFit('u1', 'hashed');
    expect(again).toMatchObject({ kind: 'ai', stale: true });
    expect(one).toMatchObject({ kind: 'ai', stale: true });
    expect(shown(again)).toEqual(shown(one));
  });
});

describe('a displayed tier moves only 3 points past the edge it crosses (I5)', () => {
  it.each([
    ['good', 79, 'good'],
    ['good', 80, 'good'], // on the edge
    ['good', 81, 'good'], // 1 point over: keeps the stored tier
    ['good', 82, 'good'],
    ['good', 83, 'great'], // 3 points over: changes
    ['good', 64, 'good'], // 1 point under
    ['good', 63, 'good'],
    ['good', 62, 'possible'], // 3 points under
    ['great', 79, 'great'],
    ['great', 77, 'good'],
    ['possible', 67, 'possible'],
    ['possible', 68, 'good'],
    ['possible', 81, 'good'], // past Good by 3, past Great by only 1
    ['possible', 90, 'great'],
    ['great', 30, 'unlikely'],
    ['unlikely', 47, 'unlikely'],
    ['unlikely', 48, 'possible'],
    [null, 81, 'great'], // no stored tier: the total's own
    ['nonsense', 64, 'possible'],
  ])('stored %s, recomputed total %s → %s', (stored, total, tier) => {
    expect(hysteresisTier(stored as string | null, total as number, TIERS)).toBe(tier);
  });

  it('a logistics change that lifts the total 1 point over Great keeps Good; 3 points over makes it Great; both forms agree and no model runs', async () => {
    // The job offers sponsorship; the person's pay floor is above the posting (location met, pay not met).
    const repo = createMemoryRepo({ jobs: [jobRecord({ sponsorship: 'offered', sponsorshipEvidence: 'We sponsor visas.' })] });
    setFilters(repo, { salaryMin: { amount: 120000, currency: 'EUR', period: 'year' } }, 1);
    const { fits, scorer } = setup({ repo, output: () => scorerOutput({ title_level: 95, skills: 70, industry: 80 }) });
    const first = await fits.getFit('u1', 'job1', { allowModelCall: true });
    // 35 × 95 + 30 × 70 + 15 × 80 + 10 × 50 over 90 = 79.2
    expect(first).toMatchObject({ score: 79, tier: 'good' });

    // They now say they need sponsorship (offered): 2 of 3 checks met, total 81.06. One point over the edge.
    setFilters(repo, { needsSponsorship: true }, 2);
    const list = (await fits.getFits('u1', ['job1'])).get('job1')!;
    expect(list).toMatchObject({ kind: 'ai', score: 81, tier: 'good' });
    expect(list.dimensions.find((d) => d.key === 'logistics')!.score).toBe(67);
    expect(await fits.getFit('u1', 'job1')).toMatchObject({ score: 81, tier: 'good' });
    // The recomputed total is stored with the tier that is shown.
    expect(repo.state.scores[0]).toMatchObject({ score: 81, tier: 'good', searchProfileVersion: 2 });
    expect((await fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ score: 81, tier: 'good' });

    // They lower the pay floor: all three met, total 84.7. Three points over: Great.
    setFilters(repo, { salaryMin: { amount: 60000, currency: 'EUR', period: 'year' } }, 3);
    expect((await fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ score: 85, tier: 'great' });
    expect(await fits.getFit('u1', 'job1')).toMatchObject({ score: 85, tier: 'great' });
    expect(repo.state.scores[0]).toMatchObject({ score: 85, tier: 'great' });
    expect(scorer.run).toHaveBeenCalledTimes(1);
  });

  it('a new model result takes its own tier', async () => {
    const repo = createMemoryRepo();
    let out = scorerOutput({ title_level: 62, skills: 62, industry: 62 });
    const { fits } = setup({ repo, output: () => out });
    expect((await fits.getFit('u1', 'job1', { allowModelCall: true })).tier).toBe('good');
    // The resume changes and the new result is 1 point over the Great edge: Great, with no hysteresis.
    repo.state.resumes[0]!.resumeContentHash = 'hash-2';
    out = scorerOutput({ title_level: 85, skills: 76, industry: 69 });
    const next = await fits.getFit('u1', 'job1', { allowModelCall: true });
    expect(next.score).toBe(81);
    expect(next.tier).toBe('great');
  });
});

describe('GoApply without the AI consent: zero scorer calls, the estimate with its reason (I8)', () => {
  const cnRepo = () => createMemoryRepo({ jobs: [jobRecord({ market: 'cn' })] });

  it('getFit with allowModelCall makes no scorer call and answers the estimate, reason ai_off', async () => {
    const consume = vi.fn(async () => allow());
    const { fits, scorer, repo } = setup({ repo: cnRepo(), aiAllowed: async () => false, brand: () => getBrand('goapply'), consume });
    const fit = await fits.getFit('u1', 'job1', { allowModelCall: true });
    expect(fit).toMatchObject({ kind: 'estimate', estimateReason: 'ai_off', stale: false, prose: null });
    expect(fit.score).not.toBeNull();
    expect(fitToView(fit)).toMatchObject({ kind: 'pre', estimateReason: 'ai_off', summary: null });
    expect(scorer.run).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(repo.state.scores).toHaveLength(0);
    expect((await fits.getVariantFit('u1', 'job1', 'v1', { allowModelCall: true })).estimateReason).toBe('ai_off');
    expect(scorer.run).not.toHaveBeenCalled();
  });

  it('a score written while the consent was on is not shown after it is withdrawn, on either form', async () => {
    const repo = cnRepo();
    const on = setup({ repo, brand: () => getBrand('goapply') });
    expect((await on.fits.getFit('u1', 'job1', { allowModelCall: true })).kind).toBe('ai');
    const off = setup({ repo, brand: () => getBrand('goapply'), aiAllowed: async () => false });
    const one = await off.fits.getFit('u1', 'job1', { allowModelCall: true });
    const list = (await off.fits.getFits('u1', ['job1'])).get('job1')!;
    expect(one).toMatchObject({ kind: 'estimate', estimateReason: 'ai_off' });
    expect(list).toMatchObject({ kind: 'estimate', estimateReason: 'ai_off' });
    expect(shown(list)).toEqual(shown(one));
    expect(off.scorer.run).not.toHaveBeenCalled();
    // The consent check itself failing counts as off.
    const broken = setup({ repo, brand: () => getBrand('goapply'), aiAllowed: async () => Promise.reject(new Error('consent store down')) });
    expect((await broken.fits.getFits('u1', ['job1'])).get('job1')!.kind).toBe('estimate');
  });

  it('with the consent GoApply gets the AI fit like RoboApply (D5)', async () => {
    const { fits } = setup({ repo: cnRepo(), brand: () => getBrand('goapply') });
    expect((await fits.getFit('u1', 'job1', { allowModelCall: true })).kind).toBe('ai');
  });
});

describe('the canonical fit is for the primary resume; a variant only through getVariantFit', () => {
  const twoResumes = () =>
    createMemoryRepo({
      resumes: [
        { ...resumeRecord(), userId: 'u1' },
        { ...resumeRecord({ id: 'v-tailored', resumeContentHash: 'hash-t', resumeMarkdown: '## Skills\nTypeScript, Go, Kubernetes', parsedData: { skills: ['TypeScript', 'Go', 'Kubernetes'] }, targetJobId: 'job1' }), userId: 'u1' },
      ],
    });

  it('getFit and getFits read the primary resume and have no way to name another', async () => {
    const { fits, repo } = setup({ repo: twoResumes() });
    const primary = await fits.getFit('u1', 'job1', { allowModelCall: true });
    expect(primary.basis).toMatchObject({ resumeVariantId: 'v1', resumeContentHash: 'hash-1' });
    expect((await fits.getFits('u1', ['job1'])).get('job1')!.basis.resumeVariantId).toBe('v1');
    // An option that looks like a variant is not one of theirs: it is ignored.
    const sneaky = await fits.getFit('u1', 'job1', { resumeVariantId: 'v-tailored', variantId: 'v-tailored' } as never);
    expect(sneaky.basis.resumeVariantId).toBe('v1');
    expect(repo.state.scores.map((s) => s.resumeVariantId)).toEqual(['v1']);
  });

  it('getVariantFit scores the named version next to the canonical fit, and never replaces it', async () => {
    const { fits, repo, scorer } = setup({ repo: twoResumes() });
    const canonical = await fits.getFit('u1', 'job1', { allowModelCall: true });
    const variant = await fits.getVariantFit('u1', 'job1', 'v-tailored', { allowModelCall: true });
    expect(scorer.run).toHaveBeenCalledTimes(2);
    expect(variant.basis).toMatchObject({ resumeVariantId: 'v-tailored', resumeContentHash: 'hash-t' });
    expect(variant.skills.aligned).toContain('Kubernetes');
    expect(canonical.skills.aligned).not.toContain('Kubernetes');
    expect(repo.state.scores.map((s) => s.resumeVariantId).sort()).toEqual(['v-tailored', 'v1']);
    // The canonical fit is unchanged on every form.
    expect(shown(await fits.getFit('u1', 'job1'))).toEqual(shown(canonical));
    expect(shown((await fits.getFits('u1', ['job1'])).get('job1'))).toEqual(shown(canonical));
    // Without allowModelCall the variant form answers what is stored, or its estimate.
    expect((await fits.getVariantFit('u1', 'job1', 'v-tailored')).kind).toBe('ai');
    expect(scorer.run).toHaveBeenCalledTimes(2);
    await expect(fits.getVariantFit('u1', 'job1', 'someone-elses')).rejects.toMatchObject({ code: 'not_found', details: { reason: 'resume_variant_not_found' } });
  });

  it('with no resume every form answers the estimate with reason no_resume, and no model runs', async () => {
    const { fits, scorer } = setup({ repo: createMemoryRepo({ resumes: [] }) });
    const one = await fits.getFit('u1', 'job1', { allowModelCall: true });
    expect(one).toMatchObject({ kind: 'estimate', estimateReason: 'no_resume', basis: { resumeVariantId: null, resumeContentHash: null } });
    expect((await fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ kind: 'estimate', estimateReason: 'no_resume', score: one.score });
    expect(scorer.run).not.toHaveBeenCalled();
  });
});

describe('the estimate on the AI scale (calibration)', () => {
  it('without a map the estimate is shown as it is; with one it is mapped, flagged calibrated, and never past its limit', async () => {
    const plain = setup();
    const raw = (await plain.fits.getFits('u1', ['job1'])).get('job1')!;
    expect(raw).toMatchObject({ kind: 'estimate', calibrated: false });
    expect(raw.estimateScore).toBe(raw.score);

    const map = { knots: [[0, 0], [100, 60]] as Array<[number, number]> };
    const calibrated = setup({ calibration: async () => ({ map, priors: null }) });
    const fit = (await calibrated.fits.getFits('u1', ['job1'])).get('job1')!;
    expect(fit).toMatchObject({ kind: 'estimate', calibrated: true, score: Math.round(raw.score! * 0.6), version: { estimator: 'est_v2' } });
    // The estimate on its own scale stays available.
    expect(fit.estimateScore).toBe(raw.score);
    expect(shown(await calibrated.fits.getFit('u1', 'job1'))).toEqual(shown(fit));
    expect(await calibrated.service.calibrationMap()).toEqual(map);
    expect(await plain.service.calibrationMap()).toBeNull();

    // A map that lifts scores cannot lift a thin posting past what the estimate may claim.
    const lifting = { knots: [[0, 40], [100, 100]] as Array<[number, number]> };
    const thinJob = jobRecord({ skills: [], skillsDetail: null, seniority: null });
    const lifted = setup({ repo: createMemoryRepo({ jobs: [thinJob] }), calibration: async () => ({ map: lifting, priors: null }) });
    const thin = (await lifted.fits.getFits('u1', ['job1'])).get('job1')!;
    expect(thin.score).toBeLessThanOrEqual(TIERS.great - 1);
    expect(thin.tier).not.toBe('great');
    expect(thin.confidence).toBe('low');
  });

  it('an AI fit is never mapped; data-derived priors replace the starting ones in the estimate', async () => {
    const map = { knots: [[0, 0], [100, 60]] as Array<[number, number]> };
    const { fits } = setup({ calibration: async () => ({ map, priors: null }) });
    const ai = await fits.getFit('u1', 'job1', { allowModelCall: true });
    expect(ai).toMatchObject({ kind: 'ai', calibrated: false, score: Math.round((35 * 90 + 30 * 60 + 15 * 80 + 10 * 100) / 90) });

    const noSkills = jobRecord({ skills: [], skillsDetail: null });
    const starting = (await setup({ repo: createMemoryRepo({ jobs: [noSkills] }) }).fits.getFits('u1', ['job1'])).get('job1')!;
    const learned = (await setup({ repo: createMemoryRepo({ jobs: [noSkills] }), calibration: async () => ({ map: null, priors: { skills: 9 } }) }).fits.getFits('u1', ['job1'])).get('job1')!;
    // The skills part is not stated: it counts at the market's prior, 39 at the start and 9 once the data says so.
    expect(starting.score! - learned.score!).toBe(Math.round((30 * (39 - 9)) / 100));
  });

  it('the stored calibration document is read through the repo (no map under the minimum of pairs)', async () => {
    const repo = createMemoryRepo();
    const entry = (pairs: number) => JSON.stringify({ intl: { map: { knots: [[0, 0], [100, 60]] }, priors: null, pairs, computedAt: NOW.toISOString(), priorsPairs: 0, priorsComputedAt: NOW.toISOString() } });
    repo.state.config['match.calibration.v1'] = entry(499);
    expect((await setup({ repo }).fits.getFits('u1', ['job1'])).get('job1')!.calibrated).toBe(false);
    const enough = createMemoryRepo();
    enough.state.config['match.calibration.v1'] = entry(500);
    expect((await setup({ repo: enough }).fits.getFits('u1', ['job1'])).get('job1')!.calibrated).toBe(true);
    const malformed = createMemoryRepo();
    malformed.state.config['match.calibration.v1'] = '{not json';
    expect((await setup({ repo: malformed }).fits.getFits('u1', ['job1'])).get('job1')).toMatchObject({ calibrated: false, kind: 'estimate' });
  });
});

describe('the wire shapes', () => {
  it('toWireKind keeps "pre" for an estimate; fitToView and fitToListResult carry the same score, tier and kind', async () => {
    expect(toWireKind('estimate')).toBe('pre');
    expect(toWireKind('ai')).toBe('ai');
    const { fits } = setup();
    const estimate = await fits.getFit('u1', 'job1');
    const view = fitToView(estimate);
    expect(view).toMatchObject({
      jobId: 'job1', score: estimate.score, tier: estimate.tier, kind: 'pre', summary: null, strengths: [], gaps: [], keywordsMatched: [], keywordsMissing: [],
      resumeVariantId: 'v1', estimateReason: null, summaryLocaleStale: false, cached: false,
      coverage: estimate.coverage, confidence: estimate.confidence, confidenceReason: estimate.confidenceReason, requirements: [], stale: false, calibrated: false,
    });
    expect(view.skills).toEqual({ aligned: ['TypeScript', 'Go'], missing: ['Kubernetes'], softSkills: [], listed: 3 });
    expect(fitToListResult(estimate)).toMatchObject({ jobId: 'job1', score: estimate.score, tier: estimate.tier, kind: 'pre', confidence: estimate.confidence });

    const ai = await fits.getFit('u1', 'job1', { allowModelCall: true });
    expect(fitToView(ai, { locale: 'en' })).toMatchObject({ kind: 'ai', score: ai.score, summary: 'Your payments work lines up well.', strengths: ['Your payments APIs in Go'], summaryLocaleStale: false, cached: false, requirements: [] });
    expect(fitToView(await fits.getFit('u1', 'job1'), { locale: 'zh' })).toMatchObject({ kind: 'ai', summaryLocaleStale: true, cached: true });
    expect(fitToListResult(ai).kind).toBe('ai');
  });

  it('requirements is always an empty list until scorer v4 writes it', async () => {
    const { fits } = setup();
    expect((await fits.getFit('u1', 'job1')).requirements).toEqual([]);
    expect((await fits.getFit('u1', 'job1', { allowModelCall: true })).requirements).toEqual([]);
  });

  it('assembleFit is pure: the same inputs give the same fit', () => {
    const input = { job: jobRecord(), user: matchUser(), resume: { id: 'v1', resumeContentHash: 'hash-1' }, config: CFG, pin: currentScorerPin('roboapply', MODEL_A), now: NOW };
    const a = assembleFit(input);
    expect(assembleFit(input)).toEqual(a);
    // With nothing stored it is the estimate, number for number.
    const estimate = preScore(matchUser(), toMatchJob(jobRecord()), CFG);
    expect(a).toMatchObject({ kind: 'estimate', score: estimate.score, tier: estimate.tier, coverage: estimate.coverage, confidence: estimate.confidence, dimensions: estimate.dimensions });
    expect(a.basis).toEqual({ resumeVariantId: 'v1', resumeContentHash: 'hash-1', jobContentHash: jobContentHash(jobRecord()), searchProfileVersion: 1 });
  });
});

describe('createFitService binds the three functions to a service built on fakes', () => {
  it('accepts a MatchService or { service }, and refuses anything else', async () => {
    const { service } = setup();
    for (const bound of [createFitService(service), createFitService({ service })]) {
      expect((await bound.getFits('u1', ['job1'])).get('job1')!.kind).toBe('estimate');
      expect((await bound.getFit('u1', 'job1')).jobId).toBe('job1');
      expect((await bound.getVariantFit('u1', 'job1', 'v1')).basis.resumeVariantId).toBe('v1');
    }
    expect(() => createFitService({} as never)).toThrow(/MatchService/);
    // The service has one fit reader, `fits`: no second set of top-level methods to drift from it.
    expect(service).not.toHaveProperty('getFits');
    expect(service).not.toHaveProperty('getFit');
    expect(fitFunctions(service)).toBe(service.fits);
  });
});

describe('the module-level functions bind a service', () => {
  it('getFit, getFits and getVariantFit run on the service set for tests (production: the default service, loaded lazily)', async () => {
    const { service } = setup();
    setFitServiceForTests(service);
    expect((await getFits('u1', ['job1'])).get('job1')!.kind).toBe('estimate');
    expect((await getFit('u1', 'job1')).jobId).toBe('job1');
    expect((await getVariantFit('u1', 'job1', 'v1')).basis.resumeVariantId).toBe('v1');
  });
});

describe('components of a stored row follow today\'s weights and logistics', () => {
  it('a weight change recomputes the total with no model call', async () => {
    const repo = createMemoryRepo();
    const first = await setup({ repo }).fits.getFit('u1', 'job1', { allowModelCall: true });
    const reweighted = setup({ repo, env: { MATCH_WEIGHTS: '{"title_level":10,"skills":60,"industry":10,"logistics":10,"career_path":10}' } });
    const fit = (await reweighted.fits.getFits('u1', ['job1'])).get('job1')!;
    expect(fit.kind).toBe('ai');
    expect(fit.score).toBe(Math.round((10 * 90 + 60 * 60 + 10 * 80 + 10 * 100) / 90));
    expect(fit.score).not.toBe(first.score);
    expect(fit.dimensions.map((d: MatchDimension) => d.weight)).toEqual([10, 60, 10, 10, 10]);
    expect(reweighted.scorer.run).not.toHaveBeenCalled();
  });
});

// ── MKT-2F: snapshots (I6), an ad-hoc posting, and "every consumer reads the contract" ──

describe('MKT-2F: fitSnapshot is what may be stored or mailed (strategy 2.2 I6)', () => {
  it('an estimate: score, tier and kind with the rubric and estimator, no model, and when it was computed', async () => {
    const { fits } = setup();
    const fit = await fits.getFit('u1', 'job1');
    expect(fit.kind).toBe('estimate');
    expect(fitSnapshot(fit)).toEqual({ score: fit.score, tier: fit.tier, kind: 'estimate', rubric: 'fit_v3', estimator: 'est_v2', model: null, scoredAt: NOW.toISOString() });
  });

  it('an AI fit: the model that wrote it and when it was scored (its own time, not the read time)', async () => {
    const t = setup();
    const scored = await t.fits.getFit('u1', 'job1', { allowModelCall: true });
    const later = setup({ repo: t.repo, now: () => new Date(NOW.getTime() + 3 * 86_400_000) });
    const read = await later.fits.getFit('u1', 'job1');
    const snap = fitSnapshot(read);
    expect(snap).toEqual({ score: scored.score, tier: scored.tier, kind: 'ai', rubric: 'fit_v3', estimator: 'est_v2', model: MODEL_A, scoredAt: NOW.toISOString() });
    // The list read gives the same snapshot (what an alert stores is what the job page shows).
    expect(fitSnapshot((await later.fits.getFits('u1', ['job1'])).get('job1')!)).toEqual(snap);
  });

  it('a snapshot parses back from stored JSON; anything else reads as "none" (a row written before snapshots)', async () => {
    const { fits } = setup();
    const snap = fitSnapshot(await fits.getFit('u1', 'job1'));
    expect(readFitSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
    expect(FitSnapshotSchema.safeParse(snap).success).toBe(true);
    for (const bad of [null, undefined, 72, 'good', {}, { score: 72 }, { ...snap, kind: 'pre' }, { ...snap, extra: 1 }, { ...snap, score: 140 }]) {
      expect(readFitSnapshot(bad)).toBeNull();
    }
    // No score is a valid snapshot of "nothing to compare" (never 0).
    expect(readFitSnapshot({ ...snap, score: null, tier: null })).toEqual({ ...snap, score: null, tier: null });
  });
});

describe('MKT-2F: estimateForPosting, the estimate of a posting that is not a stored job', () => {
  const posting = (over: Partial<AdhocPosting> = {}): AdhocPosting => {
    const { id: _id, visibility: _v, ownerUserId: _o, ...rest } = jobRecord();
    return { ...rest, ...over };
  };

  it('is the same fit a stored job with the same content gets before any AI read (one estimator, one assembly)', async () => {
    const { fits } = setup();
    const stored = await fits.getFit('u1', 'job1');
    const adhoc = await estimateForPosting('u1', posting(), fits);
    expect(adhoc).not.toBeNull();
    expect(shown(adhoc!)).toEqual(shown(stored));
    expect(adhoc).toMatchObject({ jobId: ADHOC_POSTING_ID, kind: 'estimate', coverage: stored.coverage, confidence: stored.confidence, dimensions: stored.dimensions, estimateReason: null });
  });

  it('never a model call, never a write, and no job row is read: the posting is handed over as a row', async () => {
    const { fits, repo, scorer } = setup();
    const before = { ...repo.calls };
    await estimateForPosting('u1', posting({ title: 'Staff Platform Engineer' }), fits);
    expect(scorer.run).not.toHaveBeenCalled();
    expect(repo.state.scores).toHaveLength(0);
    expect(repo.calls.saveScore ?? 0).toBe(0);
    expect(repo.calls.getJob ?? 0).toBe(before.getJob ?? 0);
    expect(repo.calls.getFitJobs ?? 0).toBe(before.getFitJobs ?? 0);
  });

  it('is an estimate even when the person has stored AI fits, and even for a row saved under the ad-hoc id by mistake', async () => {
    const t = setup();
    await t.fits.getFit('u1', 'job1', { allowModelCall: true });
    expect((await estimateForPosting('u1', posting(), t.fits))?.kind).toBe('estimate');
    // A stored row under the ad-hoc id (it cannot exist: no job has that id) is still never shown as the page's fit.
    t.repo.state.scores.push({ ...(t.repo.state.scores[0] as ScoreRecord), jobId: ADHOC_POSTING_ID });
    const fit = await estimateForPosting('u1', posting(), t.fits);
    expect(fit === null || fit.kind === 'estimate').toBe(true);
    expect(t.scorer.run).toHaveBeenCalledTimes(1);
  });

  it('with no resume it says so; with AI off it is the same estimate (no model either way)', async () => {
    const noResume = setup({ repo: createMemoryRepo({ resumes: [] }) });
    expect(await estimateForPosting('u1', posting(), noResume.fits)).toMatchObject({ kind: 'estimate', estimateReason: 'no_resume' });
    const off = setup({ aiAllowed: async () => false });
    expect((await estimateForPosting('u1', posting(), off.fits))?.kind).toBe('estimate');
    expect(off.scorer.run).not.toHaveBeenCalled();
  });

  it('a posting of another market than the request\'s brand has no fit (markets never mix)', async () => {
    const { fits } = setup();
    expect(await estimateForPosting('u1', posting({ market: 'cn' }), fits)).toBeNull();
    const cn = setup({ brand: () => getBrand('goapply'), repo: createMemoryRepo({ jobs: [jobRecord({ market: 'cn' })] }) });
    expect((await estimateForPosting('u1', posting({ market: 'cn' }), cn.fits))?.kind).toBe('estimate');
  });

  it('the module-level function reads the production binding (here: the test service)', async () => {
    const { service, scorer } = setup();
    setFitServiceForTests(service);
    const fit = await estimateForPosting('u1', posting());
    expect(fit).toMatchObject({ jobId: ADHOC_POSTING_ID, kind: 'estimate' });
    expect(scorer.run).not.toHaveBeenCalled();
  });
});

describe('MKT-2F: every consumer reads the fit contract (SM-5)', () => {
  /** Every production source file under server/src/features, as [repository path, text]. */
  function featureSources(): Array<[string, string]> {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const out: Array<[string, string]> = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(full);
        } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
          out.push([path.relative(root, full).split(path.sep).join('/'), readFileSync(full, 'utf8')]);
        }
      }
    };
    walk(root);
    return out;
  }

  /** The code of a file without its comments (block comments keep their line count). */
  const codeOf = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, '')).replace(/\/\/.*$/gm, '');

  /**
   * The item's own acceptance pattern, read literally: `preScoreMany`,
   * `preScoreJobs` or `scoreJob(` anywhere under features/ outside match/ and
   * resume/tailor/. One name is still left, and only where it is listed here:
   * the Assistant's adapter method `CopilotAreas.scoreJob` (declared in
   * copilot/types.ts, which no M2 bundle owns). It calls getFit /
   * getVariantFit, not the match scorer. When the method is renamed (handoff
   * MKT-2F, Request 2) these entries match nothing and can be deleted.
   */
  const ASSISTANT_ADAPTER: Record<string, RegExp> = {
    'copilot/types.ts': /^\s*scoreJob\(userId: string, jobId: string, options: /,
    'copilot/areas.ts': /^\s*async scoreJob\(userId, jobId, opts\) \{/,
    'copilot/tools/jobs.ts': /\bctx\.areas\.scoreJob\(/,
  };

  it('no code under features/ outside match/ and resume/tailor/ names preScoreMany, preScoreJobs or scoreJob( (the literal acceptance grep)', () => {
    const sources = featureSources().filter(([file]) => !file.startsWith('match/') && !file.startsWith('resume/tailor/'));
    expect(sources.length).toBeGreaterThan(200);
    const offenders: string[] = [];
    const adapterLines: string[] = [];
    for (const [file, text] of sources) {
      codeOf(text)
        .split('\n')
        .forEach((line, i) => {
          if (!/preScoreMany|preScoreJobs|scoreJob\(/.test(line)) return;
          const adapter = ASSISTANT_ADAPTER[file];
          if (adapter && adapter.test(line) && !/preScoreMany|preScoreJobs|matchService/.test(line)) adapterLines.push(file);
          else offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
    // The exception is exactly the adapter: its declaration, its implementation and analyze_fit's two calls, or nothing once it is renamed.
    expect([[], ['copilot/areas.ts', 'copilot/tools/jobs.ts', 'copilot/tools/jobs.ts', 'copilot/types.ts']]).toContainEqual([...adapterLines].sort());
  });

  it('the Assistant\'s adapter reads the fit contract and never the match scorer', () => {
    const areas = codeOf(featureSources().find(([file]) => file === 'copilot/areas.ts')![1]);
    expect(areas).toMatch(/\bgetFit\(/);
    expect(areas).toMatch(/\bgetVariantFit\(/);
    expect(areas).not.toMatch(/\bmatchService\b/);
    expect(areas).not.toMatch(/\bpreScore/);
  });

  it('a resume version reaches the match area only through getVariantFit (tailoring, and the Assistant\'s explicit version question) and the keyword check', () => {
    const allowed = new Set(['resume/tailor/fitDeps.ts', 'copilot/areas.ts']);
    const offenders = featureSources()
      .filter(([file, text]) => !file.startsWith('match/') && /\bgetVariantFit\b/.test(codeOf(text)) && !allowed.has(file))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('the deprecated list wrappers still answer getFits in the older shape, so no other domain breaks', async () => {
    const { service } = setup();
    const fit = (await service.fits.getFits('u1', ['job1'])).get('job1')!;
    expect(await service.preScoreMany('u1', ['job1'])).toEqual([fitToListResult(fit)]);
  });
});
