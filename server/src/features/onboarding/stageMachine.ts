// server/src/features/onboarding/stageMachine.ts — the onboarding stage machine (WP-30).
//
// Pure functions over the stored columns (SeekerProfile.onboardingStep /
// onboardingPath / onboardingAnswers). No I/O: the service reads the record,
// asks this module what the new record is, and writes it.
//
// Rules (PRODUCT_PLAN.md §4.1–§4.4, TASK_PLAN.md R-06):
//   - Stage codes and their order come from FND-5's contract (never redefined).
//   - A fresh account sits at `account`; it is treated as done, so the first
//     screen is the stage after it (situation / consent).
//   - Saving a step S stores its answers and moves the stored stage forward to
//     the stage after S, never backwards (Back + re-submit overwrites answers
//     and keeps the furthest stage). The client always goes to the stage after
//     S (`nextStage`), so a user who went back walks forward again.
//   - A step may be saved when it is shown for the brand and branch and is not
//     beyond the current stage (no jumping ahead).
//   - `situation` (RoboApply) and `identity` / `consent` (GoApply) have no Skip.
//   - Branch: timing "As soon as possible" → urgent, else explore. A branch
//     change that hides the stored stage moves it to the next shown stage.
//   - Leaving early (POST /skip after the account step): the stored stage
//     becomes `done` (so sign-in never forces the user back), the left-at stage
//     is kept in `answers.leftEarly`, and the finish banner counts what is left.
//     Saving a step later resumes from there.

import type { BrandId } from '../../platform/brand/registry.js';
import {
  ONBOARDING_BRANCHES,
  ONBOARDING_STAGE_ORDER,
  ONBOARDING_STAGES,
  UNSKIPPABLE_STAGES,
  isStageOfBrand,
  isStageShown,
  landingRoute,
  nextStage,
  routeForStage,
  type FirstValueContext,
  type OnboardingAnswers,
  type OnboardingBranch,
  type OnboardingEntry,
  type OnboardingLeftEarly,
  type OnboardingMe,
  type OnboardingProgress,
  type OnboardingStage,
} from './contract.js';

/** What the machine needs from the stored row. */
export interface StageRecord {
  step: string | null | undefined;
  path: string | null | undefined;
  answers: OnboardingAnswers | null | undefined;
  entry?: OnboardingEntry | null;
  completedAt?: Date | string | null;
}

/** Stages with a screen under /onboarding/<stage> (not account/tour/done). */
export function screenStages(brand: BrandId, branch: OnboardingBranch | null): OnboardingStage[] {
  return ONBOARDING_STAGES[brand].filter(
    (s) => s !== 'account' && s !== 'tour' && s !== 'done' && isStageShown(brand, s, branch),
  ) as OnboardingStage[];
}

export function parseBranch(path: string | null | undefined): OnboardingBranch | null {
  return (ONBOARDING_BRANCHES as readonly string[]).includes(path ?? '') ? (path as OnboardingBranch) : null;
}

/** Branch from the O1 timing answer. */
export function branchForTiming(timing: string): OnboardingBranch {
  return timing === 'asap' ? 'urgent' : 'explore';
}

/** The stored stage, validated (unknown → done, as /auth/me does). */
export function storedStage(brand: BrandId, raw: string | null | undefined): OnboardingStage {
  const s = raw ?? 'done';
  return isStageOfBrand(brand, s) ? s : 'done';
}

export function leftEarlyOf(answers: OnboardingAnswers | null | undefined): OnboardingLeftEarly | null {
  const v = (answers ?? {}).leftEarly as Partial<OnboardingLeftEarly> | undefined;
  if (!v || typeof v !== 'object' || typeof v.stage !== 'string' || typeof v.at !== 'string') return null;
  return { at: v.at, stage: v.stage as OnboardingStage };
}

/**
 * The stage the user is really at: `account` → the first screen; a branch
 * that hides the stored stage → the next shown one; left early → the left-at
 * stage (still `done` in storage).
 */
export function effectiveStage(brand: BrandId, rec: StageRecord): OnboardingStage {
  const branch = parseBranch(rec.path);
  let stage = storedStage(brand, rec.step);
  if (stage === 'done') {
    const left = leftEarlyOf(rec.answers);
    if (left && !rec.completedAt && isStageOfBrand(brand, left.stage)) stage = left.stage;
    else return 'done';
  }
  if (stage === 'account') return nextStage(brand, 'account', branch);
  if (!isStageShown(brand, stage, branch)) return nextStage(brand, stage, branch);
  return stage;
}

/** True when the user has left early and not finished (the finish banner shows). */
export function isPaused(brand: BrandId, rec: StageRecord): boolean {
  return storedStage(brand, rec.step) === 'done' && !rec.completedAt && leftEarlyOf(rec.answers) !== null;
}

/** Banner and progress numbers. */
export function progressOf(brand: BrandId, rec: StageRecord): OnboardingProgress {
  const branch = parseBranch(rec.path);
  const screens = screenStages(brand, branch);
  const at = effectiveStage(brand, rec);
  const idx = screens.indexOf(at);
  const stepsLeft = at === 'done' || at === 'tour' || idx < 0 ? 0 : screens.length - idx;
  return { total: screens.length, stepsLeft, leftEarly: isPaused(brand, rec) ? leftEarlyOf(rec.answers) : null };
}

export class StageError extends Error {
  constructor(
    readonly reason: 'onboarding_step_not_available' | 'onboarding_step_required' | 'onboarding_not_finished',
    message: string,
  ) {
    super(message);
    this.name = 'StageError';
  }
}

/** May the user save step `step` now? Throws StageError when not. */
export function assertStepSavable(brand: BrandId, rec: StageRecord, step: OnboardingStage, opts: { skip?: boolean; branchAfter?: OnboardingBranch | null } = {}): void {
  if (!isStageOfBrand(brand, step) || step === 'account' || step === 'tour' || step === 'done' || step === 'matching') {
    throw new StageError('onboarding_step_not_available', `"${step}" is not a step that takes answers.`);
  }
  const branch = opts.branchAfter !== undefined ? opts.branchAfter : parseBranch(rec.path);
  if (!isStageShown(brand, step, branch)) {
    throw new StageError('onboarding_step_not_available', `"${step}" is not part of this setup.`);
  }
  if (opts.skip && UNSKIPPABLE_STAGES.includes(step)) {
    throw new StageError('onboarding_step_required', `"${step}" cannot be skipped.`);
  }
  const at = effectiveStage(brand, rec);
  // Finished users may re-save answers (idempotent); otherwise no jumping ahead.
  if (at === 'done' || at === 'tour') return;
  if (ONBOARDING_STAGE_ORDER[step] > ONBOARDING_STAGE_ORDER[at]) {
    throw new StageError('onboarding_step_not_available', `Finish "${at}" first.`);
  }
}

export interface StepTransition {
  /** New stored stage. */
  step: OnboardingStage;
  /** Where the client goes next (the stage after the saved one). */
  nextStage: OnboardingStage;
  path: OnboardingBranch | null;
  /** True when the save resumed a left-early flow (clear `answers.leftEarly`). */
  resumed: boolean;
}

/** The stored stage after saving `saved` (forward only; tour/done stay). */
export function afterSave(brand: BrandId, rec: StageRecord, saved: OnboardingStage, branchAfter: OnboardingBranch | null): StepTransition {
  const next = nextStage(brand, saved, branchAfter);
  const paused = isPaused(brand, rec);
  const stored = storedStage(brand, rec.step);
  let current: OnboardingStage;
  if (paused) current = leftEarlyOf(rec.answers)!.stage;
  else if (stored === 'account') current = nextStage(brand, 'account', branchAfter);
  else current = stored;
  if (current === 'tour' || (current === 'done' && !paused)) {
    return { step: current, nextStage: next, path: branchAfter, resumed: false };
  }
  // A branch change may hide the current stage (goal/preferences on urgent).
  if (!isStageShown(brand, current, branchAfter)) current = nextStage(brand, current, branchAfter);
  const step = ONBOARDING_STAGE_ORDER[next] > ONBOARDING_STAGE_ORDER[current] ? next : current;
  return { step, nextStage: next, path: branchAfter, resumed: paused };
}

/** Route of a stage for the client (tour/done → the landing). */
export function routeFor(brand: BrandId, stage: OnboardingStage, entry: OnboardingEntry | null | undefined, ctx: FirstValueContext = {}): string | null {
  if (stage === 'done' || stage === 'tour') return landingRoute(brand, entry, ctx);
  return routeForStage(brand, stage, ctx);
}

/** `/auth/me.onboarding` with the `account` rule (same result as WP-10's onboardingFor). */
export function meOf(brand: BrandId, rec: StageRecord, ctx: FirstValueContext = {}): OnboardingMe {
  const step = storedStage(brand, rec.step);
  const path = brand === 'roboapply' ? parseBranch(rec.path) : null;
  const completed = step === 'done';
  if (completed) return { step, path, completed, nextRoute: null };
  const at = step === 'account' ? nextStage(brand, 'account', path) : step;
  return { step, path, completed, nextRoute: routeForStage(brand, at, ctx) };
}
