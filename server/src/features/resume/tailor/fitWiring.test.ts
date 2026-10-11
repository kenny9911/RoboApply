// @vitest-environment node
//
// MKT-2F: the production wiring of the tailoring fits (`defaultTailorDeps`,
// resume/index.ts) over an in-memory MatchService with a counting scorer:
//   canonicalFit  →  match `getFit`: the person's MAIN resume, whatever
//                    version the session started from (strategy 2.2);
//   variantFit    →  match `getVariantFit`: the named version only.
// The job page (`getFit` with no model call) and "Your fit" are one number.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { getBrand } from '../../../platform/brand/registry.js';
import { fitSnapshot, setFitServiceForTests } from '../../match/fit.js';
import { createMatchService } from '../../match/MatchService.js';
import { RESUME_MD, createMemoryRepo, jobRecord, resumeRecord } from '../../match/testkit.js';
import { EVAL_SCORER_MODEL, freshAiRow } from '../../match/eval/world.js';
import { defaultTailorDeps } from '../index.js';
import { setPrimaryVariantLookup } from '../primaryVariant.js';
import { createPrismaResumeCheckStore, fitRowForVersion, fitRowFromContract } from '../store.js';

const NOW = new Date('2026-10-10T08:00:00Z');

function world(scores: Array<Record<string, unknown>> = []) {
  const repo = createMemoryRepo({
    scores: scores as never,
    resumes: [
      { ...resumeRecord(), userId: 'u1' },
      { ...resumeRecord({ id: 'v_tailored', resumeMarkdown: `${RESUME_MD}\n- Kubernetes operator work`, resumeContentHash: 'hash-tailored' }), userId: 'u1' },
    ],
  });
  const scorer = {
    run: vi.fn(async () => ({
      dimensions: { title_level: { score: 80, evidence: [] }, skills: { score: 70, evidence: [] }, industry: { score: null, evidence: [] }, career_path: { score: 60, evidence: [] } },
      strengths: [],
      gaps: [],
      keywordsMatched: [],
      keywordsMissing: [],
      summary: null,
    })),
  };
  const service = createMatchService({
    repo,
    scorer,
    resolveModel: () => EVAL_SCORER_MODEL,
    routeAllowed: () => true,
    aiAllowed: async () => true,
    consume: async () => ({ allowed: true, retryAfterSec: 0, remaining: 100, windows: [] }),
    costLog: async () => undefined,
    profileSnapshot: async () => null,
    brand: () => getBrand('roboapply'),
    env: {},
    now: () => NOW,
  });
  setFitServiceForTests(service);
  return { repo, scorer, service, deps: defaultTailorDeps() };
}

afterEach(() => {
  setFitServiceForTests(null);
  setPrimaryVariantLookup(null);
});

/** The person's resumes as the lookup of primaryVariant.ts reads them: `v1` is marked primary. */
function mainResumeIs(id: string | null, lookups = { calls: 0 }) {
  setPrimaryVariantLookup({
    findPrimary: async () => {
      lookups.calls += 1;
      return id ? { id } : null;
    },
    findLatest: async () => null,
  });
  return lookups;
}

describe('MKT-2F: defaultTailorDeps reads the fit contract', () => {
  it('"Your fit" is getFit: the same snapshot the job page read gives, for the main resume, with no model call when none is allowed', async () => {
    const w = world([freshAiRow()]);
    const page = await w.service.fits.getFit('u1', 'job1');
    const yours = await w.deps.canonicalFit('u1', 'job1', { allowModelCall: false, locale: 'en' });
    expect(yours).toEqual(fitSnapshot(page));
    expect(yours).toMatchObject({ kind: 'ai', score: page.score, scoredAt: page.scoredAt, rubric: 'fit_v3', estimator: 'est_v2', model: EVAL_SCORER_MODEL });
    expect(page.basis.resumeVariantId).toBe('v1');
    expect(w.scorer.run).not.toHaveBeenCalled();
  });

  it('with nothing stored the live read is the estimate (never shown in tailoring); the create-time read may call the model once', async () => {
    const w = world();
    expect(await w.deps.canonicalFit('u1', 'job1', { allowModelCall: false })).toMatchObject({ kind: 'estimate', model: null });
    expect(w.scorer.run).not.toHaveBeenCalled();
    const scored = await w.deps.canonicalFit('u1', 'job1', { allowModelCall: true, locale: 'en' });
    expect(scored).toMatchObject({ kind: 'ai' });
    expect(w.scorer.run).toHaveBeenCalledTimes(1);
    // The row it wrote is the canonical one: the main resume.
    expect(w.repo.state.scores.map((r) => r.resumeVariantId)).toEqual(['v1']);
    // The job page now shows that same number.
    const page = await w.service.fits.getFit('u1', 'job1');
    expect({ score: page.score, kind: page.kind, scoredAt: page.scoredAt }).toEqual({ score: scored!.score, kind: 'ai', scoredAt: scored!.scoredAt });
  });

  it('"With this version" is getVariantFit: its own row for the named version, and the canonical fit stays where it was', async () => {
    const w = world([freshAiRow()]);
    const before = await w.service.fits.getFit('u1', 'job1');
    const variant = await w.deps.variantFit('u1', 'job1', 'v_tailored', 'en');
    expect(variant).toMatchObject({ kind: 'ai' });
    expect(w.scorer.run).toHaveBeenCalledTimes(1);
    expect(w.repo.state.scores.map((r) => r.resumeVariantId).sort()).toEqual(['v1', 'v_tailored']);
    const after = await w.service.fits.getFit('u1', 'job1');
    expect({ score: after.score, tier: after.tier, kind: after.kind, scoredAt: after.scoredAt }).toEqual({ score: before.score, tier: before.tier, kind: before.kind, scoredAt: before.scoredAt });
  });
});

// The keyword report (resume/store.ts `findFitRow`) used to read the score
// table directly: any scorer version, any resume text, AI consent or not.
describe('MKT-2F: the keyword report shows THE fit, or none', () => {
  it('the main resume: the AI fit getFit answers (same number, same time), with no model call', async () => {
    mainResumeIs('v1');
    const w = world([freshAiRow()]);
    const page = await w.service.fits.getFit('u1', 'job1');
    const row = await createPrismaResumeCheckStore().findFitRow('u1', 'job1', 'v1');
    expect(row).toEqual({ score: page.score, tier: page.tier, generatedAt: new Date(page.scoredAt), resumeContentHashAtScore: 'hash-1' });
    expect(w.scorer.run).not.toHaveBeenCalled();
  });

  it('nothing is shown when the fit is only a quick estimate, for another resume version, or when the read fails', async () => {
    mainResumeIs('v1');
    const empty = world();
    expect(await createPrismaResumeCheckStore().findFitRow('u1', 'job1', 'v1')).toBeNull();
    expect(empty.scorer.run).not.toHaveBeenCalled();
    // A stored row of another version is that version's own measure: only tailoring shows it ("With this version").
    const w = world([freshAiRow(), freshAiRow({ resumeVariantId: 'v_tailored', resumeContentHash: 'hash-tailored' })]);
    expect(await createPrismaResumeCheckStore().findFitRow('u1', 'job1', 'v_tailored')).toBeNull();
    expect(await createPrismaResumeCheckStore().findFitRow('u1', 'job1', 'v1')).not.toBeNull();
    expect(w.scorer.run).not.toHaveBeenCalled();
    // A job the person may not see, or a store that is down: no fit, never a throw.
    expect(await createPrismaResumeCheckStore().findFitRow('u1', 'no-such-job', 'v1')).toBeNull();
    expect(
      await fitRowFromContract('v1', async () => {
        throw new Error('down');
      }),
    ).toBeNull();
  });

  it('a version that is not the main resume makes zero fit reads: one id lookup answers it (the tailoring result page asks on every view)', async () => {
    const lookups = mainResumeIs('v1');
    const w = world([freshAiRow(), freshAiRow({ resumeVariantId: 'v_tailored', resumeContentHash: 'hash-tailored' })]);
    const fit = vi.fn((userId: string, jobId: string) => w.service.fits.getFit(userId, jobId));
    const store = createPrismaResumeCheckStore({ fit });
    const reads = { ...w.repo.calls };
    expect(await store.findFitRow('u1', 'job1', 'v_tailored')).toBeNull();
    expect(fit).not.toHaveBeenCalled();
    expect(lookups.calls).toBe(1);
    // Nothing of the match area was touched: no job, resume, inputs or stored-score read, and nothing written.
    expect(w.repo.calls).toEqual(reads);
    expect(w.repo.state.scores).toHaveLength(2);
    // The main resume still reads the fit, once.
    expect(await store.findFitRow('u1', 'job1', 'v1')).not.toBeNull();
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('no main resume, or a lookup that fails: no fit and no fit read, never a throw', async () => {
    const fit = vi.fn(async () => {
      throw new Error('must not be read');
    });
    expect(await fitRowForVersion('u1', 'job1', 'v1', { mainResumeId: async () => null, fit })).toBeNull();
    expect(
      await fitRowForVersion('u1', 'job1', 'v1', {
        mainResumeId: async () => {
          throw new Error('down');
        },
        fit,
      }),
    ).toBeNull();
    expect(fit).not.toHaveBeenCalled();
  });

  it('the fit itself stays the authority on which resume was read: a lookup that names another resume than the fit used shows nothing', async () => {
    mainResumeIs('v_tailored');
    world([freshAiRow()]);
    // The lookup says v_tailored is the main resume; the fit was read for v1. No number is shown for v_tailored.
    expect(await createPrismaResumeCheckStore().findFitRow('u1', 'job1', 'v_tailored')).toBeNull();
  });

  it('a row of a replaced resume text, or of the old scorer, is not shown (the table alone would have shown both)', async () => {
    mainResumeIs('v1');
    const replaced = world([freshAiRow({ resumeContentHash: 'hash-of-the-old-text' })]);
    expect(await createPrismaResumeCheckStore().findFitRow('u1', 'job1', 'v1')).toBeNull();
    expect(replaced.scorer.run).not.toHaveBeenCalled();
    const legacy = world([{ ...freshAiRow(), promptVersion: 'ra_match_v2', dimensions: null }]);
    expect(await createPrismaResumeCheckStore().findFitRow('u1', 'job1', 'v1')).toBeNull();
    expect(legacy.scorer.run).not.toHaveBeenCalled();
  });

  it('GoApply without the AI consent: a stored AI fit is not shown here either (I8)', async () => {
    mainResumeIs('v1');
    const repo = createMemoryRepo({ jobs: [jobRecord({ market: 'cn' })], scores: [freshAiRow()] as never });
    const scorer = { run: vi.fn() };
    setFitServiceForTests(
      createMatchService({ repo, scorer, resolveModel: () => EVAL_SCORER_MODEL, routeAllowed: () => true, aiAllowed: async () => false, consume: async () => ({ allowed: true, retryAfterSec: 0, remaining: 1, windows: [] }), brand: () => getBrand('goapply'), env: {}, now: () => NOW }),
    );
    expect(await createPrismaResumeCheckStore().findFitRow('u1', 'job1', 'v1')).toBeNull();
    expect(scorer.run).not.toHaveBeenCalled();
  });
});
