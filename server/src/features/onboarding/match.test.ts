// @vitest-environment node
//
// WP-30 O6 contract: a phase is emitted only after its server work finished;
// a run past the 120 s cap (or whose client left) leaves an `onboarding.match`
// queue item; the queued worker finishes the rest; the real count is stored.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import type { OnboardingMatchEvent } from './contract.js';
import { candidateQueryFor, rankPreScores, runOnboardingMatch, type MatchPipelineDeps } from './match.js';
import { createOnboardingMatchHandler, parseOnboardingMatchPayload } from './workers.js';
import { SAMPLE_BASICS, createMemoryRepo, preScoreFixture } from './testkit.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(seed: Record<string, unknown> = {}) {
  const mem = createMemoryRepo({ u1: { step: 'matching', path: 'urgent', answers: { basics: { ...SAMPLE_BASICS }, resume: { resumeVariantId: 'rv1' } }, ...seed } });
  mem.addResume('u1', { id: 'rv1', parsedData: {}, resumeMarkdown: 'text' });
  mem.setCandidates(['j1', 'j2', 'j3', 'j4']);
  const enqueued: Array<{ kind: string; payload: unknown; options: unknown }> = [];
  let clock = 0;
  const deps: MatchPipelineDeps = {
    repo: mem.repo,
    brand: { id: 'roboapply', market: 'intl' },
    now: () => clock,
    applyAnswers: vi.fn(async () => ({ id: 'sp1', version: 2 })),
    ingest: vi.fn(async () => ({})),
    preScore: vi.fn(async () => [preScoreFixture('j1', 50, 'possible'), preScoreFixture('j2', 85, 'great'), preScoreFixture('j3', 70, 'good'), preScoreFixture('j4', null, null)]),
    aiAllowed: vi.fn(async () => true),
    enqueue: vi.fn(async (kind, payload, options) => {
      enqueued.push({ kind, payload, options });
    }),
  };
  return { mem, deps, enqueued, advance: (ms: number) => (clock += ms) };
}

describe('phases are emitted only after their work', () => {
  it('waits on the ingest before saying "searching"', async () => {
    const { deps } = setup();
    const ingest = deferred();
    deps.ingest = vi.fn(() => ingest.promise);
    const events: OnboardingMatchEvent[] = [];
    const run = runOnboardingMatch(deps, 'u1', { emit: (e) => events.push(e) });
    await tick();
    await tick();
    expect(events.map((e) => (e.event === 'phase' ? e.data.phase : e.event))).toEqual(['reading', 'saving']);
    expect(deps.preScore).not.toHaveBeenCalled();
    ingest.resolve();
    await run;
    expect(events.map((e) => (e.event === 'phase' ? e.data.phase : e.event))).toEqual(['reading', 'saving', 'searching', 'comparing', 'ranking', 'done']);
  });

  it('waits on the pre-score before saying "comparing"', async () => {
    const { deps } = setup();
    const scores = deferred<ReturnType<typeof preScoreFixture>[]>();
    deps.preScore = vi.fn(() => scores.promise);
    const events: string[] = [];
    const run = runOnboardingMatch(deps, 'u1', { emit: (e) => events.push(e.event === 'phase' ? e.data.phase : e.event) });
    for (let i = 0; i < 6; i++) await tick();
    expect(events).toEqual(['reading', 'saving', 'searching']);
    scores.resolve([]);
    await run;
    expect(events.at(-1)).toBe('done');
  });

  it('marks reading skipped without a resume', async () => {
    const { deps } = setup({ answers: { basics: { ...SAMPLE_BASICS } } });
    const events: OnboardingMatchEvent[] = [];
    await runOnboardingMatch(deps, 'u1', { emit: (e) => events.push(e) });
    expect(events[0]).toEqual({ event: 'phase', data: { phase: 'reading', skipped: true } });
  });

  it('marks reading skipped when the chosen resume no longer exists (never "read" when nothing was)', async () => {
    const { deps } = setup({ answers: { basics: { ...SAMPLE_BASICS }, resume: { resumeVariantId: 'deleted' } } });
    const events: OnboardingMatchEvent[] = [];
    await runOnboardingMatch(deps, 'u1', { emit: (e) => events.push(e) });
    expect(events[0]).toEqual({ event: 'phase', data: { phase: 'reading', skipped: true } });
    expect(events.at(-1)?.event).toBe('done');
  });
});

describe('result', () => {
  it('counts Good fit or better, queues AI scoring for the top jobs, stores the result and moves to confirm', async () => {
    const { deps, mem, enqueued } = setup();
    const events: OnboardingMatchEvent[] = [];
    const result = await runOnboardingMatch(deps, 'u1', { emit: (e) => events.push(e) });
    expect(result).toMatchObject({ jobCount: 2, compared: 4, topJobIds: ['j2', 'j3', 'j1'], continuedInBackground: false });
    expect(events.at(-1)).toEqual({ event: 'done', data: { jobCount: 2, topJobIds: ['j2', 'j3', 'j1'], continuedInBackground: false } });
    expect(enqueued.filter((e) => e.kind === 'job.score').map((e) => (e.payload as { jobId: string }).jobId)).toEqual(['j2', 'j3', 'j1']);
    expect(mem.rows.get('u1')).toMatchObject({ step: 'confirm', answers: { matching: { jobCount: 2 } } });
  });

  it('queues no AI scoring when AI is not allowed', async () => {
    const { deps, enqueued } = setup();
    deps.aiAllowed = async () => false;
    await runOnboardingMatch(deps, 'u1');
    expect(enqueued.filter((e) => e.kind === 'job.score')).toEqual([]);
  });

  it('a failing provider still ranks what the index already holds', async () => {
    const { deps } = setup();
    deps.ingest = vi.fn(async () => {
      throw new Error('provider down');
    });
    expect(await runOnboardingMatch(deps, 'u1')).toMatchObject({ jobCount: 2 });
  });

  it('searches the O2 titles and places (public index only is the repo query contract)', () => {
    expect(candidateQueryFor({ basics: { ...SAMPLE_BASICS, jobFunctions: [...SAMPLE_BASICS.jobFunctions, { label: 'Custom role' }], jobTypes: ['full_time'], countries: ['US', 'REMOTE'] } }, 'intl')).toMatchObject({
      market: 'intl',
      taxonomyIds: ['backend_engineer'],
      titles: ['Custom role'],
      countries: ['US'],
      includeRemote: true,
    });
    expect(candidateQueryFor({ resumeSuggestions: { suggestedTaxonomyIds: ['data_analyst'] } }, 'intl')).toMatchObject({ taxonomyIds: ['data_analyst'], countries: [] });
    // A skipped O2 with places but no title: resume titles, the chosen places.
    expect(
      candidateQueryFor({ basics: { countries: ['TW'], remoteOk: false }, resumeSuggestions: { suggestedTaxonomyIds: ['data_analyst'] } }, 'intl'),
    ).toMatchObject({ taxonomyIds: ['data_analyst'], countries: ['TW'], includeRemote: false });
    expect(rankPreScores([preScoreFixture('b', null, null), preScoreFixture('a', 10, 'unlikely')]).map((r) => r.jobId)).toEqual(['a', 'b']);
  });
});

describe('the 120 s cap', () => {
  it('a run passing 120 s leaves an onboarding.match queue item and still moves on to confirm', async () => {
    const { deps, mem, enqueued, advance } = setup();
    deps.ingest = vi.fn(async () => {
      advance(125_000);
    });
    const events: OnboardingMatchEvent[] = [];
    const result = await runOnboardingMatch(deps, 'u1', { emit: (e) => events.push(e) });
    expect(result?.continuedInBackground).toBe(true);
    expect(enqueued).toContainEqual({ kind: 'onboarding.match', payload: { userId: 'u1', fromPhase: 'comparing' }, options: { userId: 'u1', dedupeKey: 'onboarding.match:u1' } });
    expect(deps.preScore).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ event: 'done', data: { jobCount: 0, topJobIds: [], continuedInBackground: true } });
    expect(mem.rows.get('u1')!.step).toBe('confirm');
  });

  it('a client that went away leaves the rest queued and emits nothing more', async () => {
    const { deps, enqueued } = setup();
    const controller = new AbortController();
    deps.applyAnswers = vi.fn(async () => {
      controller.abort();
      return { id: 'sp1', version: 2 };
    });
    const events: string[] = [];
    await runOnboardingMatch(deps, 'u1', { emit: (e) => events.push(e.event), signal: controller.signal });
    expect(events).toEqual(['phase', 'phase']);
    expect(enqueued.map((e) => e.kind)).toEqual(['onboarding.match']);
  });

  it('the queued item finishes the work in the background (no cap, stage untouched)', async () => {
    const { deps, mem } = setup({ step: 'confirm' });
    const handler = createOnboardingMatchHandler(() => deps);
    await handler({ id: 'w1', kind: 'onboarding.match', brand: 'roboapply', userId: 'u1', payload: { userId: 'u1', fromPhase: 'comparing' }, attempts: 1, maxAttempts: 5, dedupeKey: null, priority: 100 });
    expect(deps.preScore).toHaveBeenCalledTimes(1);
    expect(deps.ingest).not.toHaveBeenCalled();
    expect(mem.rows.get('u1')).toMatchObject({ step: 'confirm', answers: { matching: { jobCount: 2, continuedInBackground: false } } });
  });

  it('a malformed payload is permanent; an unknown phase restarts at saving', () => {
    expect(() => parseOnboardingMatchPayload({ payload: {}, userId: null })).toThrow(/userId/);
    expect(parseOnboardingMatchPayload({ payload: { fromPhase: 'warp' }, userId: 'u1' })).toEqual({ userId: 'u1', fromPhase: 'saving' });
  });
});
