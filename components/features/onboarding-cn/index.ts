// components/features/onboarding-cn — GoApply onboarding step screens
// G1–G5 and the cn confirm page (PRODUCT_PLAN.md §4.4–§4.5; TASK_PLAN.md
// WP-31). Public surface; other areas import from here only (§2.1 rule 4).
//
// STUB SEAM (FND-6b). Owner: WP-31. Every step component renders nothing.
// WP-30's `/onboarding/[step]` page (app/(onboarding)/onboarding/[step]) owns
// routing and the shared stages (resume, matching); on GoApply it renders
// `CN_ONBOARDING_STEP_COMPONENTS[step]` for the steps below. A step saves its
// own answers (PUT /onboarding/steps/:step through lib/api/onboarding.ts,
// validated server-side by features/onboarding-cn) and then calls `onDone`
// with the server's response; the page navigates to `nextRoute`.

import type { ComponentType } from 'react';

import type { StepResponse } from '../../../lib/api/contracts/onboarding';

/** GoApply stages whose screen lives in this area (stage code = route segment). */
export const CN_ONBOARDING_STEPS = ['consent', 'identity', 'education', 'intent', 'tags', 'confirm'] as const;
export type CnOnboardingStep = (typeof CN_ONBOARDING_STEPS)[number];

export interface CnOnboardingStepProps {
  step: CnOnboardingStep;
  /** The step saved; continue to `response.nextRoute`. */
  onDone: (response: StepResponse) => void;
  /** Absent on the first step. */
  onBack?: () => void;
  /** `tags` is skippable (PRODUCT G5); absent on steps without Skip. */
  onSkip?: () => void;
}

export function isCnOnboardingStep(step: string): step is CnOnboardingStep {
  return (CN_ONBOARDING_STEPS as readonly string[]).includes(step);
}

function stubStep(_props: CnOnboardingStepProps): null {
  return null;
}

export const ConsentStep: ComponentType<CnOnboardingStepProps> = stubStep;
export const IdentityStep: ComponentType<CnOnboardingStepProps> = stubStep;
export const EducationStep: ComponentType<CnOnboardingStepProps> = stubStep;
export const IntentStep: ComponentType<CnOnboardingStepProps> = stubStep;
export const TagsStep: ComponentType<CnOnboardingStepProps> = stubStep;
export const CnConfirmStep: ComponentType<CnOnboardingStepProps> = stubStep;

export const CN_ONBOARDING_STEP_COMPONENTS: Readonly<Record<CnOnboardingStep, ComponentType<CnOnboardingStepProps>>> = {
  consent: ConsentStep,
  identity: IdentityStep,
  education: EducationStep,
  intent: IntentStep,
  tags: TagsStep,
  confirm: CnConfirmStep,
};
