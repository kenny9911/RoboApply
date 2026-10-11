// @vitest-environment node
//
// The invariants of finished phases, inside `npm test` (MARKET_STRATEGY 2.2 and
// 2.6; SM-1, SM-5). `npm run eval:match` runs the same specs through its own
// config; this file makes them gate every later change:
//
//   - INV-1, 2, 3, 4, 5, 6, 8, 9, 10 are due at or before M2 and must hold.
//     INV-7 (the three-state keyword check) is due M4: it runs here too, its
//     result is recorded, and it does not fail the run until then.
//   - "The contract test calls every seam and gets one score" (SM-5): every
//     surface of eval/seamRegistry.ts, read for one person and one job, once
//     with no stored AI fit and once with a fresh one.
//   - I8 at seam level: on GoApply without the AI consent, reading every
//     surface calls no model, spends no allowance and shows no stored AI fit.
//   - Completeness: a source file that reads the fit contract and is not
//     listed below fails here, so a new fit surface cannot ship unregistered.
//
// Everything runs on in-memory fakes: no model, no database, no network.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { INVARIANT_LIST, isEnforced } from './invariantList.js';
import { registerInvariants } from './invariants.eval.js';
import { FIT_SEAMS, REQUIRED_FIT_SEAMS, type FitSeam, type SeamContext } from './seamRegistry.js';
import { REPO_ROOT, loadSeam, toSeamFit, type SeamFit } from './seams.js';
import { createWorld, defaultUserInputs, freshAiRow, jobRecord, userWith, type World } from './world.js';

// ── The invariants due by M2 ──────────────────────────────────────────────

registerInvariants({ enforce: 'M2' });

describe('which invariants gate npm test', () => {
  it('the nine due at or before M2 are enforced; INV-7 stays pending until M4', () => {
    const enforced = INVARIANT_LIST.filter((i) => isEnforced(i.due, 'M2')).map((i) => i.id);
    expect(enforced).toEqual(['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6', 'INV-8', 'INV-9', 'INV-10']);
    expect(INVARIANT_LIST.filter((i) => !isEnforced(i.due, 'M2')).map((i) => [i.id, i.due])).toEqual([['INV-7', 'M4']]);
  });
});

// ── Every seam, one fit (SM-5; I1, I2) ────────────────────────────────────

const USER = 'u1';
const JOB = 'job1';

const describeFit = (f: SeamFit) => `${f.score ?? 'no score'} / ${f.tier ?? 'no tier'} / ${f.kind}`;

async function reference(world: World): Promise<SeamFit> {
  return toSeamFit(await (await world.fit()).getFit(USER, JOB));
}

async function read(seam: FitSeam, ctx: SeamContext): Promise<SeamFit> {
  return toSeamFit(await seam.read(USER, JOB, ctx));
}

describe('the registry lists every fit surface', () => {
  it('holds every required name once, the onboarding result among them', () => {
    const names = FIT_SEAMS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...REQUIRED_FIT_SEAMS].sort());
    expect(REQUIRED_FIT_SEAMS).toHaveLength(10);
    expect(names).toContain('onboarding_result');
    // The nine names invariant I1 was written with are all still there.
    for (const name of ['feed_card', 'job_detail', 'similar_jobs', 'alert_selection', 'ready_list', 'assistant_stored_fit', 'assistant_analyze_fit', 'extension_chip', 'tailoring_kit']) {
      expect(names).toContain(name);
    }
  });

  it('every seam names a module that exists', async () => {
    for (const seam of FIT_SEAMS) expect(statSync(path.resolve(REPO_ROOT, seam.modulePath)).isFile(), seam.modulePath).toBe(true);
  });
});

describe.each(['estimate', 'ai'] as const)('one person, one job, one fit on every surface (%s)', (scenario) => {
  const world = createWorld({ scores: scenario === 'ai' ? [freshAiRow()] : [] });
  const ctx: SeamContext = { world, scenario };

  it('getFit answers the kind the scenario holds, with a score (I2: a fresh AI fit beats an estimate)', async () => {
    const ref = await reference(world);
    expect(ref.kind).toBe(scenario);
    expect(typeof ref.score).toBe('number');
    expect(ref.tier).not.toBeNull();
  });

  it.each(FIT_SEAMS.map((s) => [s.name, s] as const))('%s shows that fit: the same score, tier and kind', async (_name, seam) => {
    const ref = await reference(world);
    const got = await read(seam, ctx);
    expect(got, `${seam.surface} shows ${describeFit(got)}, getFit says ${describeFit(ref)}`).toEqual(ref);
  });

  it('reading every surface called no model', async () => {
    for (const seam of FIT_SEAMS) await read(seam, ctx);
    expect(world.scorer.calls).toBe(0);
    expect(world.embeddings.calls).toBe(0);
    expect(world.planner.calls).toBe(0);
  });
});

describe('a change of the fit reaches every surface at once (no surface holds its own copy)', () => {
  it('after a new AI fit is stored, every surface shows it; none keeps the estimate it showed before', async () => {
    const world = createWorld();
    const before = await reference(world);
    expect(before.kind).toBe('estimate');
    for (const seam of FIT_SEAMS) expect(await read(seam, { world, scenario: 'estimate' })).toEqual(before);
    // A fit arrives (the precompute cron or the job page scored it).
    world.repo.state.scores.push(freshAiRow() as never);
    const after = await reference(world);
    expect(after.kind).toBe('ai');
    for (const seam of FIT_SEAMS) {
      const got = await read(seam, { world, scenario: 'ai' });
      expect(got, `${seam.surface} still shows ${describeFit(got)}`).toEqual(after);
    }
    expect(world.scorer.calls).toBe(0);
  });
});

// ── A thin quick estimate: low confidence changes the order, never the fit shown ──

describe('a quick estimate with low confidence (a posting that says little)', () => {
  /**
   * A posting with a title and skills this person has, and nothing about level,
   * industry, place or pay: it states under 60% of the rubric, so the estimate
   * is Good on what little there is, with low confidence.
   */
  const thinWorld = () => {
    const user = defaultUserInputs();
    return createWorld({
      jobs: [
        jobRecord({
          seniority: null,
          minYears: null,
          companyIndustries: [],
          qualifications: null,
          salaryAnnualMin: null,
          salaryAnnualMax: null,
          salaryCurrency: null,
          workModel: null,
          location: null,
          locationCity: null,
          locationCountry: null,
          geoLat: null,
          geoLng: null,
        }),
      ],
      users: {
        u1: {
          ...user,
          experience: [{ title: 'Senior Backend Engineer', company: 'PayCo', startYm: '2019-01', endYm: null, current: true, kind: 'work' }],
          profile: { ...user.profile!, skills: ['TypeScript', 'Kubernetes', 'Go'].map((name) => ({ name, confirmed: true })) },
        },
      },
    });
  };

  it('is a Good estimate with low confidence: the case where a surface could be tempted to show less than the fit', async () => {
    const world = thinWorld();
    const fit = (await (await world.fit()).getFit(USER, JOB)) as { kind?: unknown; tier?: unknown; confidence?: unknown; confidenceReason?: unknown };
    expect(fit).toMatchObject({ kind: 'estimate', tier: 'good', confidence: 'low' });
    expect(fit.confidenceReason).toBeTruthy();
  });

  it.each(FIT_SEAMS.map((s) => [s.name, s] as const))('%s shows the same score, tier and kind as getFit', async (_name, seam) => {
    const world = thinWorld();
    const ref = await reference(world);
    const got = await read(seam, { world, scenario: 'estimate' });
    expect(got, `${seam.surface} shows ${describeFit(got)}, getFit says ${describeFit(ref)}`).toEqual(ref);
    expect(world.scorer.calls).toBe(0);
  });

  it('the alert does send it, and its card shows Good as the feed card does: counting it as Possible only orders the list', async () => {
    const world = thinWorld();
    const alert = FIT_SEAMS.find((s) => s.name === 'alert_selection')!;
    const feed = FIT_SEAMS.find((s) => s.name === 'feed_card')!;
    const card = await read(alert, { world, scenario: 'estimate' });
    expect(card).toEqual(await read(feed, { world, scenario: 'estimate' }));
    expect(card.tier).toBe('good');
    expect(card.kind).toBe('estimate');
  });
});

// ── I8 at seam level ──────────────────────────────────────────────────────

/** GoApply, 个性化推荐 granted, the "Use AI" consent NOT given. */
function goApplyWorld(scores: Array<Record<string, unknown>> = []): World {
  const job = jobRecord({
    market: 'cn',
    title: '后端开发工程师',
    location: '上海',
    locationCity: '上海',
    locationCountry: 'CN',
    geoLat: null,
    geoLng: null,
    salaryAnnualMin: 240000,
    salaryAnnualMax: 336000,
    salaryCurrency: 'CNY',
  });
  const user = userWith({ taxonomyIds: ['backend_engineer'], locations: [{ label: '上海', city: '上海', country: 'CN', radiusKm: 0 }] });
  return createWorld({ brand: 'goapply', aiAllowed: false, jobs: [job], users: { u1: user }, scores });
}

describe('I8: GoApply without the AI consent, every surface', () => {
  it.each([
    ['nothing stored', [] as Array<Record<string, unknown>>],
    // A score written while the consent was given: it is not shown once the consent is gone.
    ['an AI fit stored from before the consent was withdrawn', [freshAiRow()]],
  ])('%s: every surface shows the quick estimate, and no model is called', async (_name, scores) => {
    const world = goApplyWorld(scores);
    const ref = await reference(world);
    expect(ref.kind).toBe('estimate');
    for (const scenario of ['estimate', 'ai'] as const) {
      for (const seam of FIT_SEAMS) {
        const got = await read(seam, { world, scenario });
        expect(got, `${seam.surface} shows ${describeFit(got)} without the AI consent`).toEqual(ref);
      }
    }
    // The counting fakes: no scorer call, no embeddings call, no planner call, and no allowance spent on a refusal.
    expect(world.scorer.calls).toBe(0);
    expect(world.embeddings.calls).toBe(0);
    expect(world.planner.calls).toBe(0);
    expect(world.consume.calls).toBe(0);
    // Nothing was written either.
    expect(world.repo.state.scores).toHaveLength(scores.length);
  });

  it('the consent decides, not the caller: a read that allows a model call is still an estimate with zero calls', async () => {
    const world = goApplyWorld();
    const api = await world.fit();
    const fit = await api.getFit(USER, JOB, { allowModelCall: true, mode: 'on_demand' });
    expect(toSeamFit(fit).kind).toBe('estimate');
    expect(world.scorer.calls).toBe(0);
    expect(world.consume.calls).toBe(0);
  });
});

// ── Completeness: no fit surface outside the registry ─────────────────────

/**
 * Every production source file outside `features/match/` that reads the fit
 * contract (`getFit`, `getFits`, `getVariantFit`, `estimateForPosting`), with
 * the registry seams it serves, or why it is not a surface. A static list:
 * when the scan below finds a file that is not here, add the surface to
 * eval/seamRegistry.ts and the file to this list in the same change.
 */
const FIT_READERS: Record<string, { seams: readonly string[]; note?: string }> = {
  'server/src/features/feed/FeedQueryService.ts': { seams: ['feed_card'] },
  'server/src/features/feed/defaultService.ts': { seams: ['feed_card'], note: 'the production wiring of the feed service' },
  'server/src/features/feed/testkit.ts': { seams: [], note: 'the feed test kit (a fake `match` dependency), not a surface' },
  'server/src/features/jobs/detail/defaultService.ts': { seams: ['job_detail', 'similar_jobs'] },
  'server/src/features/alerts/service.ts': { seams: ['alert_selection'] },
  'server/src/features/agent/deps.ts': { seams: ['ready_list'] },
  'server/src/features/copilot/areas.ts': { seams: ['assistant_stored_fit', 'assistant_analyze_fit'] },
  'server/src/features/extension/defaultDeps.ts': {
    seams: ['extension_chip'],
    note: 'also the estimate of a page that is not a stored job (`estimateForPosting`): no stored job, so no seam; extension/defaultDeps.test.ts holds it to the same estimator',
  },
  'server/src/features/resume/tailor/fitDeps.ts': { seams: ['tailoring_kit'], note: 'also "With this version" (`getVariantFit`), a separately named measure that is not the fit' },
  'server/src/features/onboarding/defaults.ts': { seams: ['onboarding_result'] },
  'server/src/features/resume/store.ts': {
    seams: [],
    note: 'the keyword report shows THE fit of the main resume only when it is an AI fit, so it has no reading for an estimate; resume/tailor/fitWiring.test.ts checks it equals `getFit`',
  },
  'server/src/features/lifecycle/repo.ts': {
    seams: [],
    note: 'the tailoring tip names a job only when its fit is an AI fit at Good or better, so it has no reading for an estimate; lifecycle.test.ts checks it reads `getFits`',
  },
};

/** The exports of each seam's module that the registry runs: a renamed or removed one fails here by name. */
const SEAM_EXPORTS: Record<(typeof REQUIRED_FIT_SEAMS)[number], readonly string[]> = {
  feed_card: ['server/src/features/feed/FeedQueryService.ts#createFeedQueryService'],
  job_detail: ['server/src/features/jobs/detail/service.ts#createJobDetailService'],
  similar_jobs: ['server/src/features/jobs/detail/service.ts#createJobDetailService'],
  alert_selection: ['server/src/features/alerts/service.ts#createJobAlertsTask', 'server/src/features/alerts/service.ts#scoredFromFits'],
  ready_list: ['server/src/features/agent/deps.ts#readyListFits'],
  assistant_stored_fit: ['server/src/features/copilot/areas.ts#createDefaultAreas'],
  assistant_analyze_fit: ['server/src/features/copilot/tools/jobs.ts#analyzeFit', 'server/src/features/copilot/areas.ts#createDefaultAreas'],
  extension_chip: ['server/src/features/extension/defaultDeps.ts#extensionMatchDeps'],
  tailoring_kit: ['server/src/features/resume/tailor/TailorService.ts#TailorService', 'server/src/features/resume/tailor/fitDeps.ts#tailorFitDeps'],
  onboarding_result: ['server/src/features/onboarding/match.ts#runOnboardingMatch', 'server/src/features/onboarding/match.ts#fitsForRanking'],
};

const READS_THE_CONTRACT = /\b(getFit|getFits|getVariantFit|estimateForPosting)\b/;

/** The code of a file without its comments. */
const codeOf = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function productionSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'generated') continue;
      productionSources(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('no fit surface outside the registry', () => {
  const serverSrc = path.resolve(REPO_ROOT, 'server/src');
  const matchDir = `${path.resolve(serverSrc, 'features/match')}${path.sep}`;
  const readers = productionSources(serverSrc)
    .filter((file) => !file.startsWith(matchDir))
    .filter((file) => READS_THE_CONTRACT.test(codeOf(readFileSync(file, 'utf8'))))
    .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
    .sort();

  it('every file that reads the fit contract is listed with its seam (add the surface to eval/seamRegistry.ts first)', () => {
    expect(readers).toEqual(Object.keys(FIT_READERS).sort());
  });

  it('every listed reader names registered seams, or says why it is not a surface; every seam has a reader', () => {
    const registered = new Set(FIT_SEAMS.map((s) => s.name));
    const served = new Set<string>();
    for (const [file, entry] of Object.entries(FIT_READERS)) {
      for (const seam of entry.seams) {
        expect(registered.has(seam), `${file} names the unregistered seam "${seam}"`).toBe(true);
        served.add(seam);
      }
      if (!entry.seams.length) expect(entry.note, `${file} serves no seam and does not say why`).toBeTruthy();
    }
    expect([...served].sort()).toEqual([...registered].sort());
  });

  it('the exports the registry runs exist under the names it loads them by', async () => {
    expect(Object.keys(SEAM_EXPORTS).sort()).toEqual([...REQUIRED_FIT_SEAMS].sort());
    for (const specs of Object.values(SEAM_EXPORTS)) {
      for (const spec of specs) expect(await loadSeam(spec), spec).toBeDefined();
    }
  });

  it('a surface that is not wired fails by name (the registry never answers for a module it could not load)', async () => {
    await expect(loadSeam('server/src/features/match/fit.ts#noSuchFitSurface')).rejects.toMatchObject({ name: 'SeamMissing' });
  });
});
