// The onboarding stages that have a screen under /onboarding/<stage>, per
// brand (PRODUCT_PLAN.md §4.2–§4.5; TASK_PLAN.md R-06).
//
// The canonical stage → route map is ONBOARDING_STAGE_ROUTES in
// server/src/features/onboarding/contract.ts (FND-5). This is its web copy
// (the web bundle never imports server runtime code); a test keeps the two
// equal. Owner: WP-30.

import type { BrandId } from '../../../lib/brand/registry.generated';

export const ONBOARDING_SCREEN_STAGES: Readonly<Record<BrandId, readonly string[]>> = {
  roboapply: ['situation', 'basics', 'goal', 'preferences', 'resume', 'matching', 'confirm'],
  goapply: ['consent', 'identity', 'education', 'intent', 'tags', 'resume', 'matching', 'confirm'],
};

/** True when `/onboarding/<step>` is a screen of this brand. */
export function isOnboardingScreen(brandId: BrandId, step: string): boolean {
  return ONBOARDING_SCREEN_STAGES[brandId].includes(step);
}
