// server/src/features/match/eval/testdata/fitShim.ts
//
// A STAND-IN for the fit contract, for the harness's own tests only. It puts
// the list read that exists before the contract (`preScoreMany`: the stored AI
// score, else the quick estimate) behind the target signatures, so the seam
// binding, the suites and the runner can be exercised before
// features/match/fit.ts exists. It is NOT the fit contract and proves nothing
// about it: it has no coverage, no confidence and no priors, and the
// invariants are expected to fail against it.
//
// Reached only through `setFitModuleForTests` (seams.ts). run.ts never loads it.

import { createMatchService, type MatchService, type MatchServiceDeps } from '../../MatchService.js';

interface ShimFit {
  jobId: string;
  score: number | null;
  tier: string | null;
  kind: 'ai' | 'estimate';
  dimensions: unknown[];
  requirements: unknown[];
  topOverlap: string | null;
  topGap: string | null;
}

function fromService(service: MatchService) {
  const getFits = async (userId: string, jobIds: string[]): Promise<Map<string, ShimFit>> => {
    const rows = await service.preScoreMany(userId, jobIds);
    return new Map(
      rows.map((r) => [
        r.jobId,
        { jobId: r.jobId, score: r.score, tier: r.tier, kind: r.kind === 'ai' ? ('ai' as const) : ('estimate' as const), dimensions: r.dimensions, requirements: [], topOverlap: r.topOverlap, topGap: r.topGap },
      ]),
    );
  };
  const getFit = async (userId: string, jobId: string): Promise<ShimFit> => {
    const fit = (await getFits(userId, [jobId])).get(jobId);
    if (!fit) throw new Error(`no fit for ${jobId}`);
    return fit;
  };
  return { getFit, getFits };
}

/** Shape 1 of the binding: a factory exported by the fit module. */
export function createFitService(deps: MatchServiceDeps) {
  return fromService(createMatchService(deps));
}

// The module-level functions of the contract. Bound to nothing here: the harness must not use them.
export async function getFits(): Promise<never> {
  throw new Error('fitShim: the module-level getFits is not bound to a repository');
}
export async function getFit(): Promise<never> {
  throw new Error('fitShim: the module-level getFit is not bound to a repository');
}
