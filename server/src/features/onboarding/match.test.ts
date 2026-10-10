// @vitest-environment node
//
// WP-30 O6 contract: a phase is emitted only after its server work finished;
// a run past the 120 s cap (or whose client left) leaves an `onboarding.match`
// queue item; the queued worker finishes the rest; the real count is stored.
// INT-08: GoApply searches the G4 intent, and without the 个性化推荐 consent the
// jobs are found but not compared with the profile (no pre-score, no AI).

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import type { OnboardingMatchEvent } from './contract.js';
import { ONBOARDING_MATCH_CANDIDATES, candidateQueryFor, rankPreScores, runOnboardingMatch, type MatchPipelineDeps } from './match.js';
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

  // Verification finding (D3): the confirm heading called a number a "fit"
  // when no resume was compared. The result now says what was compared.
  it('says whether a resume was compared and whether the candidate cap was reached', async () => {
    const withResume = setup();
    expect(await runOnboardingMatch(withResume.deps, 'u1')).toMatchObject({ jobCount: 2, compared: 4, ranked: true, resumeCompared: true, comparedCapped: false });

    const noResume = setup({ answers: { basics: { ...SAMPLE_BASICS } } });
    expect(await runOnboardingMatch(noResume.deps, 'u1')).toMatchObject({ compared: 4, resumeCompared: false, comparedCapped: false });

    const gone = setup({ answers: { basics: { ...SAMPLE_BASICS }, resume: { resumeVariantId: 'deleted' } } });
    expect(await runOnboardingMatch(gone.deps, 'u1')).toMatchObject({ resumeCompared: false });

    const full = setup();
    full.mem.setCandidates(Array.from({ length: ONBOARDING_MATCH_CANDIDATES }, (_, i) => `j${i}`));
    expect(await runOnboardingMatch(full.deps, 'u1')).toMatchObject({ compared: ONBOARDING_MATCH_CANDIDATES, comparedCapped: true });

    // A queued run starts after `reading`: the resume is still looked up.
    const queued = setup({ step: 'confirm' });
    expect(await runOnboardingMatch(queued.deps, 'u1', { background: true, fromPhase: 'comparing' })).toMatchObject({ resumeCompared: true });
  });

  // Review finding (D3): with no resume the heading says "N jobs for your
  // search", but N was the comparison's own query (titles and countries only,
  // at most 200, nothing without a title). A user who skipped every step read
  // "no jobs for your search" while the saved search listed the whole index.
  describe('the saved search size, for a result with no resume compared', () => {
    it('stores the feed count of the saved search, asked after the search was written', async () => {
      const { deps } = setup({ answers: { basics: { ...SAMPLE_BASICS } } });
      const order: string[] = [];
      deps.applyAnswers = vi.fn(async () => {
        order.push('saved');
        return { id: 'sp1', version: 2 };
      });
      deps.searchCount = vi.fn(async () => {
        order.push('counted');
        return { count: 37, capped: false };
      });
      const result = await runOnboardingMatch(deps, 'u1');
      expect(result).toMatchObject({ compared: 4, resumeCompared: false, searchCount: 37, searchCountCapped: false });
      expect(deps.searchCount).toHaveBeenCalledWith('u1');
      expect(order).toEqual(['saved', 'counted']);
    });

    it('every step skipped: nothing can be compared, and the unfiltered search still has its real size', async () => {
      const { deps, mem } = setup({ answers: {} });
      mem.setCandidates([]); // no title to look for
      deps.searchCount = vi.fn(async () => ({ count: 1586, capped: false }));
      const result = await runOnboardingMatch(deps, 'u1');
      expect(result).toMatchObject({ jobCount: 0, compared: 0, resumeCompared: false, searchCount: 1586, searchCountCapped: false });
      expect(mem.rows.get('u1')).toMatchObject({ step: 'confirm', answers: { matching: { searchCount: 1586 } } });
    });

    it('passes on the feed cap ("N+")', async () => {
      const { deps } = setup({ answers: { basics: { ...SAMPLE_BASICS } } });
      deps.searchCount = vi.fn(async () => ({ count: 5000, capped: true }));
      expect(await runOnboardingMatch(deps, 'u1')).toMatchObject({ searchCount: 5000, searchCountCapped: true });
    });

    it('is not asked when a resume was compared: that heading is the fit count', async () => {
      const { deps } = setup();
      deps.searchCount = vi.fn(async () => ({ count: 1586, capped: false }));
      const result = await runOnboardingMatch(deps, 'u1');
      expect(result).toMatchObject({ jobCount: 2, resumeCompared: true });
      expect(result).not.toHaveProperty('searchCount');
      expect(deps.searchCount).not.toHaveBeenCalled();
    });

    it('stores no number when the feed cannot count, fails, or is not wired (never a stand-in)', async () => {
      const unknown = setup({ answers: { basics: { ...SAMPLE_BASICS } } });
      unknown.deps.searchCount = vi.fn(async () => ({ count: null, capped: false }));
      expect(await runOnboardingMatch(unknown.deps, 'u1')).not.toHaveProperty('searchCount');

      const failing = setup({ answers: { basics: { ...SAMPLE_BASICS } } });
      failing.deps.searchCount = vi.fn(async () => {
        throw new Error('count timed out');
      });
      const result = await runOnboardingMatch(failing.deps, 'u1');
      expect(result).toMatchObject({ compared: 4, resumeCompared: false });
      expect(result).not.toHaveProperty('searchCount');
      // The run still finishes and setup moves on.
      expect(failing.mem.rows.get('u1')!.step).toBe('confirm');

      const unwired = setup({ answers: { basics: { ...SAMPLE_BASICS } } });
      expect(await runOnboardingMatch(unwired.deps, 'u1')).not.toHaveProperty('searchCount');
    });
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

  // Verification finding: a queued run that started at `saving` re-applied the
  // onboarding answers minutes later, over a search the user had since edited.
  it('a queued run never writes the saved search: it searches for the search as it is now', async () => {
    const { deps, mem } = setup({ step: 'done', completedAt: new Date('2026-10-10T19:00:00Z') });
    deps.currentProfile = vi.fn(async () => ({ id: 'sp1', version: 30 }));
    const handler = createOnboardingMatchHandler(() => deps);
    await handler({ id: 'w2', kind: 'onboarding.match', brand: 'roboapply', userId: 'u1', payload: { userId: 'u1', fromPhase: 'saving' }, attempts: 1, maxAttempts: 5, dedupeKey: null, priority: 100 });
    expect(deps.applyAnswers).not.toHaveBeenCalled();
    expect(deps.currentProfile).toHaveBeenCalledWith('u1');
    expect(deps.ingest).toHaveBeenCalledWith('sp1', expect.any(Number));
    // The count is still stored for the confirm screen; the stage is not moved.
    expect(mem.rows.get('u1')).toMatchObject({ step: 'done', answers: { matching: { jobCount: 2 } } });
  });

  it('a queued run is read-only even while the user is still at "Finding jobs" (each step already saved its answers)', async () => {
    const { deps } = setup();
    deps.currentProfile = vi.fn(async () => ({ id: 'sp1', version: 4 }));
    await runOnboardingMatch(deps, 'u1', { background: true, fromPhase: 'saving' });
    expect(deps.applyAnswers).not.toHaveBeenCalled();
    expect(deps.ingest).toHaveBeenCalledWith('sp1', expect.any(Number));
  });

  it('a live re-run from the tour does not write the saved search either, and says the save line was skipped', async () => {
    const { deps } = setup({ step: 'tour' });
    deps.currentProfile = vi.fn(async () => ({ id: 'sp1', version: 9 }));
    const events: OnboardingMatchEvent[] = [];
    await runOnboardingMatch(deps, 'u1', { emit: (e) => events.push(e) });
    expect(deps.applyAnswers).not.toHaveBeenCalled();
    expect(events).toContainEqual({ event: 'phase', data: { phase: 'saving', skipped: true } });
    // At `matching` and `confirm` the screen itself still writes.
    for (const step of ['matching', 'confirm']) {
      const live = setup({ step });
      await runOnboardingMatch(live.deps, 'u1');
      expect(live.deps.applyAnswers).toHaveBeenCalledTimes(1);
    }
  });

  it('a malformed payload is permanent; an unknown phase restarts at saving', () => {
    expect(() => parseOnboardingMatchPayload({ payload: {}, userId: null })).toThrow(/userId/);
    expect(parseOnboardingMatchPayload({ payload: { fromPhase: 'warp' }, userId: 'u1' })).toEqual({ userId: 'u1', fromPhase: 'saving' });
  });
});

// ── INT-08: GoApply ───────────────────────────────────────────────────────

describe('GoApply O6', () => {
  const INTENT = { targetRoles: [{ taxonomyId: 'product_manager', label: '产品经理' }, { label: '管培生' }], cities: ['上海', '杭州'], workType: 'full_time' };

  function cn(personalized: boolean | undefined, answers: Record<string, unknown> = { intent: INTENT }) {
    const t = setup({ path: null, answers });
    t.deps.brand = { id: 'goapply', market: 'cn' };
    if (personalized !== undefined) t.deps.personalized = vi.fn(async () => personalized);
    return t;
  }

  it('searches the G4 roles and cities in the cn index (never the RoboApply basics)', () => {
    expect(candidateQueryFor({ intent: INTENT, basics: { ...SAMPLE_BASICS } }, 'cn')).toEqual({
      market: 'cn',
      taxonomyIds: ['product_manager'],
      titles: ['管培生'],
      countries: [],
      cities: ['上海', '杭州'],
      includeRemote: true,
      limit: 200,
    });
    // 不限 = every city.
    expect(candidateQueryFor({ intent: { ...INTENT, cities: ['any'] } }, 'cn').cities).toEqual([]);
    // No intent yet (left early before G4): the resume's titles stand in; RoboApply ignores a stray intent.
    expect(candidateQueryFor({ resumeSuggestions: { suggestedTaxonomyIds: ['data_analyst'] } }, 'cn')).toMatchObject({ market: 'cn', taxonomyIds: ['data_analyst'] });
    expect(candidateQueryFor({ intent: INTENT, basics: { ...SAMPLE_BASICS } }, 'intl')).toMatchObject({ market: 'intl', taxonomyIds: ['backend_engineer'] });
  });

  it('with 个性化推荐 on: compared with the profile, like RoboApply', async () => {
    const { deps, mem, enqueued } = cn(true);
    const result = await runOnboardingMatch(deps, 'u1');
    expect(result).toMatchObject({ jobCount: 2, compared: 4, ranked: true });
    expect(mem.candidateQueries[0]).toMatchObject({ market: 'cn', taxonomyIds: ['product_manager'], cities: ['上海', '杭州'] });
    expect(enqueued.filter((e) => e.kind === 'job.score')).toHaveLength(3);
  });

  it('with 个性化推荐 off or unanswered: jobs are found, not compared — no pre-score, no AI analysis, ranked: false', async () => {
    const { deps, mem, enqueued } = cn(false);
    const events: OnboardingMatchEvent[] = [];
    const result = await runOnboardingMatch(deps, 'u1', { emit: (e) => events.push(e) });
    expect(result).toMatchObject({ jobCount: 4, compared: 4, topJobIds: [], ranked: false, continuedInBackground: false });
    expect(deps.preScore).not.toHaveBeenCalled();
    expect(deps.aiAllowed).not.toHaveBeenCalled();
    expect(enqueued.filter((e) => e.kind === 'job.score')).toEqual([]);
    // The two lines that did not happen are reported as skipped, never as done.
    expect(events.filter((e) => e.event === 'phase').map((e) => (e.event === 'phase' ? [e.data.phase, e.data.skipped === true] : null))).toEqual([
      ['reading', true],
      ['saving', false],
      ['searching', false],
      ['comparing', true],
      ['ranking', true],
    ]);
    expect(events.at(-1)).toEqual({ event: 'done', data: { jobCount: 4, topJobIds: [], continuedInBackground: false } });
    expect(mem.rows.get('u1')).toMatchObject({ step: 'confirm', answers: { matching: { ranked: false, jobCount: 4 } } });
    // The consent is read once per run.
    expect(deps.personalized).toHaveBeenCalledTimes(1);
  });

  it('with 个性化推荐 off the saved search size is stored too (jobs found, not compared)', async () => {
    const { deps } = cn(false);
    deps.searchCount = vi.fn(async () => ({ count: 12, capped: false }));
    expect(await runOnboardingMatch(deps, 'u1')).toMatchObject({ ranked: false, resumeCompared: false, searchCount: 12, searchCountCapped: false });
  });

  it('AI consent off (personalised on): the quick estimate only, zero model work queued', async () => {
    const { deps, enqueued } = cn(true);
    deps.aiAllowed = vi.fn(async () => false);
    expect(await runOnboardingMatch(deps, 'u1')).toMatchObject({ jobCount: 2, ranked: true });
    expect(enqueued.filter((e) => e.kind === 'job.score')).toEqual([]);
  });

  it('with the job feed off (R-14 mode off) nothing is searched or counted, and the lines say so', async () => {
    const { deps, mem, enqueued } = cn(true);
    deps.searchAllowed = () => false;
    deps.searchCount = vi.fn(async () => ({ count: 99, capped: false }));
    const events: OnboardingMatchEvent[] = [];
    const result = await runOnboardingMatch(deps, 'u1', { emit: (e) => events.push(e) });
    expect(result).toMatchObject({ jobCount: 0, compared: 0, topJobIds: [], ranked: false });
    expect(deps.ingest).not.toHaveBeenCalled();
    expect(mem.candidateQueries).toEqual([]);
    expect(deps.preScore).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
    expect(result).not.toHaveProperty('searchCount');
    expect(events.filter((e) => e.event === 'phase' && e.data.skipped === true).map((e) => (e.event === 'phase' ? e.data.phase : ''))).toEqual(['reading', 'searching', 'comparing', 'ranking']);
    // Setup still moves on.
    expect(mem.rows.get('u1')!.step).toBe('confirm');
  });
});
