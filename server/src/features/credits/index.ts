// server/src/features/credits/index.ts — public surface of the credits HTTP area (WP-21a).
// The credit engine itself is platform/credits (FND-4); areas spend credits
// through `withCredit` there, not through this module. Billing (rails,
// fulfilPass, plans) is platform/billing.

export * from './contract.js';
export { billingRoute, createBillingPlansRouter, createCreditsRouter, createPublicCancelRouter } from './routes.js';
export { createCreditsAdminRouter } from './adminRoutes.js';
export {
  ALTERNATIVE_UI_KEY,
  CANCEL_SURVEY_LIMIT,
  CancelSurveyStoreUnavailableError,
  CreditsAreaService,
  PUBLIC_CANCEL_LIMITS,
  createPrismaCancelSurveyStore,
  creditsAreaService,
  hashToken,
  overrideProblem,
} from './service.js';
export type { CancelSurveyAnswer, CancelSurveyStore, CreditsAreaDeps, CreditsDb, OverrideAuditEntry } from './service.js';
