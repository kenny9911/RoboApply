// components/features/onboarding — RoboApply onboarding screens O1–O7, the O8
// first-visit tour and prompts (WP-30), and the two-screen start flow at
// /onboarding/start (./express). Public surface; other areas import from here
// only (TASK_PLAN.md §2.1 rule 4).

export { OnboardingStepPage } from './OnboardingStepPage';
export { ExpressOnboarding } from './express/ExpressOnboarding';
export { TourOverlay, FirstVisitTour, type TourOverlayProps } from './TourOverlay';
export { OnboardingPromptDock, FinishSetupBanner, FinishSetupSettingsLine } from './FirstVisitPrompts';
export { StepFrame, type StepFrameProps } from './StepFrame';
export { ONBOARDING_SCREEN_STAGES, isOnboardingScreen, screensFor, stageOrder } from './flow';
export { CLASSIC_FLOW_ROUTE, EXPRESS_LANDING_ROUTE, EXPRESS_START_ROUTE, startsInExpress } from './flow';
export type { StepScreenProps } from './types';
