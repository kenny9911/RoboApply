// server/src/features/agent/__tests__/fitFixture.ts — a `Fit` for tests of the
// surfaces that read the fit contract (alerts, Similar jobs, the Ready list,
// the extension, onboarding, lifecycle). Test support only: no production
// module imports it, and `__tests__` directories are left out of the server
// build (server/tsconfig.json). A type-only import, so it loads nothing.
//
// It lives here because this directory is owned by the bundle that wrote it
// (MKT-2F); its natural home is beside match/testkit.ts (handoff MKT-2F,
// Request to the orchestrator).

import type { Fit } from '../../match/index.js';

export const FIT_FIXTURE_AT = '2026-10-10T08:00:00.000Z';

/** A complete `Fit` (a quick estimate by default) with the given parts replaced. */
export function fitFixture(over: Partial<Fit> = {}): Fit {
  const kind = over.kind ?? 'estimate';
  return {
    jobId: 'job1',
    score: 72,
    tier: 'good',
    kind,
    coverage: 0.8,
    confidence: 'high',
    confidenceReason: null,
    dimensions: [],
    requirements: [],
    topOverlap: null,
    topGap: null,
    basis: { resumeVariantId: 'v1', resumeContentHash: 'hash-1', jobContentHash: null, searchProfileVersion: 1 },
    version: { rubric: 'fit_v3', estimator: 'est_v2', model: kind === 'ai' ? 'test/model' : null, prompt: kind === 'ai' ? 'scorer_v3' : null },
    scoredAt: FIT_FIXTURE_AT,
    stale: false,
    calibrated: false,
    estimateScore: over.score === undefined ? 72 : over.score,
    estimateReason: null,
    skills: { aligned: [], missing: [], softSkills: [], listed: 0 },
    prose: null,
    cached: kind === 'ai',
    ...over,
  };
}

/** `getFits` over fixtures: a map by job id, as the contract answers it. */
export function fitsFixture(fits: readonly Fit[]): Map<string, Fit> {
  return new Map(fits.map((f) => [f.jobId, f]));
}
