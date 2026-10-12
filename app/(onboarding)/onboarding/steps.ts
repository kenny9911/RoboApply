// The onboarding stages that have a screen under /onboarding/<stage>, per
// brand (PRODUCT_PLAN.md §4.2–§4.5; TASK_PLAN.md R-06).
//
// The canonical stage → route map is ONBOARDING_STAGE_ROUTES in
// server/src/features/onboarding/contract.ts (FND-5). The web copy lives in
// components/features/onboarding/flow.ts (WP-30); a test keeps the two equal.

export { ONBOARDING_SCREEN_STAGES, isOnboardingScreen } from '../../../components/features/onboarding/flow';
