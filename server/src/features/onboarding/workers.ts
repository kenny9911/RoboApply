// server/src/features/onboarding/workers.ts — queue workers of the onboarding area (WP-30).
//
// server/src/platform/queue/registry.ts imports `workers` from every area; the
// drain runs each item inside `runWithBrand(item.brand)`.
//
//   'onboarding.match'  payload { userId, fromPhase }
//       O6 work that passed the 120 s cap (or whose client went away)
//       continues here: the remaining phases run without a cap and the result
//       is stored in `onboardingAnswers.matching` (the stage is not moved:
//       the request already moved it, or the user will run O6 again).

import { PermanentWorkError, type LeasedWorkItem, type WorkerDefinition } from '../../platform/queue/index.js';
import { getBrand, type BrandId } from '../../platform/brand/registry.js';
import { ONBOARDING_MATCH_PHASES, type OnboardingMatchPhase } from './contract.js';
import type { MatchPipelineDeps } from './match.js';

export const ONBOARDING_WORK_KINDS = { onboardingMatch: 'onboarding.match' } as const;

export function parseOnboardingMatchPayload(item: Pick<LeasedWorkItem<unknown>, 'payload' | 'userId'>): { userId: string; fromPhase: OnboardingMatchPhase } {
  const p = (item.payload ?? {}) as { userId?: unknown; fromPhase?: unknown };
  const userId = typeof p.userId === 'string' && p.userId ? p.userId : item.userId;
  if (!userId) throw new PermanentWorkError('onboarding.match: userId is required');
  const fromPhase = (ONBOARDING_MATCH_PHASES as readonly string[]).includes(String(p.fromPhase)) ? (p.fromPhase as OnboardingMatchPhase) : 'saving';
  return { userId, fromPhase };
}

/** Handler factory (tests pass their own pipeline deps). */
export function createOnboardingMatchHandler(depsFor?: (brand: BrandId) => Promise<MatchPipelineDeps> | MatchPipelineDeps) {
  return async (item: LeasedWorkItem<unknown>): Promise<void> => {
    const { userId, fromPhase } = parseOnboardingMatchPayload(item);
    const brandId = item.brand as BrandId;
    const deps = depsFor
      ? await depsFor(brandId)
      : (await import('./defaults.js')).createDefaultMatchDeps(getBrand(brandId));
    const { runOnboardingMatch } = await import('./match.js');
    await runOnboardingMatch(deps, userId, { fromPhase, background: true });
  };
}

export const workers: WorkerDefinition<unknown>[] = [
  { kind: ONBOARDING_WORK_KINDS.onboardingMatch, handler: createOnboardingMatchHandler(), concurrency: 2 },
];
