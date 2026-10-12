// server/src/features/onboarding/index.ts — public surface of the onboarding area (FND-5; filled by WP-30).
//
// Other areas import onboarding only from here. `onboardingService` keeps
// FND-5's interface (WP-10 may call `meFor`); the request-scoped methods take
// the brand from the current request context.

import type { z } from 'zod';
import { getCurrentBrandOrDefault } from '../../platform/brand/index.js';
import type { BrandId } from '../../platform/brand/registry.js';
import type {
  OnboardingConfirmBodySchema,
  OnboardingMe,
  OnboardingStageResponse,
  OnboardingStateResponse,
  StepResponse,
} from './contract.js';
import type { OnboardingServiceImpl } from './service.js';

export * from './contract.js';
export { createOnboardingRouter } from './routes.js';
export type { OnboardingRouterDeps } from './routes.js';
export { ONBOARDING_WORK_KINDS } from './workers.js';
export { createOnboardingService, defaultCountry } from './service.js';
export type { OnboardingContext, OnboardingDeps, OnboardingServiceImpl, SearchProfileRef } from './service.js';
export { runOnboardingMatch, candidateQueryFor, rankPreScores, ONBOARDING_MATCH_KIND } from './match.js';
export type { MatchPipelineDeps, MatchRunOptions } from './match.js';
export { createPrismaOnboardingRepo } from './repo.js';
export type { OnboardingRepo, OnboardingRecord } from './repo.js';
export { computeSnapshot, snapshotWhere } from './snapshot.js';
export { meOf, effectiveStage, progressOf } from './stageMachine.js';

export interface OnboardingService {
  /** `/auth/me.onboarding` for a user (WP-10 calls this). */
  meFor(userId: string, brand: BrandId): Promise<OnboardingMe>;
  getState(userId: string): Promise<OnboardingStateResponse>;
  saveStep(userId: string, step: string, body: Record<string, unknown>): Promise<StepResponse>;
  confirm(userId: string, body: z.infer<typeof OnboardingConfirmBodySchema> | Record<string, unknown>): Promise<OnboardingStageResponse>;
  complete(userId: string): Promise<OnboardingStageResponse>;
  skip(userId: string): Promise<OnboardingStageResponse>;
}

async function impl(): Promise<OnboardingServiceImpl> {
  return (await import('./defaults.js')).defaultOnboardingService();
}
const ctx = () => ({ brand: getCurrentBrandOrDefault() });

/** Bare-user-id surface for other areas (brand = the current request/queue brand). */
export const onboardingService: OnboardingService = {
  meFor: async (userId, brand) => (await impl()).meFor(userId, brand),
  getState: async (userId) => (await impl()).getState(userId, ctx()),
  saveStep: async (userId, step, body) => (await impl()).saveStep(userId, step, body, ctx()),
  confirm: async (userId, body) => (await impl()).confirm(userId, body, ctx()),
  complete: async (userId) => (await impl()).complete(userId, ctx()),
  skip: async (userId) => (await impl()).skip(userId, ctx()),
};
