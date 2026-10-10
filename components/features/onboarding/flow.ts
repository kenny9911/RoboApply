// components/features/onboarding/flow.ts — the screen order on the web (WP-30).
//
// Web copy of the server stage machine's order (ONBOARDING_STAGE_ORDER and
// BRANCH_ONLY_STAGES in server/src/features/onboarding/contract.ts); flow.test.ts
// keeps them equal. The server stays the authority: it refuses a step the
// user may not save yet.

import type { BrandId } from '../../../lib/brand/registry.generated';

/** Stages with a screen under /onboarding/<stage>, per brand (both branches). */
export const ONBOARDING_SCREEN_STAGES: Readonly<Record<BrandId, readonly string[]>> = {
  roboapply: ['situation', 'basics', 'goal', 'preferences', 'resume', 'matching', 'confirm'],
  goapply: ['consent', 'identity', 'education', 'intent', 'tags', 'resume', 'matching', 'confirm'],
};

/** True when `/onboarding/<step>` is a screen of this brand. */
export function isOnboardingScreen(brandId: BrandId, step: string): boolean {
  return ONBOARDING_SCREEN_STAGES[brandId].includes(step);
}

export const STAGE_ORDER: Readonly<Record<string, number>> = {
  account: 10,
  consent: 15,
  situation: 20,
  identity: 20,
  education: 25,
  basics: 30,
  intent: 30,
  tags: 35,
  goal: 40,
  preferences: 50,
  resume: 60,
  matching: 70,
  confirm: 80,
  tour: 90,
  done: 100,
};

const EXPLORE_ONLY = new Set(['goal', 'preferences']);

export function stageOrder(stage: string): number {
  return STAGE_ORDER[stage] ?? 0;
}

/** Screens shown for a brand and branch, in order. */
export function screensFor(brand: BrandId, branch: string | null): string[] {
  return ONBOARDING_SCREEN_STAGES[brand].filter((s) => brand !== 'roboapply' || !EXPLORE_ONLY.has(s) || branch === 'explore');
}
