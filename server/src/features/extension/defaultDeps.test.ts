// @vitest-environment node
//
// WP-55a: the production wiring's computed import path still points at the
// resume service (it is loaded by path so the web typecheck stays clean).
//
// MKT-2F: the fit chip reads THE fit (match/fit.ts). Checked on the production
// wiring (`defaultExtensionDeps().match`) over an in-memory MatchService with
// a counting fake scorer:
//   - a known job: the same score, tier and kind `getFit` answers (I1), the
//     stored AI fit when there is one (I2), never a model call;
//   - a page that is not one of our jobs: the v2 estimate, never stored,
//     never a model call, whatever the caller's stored scores.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { runWithBrand } from '../../lib/requestContext.js';
import { getBrand, type BrandId } from '../../platform/brand/registry.js';
import { ADHOC_POSTING_ID, setFitServiceForTests } from '../match/fit.js';
import { fitFixture } from '../agent/__tests__/fitFixture.js';
import { createMatchService } from '../match/MatchService.js';
import { createMemoryRepo, jobRecord } from '../match/testkit.js';
import { freshAiRow } from '../match/eval/world.js';
import { RESUME_SERVICE_MODULE, chip, defaultExtensionDeps, pagePosting } from './defaultDeps.js';

describe('defaultExtensionDeps', () => {
  it('resolves the resume service module', () => {
    const ts = fileURLToPath(new URL(RESUME_SERVICE_MODULE.replace(/\.js$/, '.ts'), import.meta.url));
    expect(existsSync(ts)).toBe(true);
  });
});

const NOW = new Date('2026-10-10T08:00:00Z');

function world(opts: { brand?: BrandId; scores?: Array<Record<string, unknown>>; aiAllowed?: boolean; jobs?: ReturnType<typeof jobRecord>[] } = {}) {
  const brandId = opts.brand ?? 'roboapply';
  const repo = createMemoryRepo({ ...(opts.jobs ? { jobs: opts.jobs } : {}), scores: (opts.scores ?? []) as never });
  const scorer = { run: vi.fn(async () => Promise.reject(new Error('the chip must never call the scorer'))) };
  const service = createMatchService({
    repo,
    scorer,
    resolveModel: () => 'eval/fake-scorer',
    routeAllowed: () => true,
    aiAllowed: async () => opts.aiAllowed ?? true,
    consume: async () => ({ allowed: true, retryAfterSec: 0, remaining: 100, windows: [] }),
    costLog: async () => undefined,
    profileSnapshot: async () => null,
    brand: () => getBrand(brandId),
    env: {},
    now: () => NOW,
  });
  setFitServiceForTests(service);
  const match = defaultExtensionDeps().match;
  const inBrand = <T>(fn: () => T): T => runWithBrand(brandId, fn);
  return { repo, scorer, service, match, inBrand };
}

afterEach(() => setFitServiceForTests(null));

const PAGE = { url: 'https://careers.example.test/jobs/9', title: 'Senior Backend Engineer', company: 'Example Co', location: 'Berlin', descriptionText: 'We build payment APIs in Go and TypeScript. 5+ years of backend experience.' };

describe('MKT-2F: the extension chip reads the one fit', () => {
  it('a known job: the chip is getFit (score, tier, kind), an estimate when nothing is stored', async () => {
    const w = world();
    const fit = await w.service.fits.getFit('u1', 'job1');
    const got = await w.inBrand(() => w.match.cached('u1', 'job1'));
    expect(got).toMatchObject({ score: fit.score, tier: fit.tier, kind: 'pre', confidence: fit.confidence, confidenceReason: fit.confidenceReason });
    expect(fit.kind).toBe('estimate');
    expect(w.scorer.run).not.toHaveBeenCalled();
    expect(w.repo.state.scores).toHaveLength(0);
  });

  it('a known job with a fresh stored AI fit: the chip shows that fit, not an estimate, and still calls no model', async () => {
    const w = world({ scores: [freshAiRow()] });
    const fit = await w.service.fits.getFit('u1', 'job1');
    expect(fit.kind).toBe('ai');
    const got = await w.inBrand(() => w.match.cached('u1', 'job1'));
    expect(got).toMatchObject({ score: fit.score, tier: fit.tier, kind: 'ai' });
    expect(w.scorer.run).not.toHaveBeenCalled();
  });

  it('a page that is not one of our jobs: the estimate, never stored and never sent to a model', async () => {
    const w = world({ scores: [freshAiRow()] });
    const before = JSON.stringify(w.repo.state.scores);
    const got = await w.inBrand(() => w.match.page('u1', PAGE));
    expect(got).not.toBeNull();
    expect(got!.kind).toBe('pre');
    expect(typeof got!.score).toBe('number');
    expect(['high', 'medium', 'low']).toContain(got!.confidence);
    expect(w.scorer.run).not.toHaveBeenCalled();
    // Nothing written: no score row, no job row.
    expect(JSON.stringify(w.repo.state.scores)).toBe(before);
    expect(w.repo.calls.saveScore ?? 0).toBe(0);
    expect(w.repo.state.jobs.map((j) => j.id)).toEqual(['job1']);
    // The page was never read from the job table: it was handed over as a row.
    expect(w.repo.calls.getJob ?? 0).toBe(0);
    expect(w.repo.calls.getFitJobs ?? 0).toBe(0);
  });

  it('a page is the same estimate a stored job with the same text would get before any AI read (one estimator)', async () => {
    const posting = pagePosting('intl', PAGE);
    const stored = jobRecord({ ...posting, id: 'same-text', visibility: 'public', ownerUserId: null });
    const w = world({ jobs: [stored] });
    const page = await w.inBrand(() => w.match.page('u1', PAGE));
    const job = await w.inBrand(() => w.match.cached('u1', 'same-text'));
    expect(page).toEqual(job);
  });

  it('a stored score can never be shown for a page, even one saved under the ad-hoc id', async () => {
    // A row that could only exist by mistake: the page still answers the estimate.
    const w = world({ scores: [freshAiRow({ jobId: ADHOC_POSTING_ID })] });
    const got = await w.inBrand(() => w.match.page('u1', PAGE));
    expect(got === null || got.kind === 'pre').toBe(true);
    expect(w.scorer.run).not.toHaveBeenCalled();
  });

  it('GoApply: the page of a mainland posting is estimated in its own market; without the AI consent nothing changes (no model either way)', async () => {
    const w = world({ brand: 'goapply', aiAllowed: false, jobs: [jobRecord({ market: 'cn' })] });
    const got = await w.inBrand(() => w.match.page('u1', { ...PAGE, title: '后端开发工程师', descriptionText: '负责支付系统后端开发，熟悉 Go 和 TypeScript。' }));
    expect(got?.kind).toBe('pre');
    expect(pagePosting('cn', PAGE).market).toBe('cn');
    expect(w.scorer.run).not.toHaveBeenCalled();
    // A known job on the same account: the estimate, never the scorer.
    expect((await w.inBrand(() => w.match.cached('u1', 'job1')))?.kind).toBe('pre');
    expect(w.scorer.run).not.toHaveBeenCalled();
  });

  it('chip: the wire shape the published extension reads, plus confidence and its reason', () => {
    expect(chip(null)).toBeNull();
    expect(chip(fitFixture({ score: 58, tier: 'possible', kind: 'estimate', confidence: 'low', confidenceReason: 'no_skills_listed', topGap: 'Go' }))).toEqual({
      score: 58,
      tier: 'possible',
      kind: 'pre',
      topOverlap: null,
      topGap: 'Go',
      confidence: 'low',
      confidenceReason: 'no_skills_listed',
    });
    expect(chip(fitFixture({ score: 81, tier: 'great', kind: 'ai' }))).toMatchObject({ kind: 'ai', confidence: 'high', confidenceReason: null });
  });
});
