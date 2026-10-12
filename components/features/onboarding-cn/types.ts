// components/features/onboarding-cn/types.ts — the step contract shared by the page (WP-30) and the steps.

import type { StepResponse } from '../../../lib/api/contracts/onboarding';

/**
 * GoApply stages whose screen lives in this area (stage code = route segment).
 * `resume` and `matching` are WP-30's shared screens and are not listed: the
 * onboarding page renders the shared resume screen inside this area's
 * `CnResumeGate` (AI consent → upload; otherwise fill in by hand).
 */
export const CN_ONBOARDING_STEPS = ['consent', 'identity', 'education', 'intent', 'tags', 'confirm'] as const;
export type CnOnboardingStep = (typeof CN_ONBOARDING_STEPS)[number];

/**
 * Every GoApply onboarding screen in order, the shared ones included (the
 * same list as ONBOARDING_SCREEN_STAGES.goapply in the onboarding area; the
 * test keeps them equal). The progress line of every screen counts over it,
 * so "Step 3 of 8" on G3 and the shared "Step 6 of 8" on G6 are one sequence.
 */
export const CN_ONBOARDING_SCREENS = ['consent', 'identity', 'education', 'intent', 'tags', 'resume', 'matching', 'confirm'] as const;
export type CnOnboardingScreen = (typeof CN_ONBOARDING_SCREENS)[number];

/** 1-based position of a screen and the number of screens; null for a stage that has no screen. */
export function cnStepPosition(step: string): { current: number; total: number } | null {
  const i = (CN_ONBOARDING_SCREENS as readonly string[]).indexOf(step);
  return i < 0 ? null : { current: i + 1, total: CN_ONBOARDING_SCREENS.length };
}

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
