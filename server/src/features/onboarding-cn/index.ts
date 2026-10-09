// server/src/features/onboarding-cn/index.ts — public surface (FND-5; owner WP-31).
//
// WP-30's onboarding service calls `validateCnStep(step, body)` for GoApply
// steps. Until WP-31 fills it, it throws NotImplementedError (callers map it
// to 501). No routes: GoApply steps go through PUT /onboarding/steps/:step.

import { NotImplementedError } from '../../platform/http.js';
import type { CnStepValidation } from './contract.js';

export * from './contract.js';

export interface OnboardingCnService {
  validateCnStep(step: string, body: unknown): Promise<CnStepValidation>;
  /** Default 届别 for a date (Oct 2026 → 2027届 for 应届). */
  defaultGraduationClass(identity: 'yingjie' | 'zaixiao', now?: Date): number;
}

export const onboardingCnService: OnboardingCnService = {
  async validateCnStep() {
    throw new NotImplementedError('onboardingCn.validateCnStep');
  },
  defaultGraduationClass() {
    throw new NotImplementedError('onboardingCn.defaultGraduationClass');
  },
};

export const validateCnStep = (step: string, body: unknown) => onboardingCnService.validateCnStep(step, body);
