// server/src/features/onboarding/index.ts — public surface of the onboarding area (FND-5; owner WP-30).
//
// Other areas import onboarding only from here. The service is a typed
// interface with a stub implementation that throws NotImplementedError until
// WP-30 fills it; callers must handle that.

import { NotImplementedError } from '../../platform/http.js';
import type { BrandId } from '../../platform/brand/registry.js';
import type {
  OnboardingConfirmBodySchema,
  OnboardingMe,
  OnboardingStageResponse,
  OnboardingStateResponse,
  StepResponse,
} from './contract.js';
import type { z } from 'zod';

export * from './contract.js';
export { createOnboardingRouter } from './routes.js';
export { ONBOARDING_WORK_KINDS } from './workers.js';

export interface OnboardingService {
  /** `/auth/me.onboarding` for a user (WP-10 calls this). */
  meFor(userId: string, brand: BrandId): Promise<OnboardingMe>;
  getState(userId: string): Promise<OnboardingStateResponse>;
  saveStep(userId: string, step: string, body: Record<string, unknown>): Promise<StepResponse>;
  confirm(userId: string, body: z.infer<typeof OnboardingConfirmBodySchema>): Promise<OnboardingStageResponse>;
  complete(userId: string): Promise<OnboardingStageResponse>;
  skip(userId: string): Promise<OnboardingStageResponse>;
}

const notYet = (what: string) => async (): Promise<never> => {
  throw new NotImplementedError(`onboarding.${what}`);
};

/** Stub until WP-30. */
export const onboardingService: OnboardingService = {
  meFor: notYet('meFor'),
  getState: notYet('getState'),
  saveStep: notYet('saveStep'),
  confirm: notYet('confirm'),
  complete: notYet('complete'),
  skip: notYet('skip'),
};
