// components/features/onboarding-cn/types.ts — the step contract shared by the page (WP-30) and the steps.

import type { StepResponse } from '../../../lib/api/contracts/onboarding';

/** GoApply stages whose screen lives in this area (stage code = route segment). */
export const CN_ONBOARDING_STEPS = ['consent', 'identity', 'education', 'intent', 'tags', 'confirm'] as const;
export type CnOnboardingStep = (typeof CN_ONBOARDING_STEPS)[number];

/** What the matching stage found (WP-30's POST /onboarding/match `done` event), when the page has it. */
export interface CnMatchSummary {
  jobCount: number;
  topJobIds?: string[];
}

export interface CnOnboardingStepProps {
  step: CnOnboardingStep;
  /** The step saved; continue to `response.nextRoute`. */
  onDone: (response: StepResponse) => void;
  /** Absent on the first step. */
  onBack?: () => void;
  /** `tags` is skippable (PRODUCT G5); absent on steps without Skip. */
  onSkip?: () => void;
  /** Confirm only: the real count from the matching stage. Without it the page shows the index counts. */
  matchSummary?: CnMatchSummary | null;
}

export function isCnOnboardingStep(step: string): step is CnOnboardingStep {
  return (CN_ONBOARDING_STEPS as readonly string[]).includes(step);
}
