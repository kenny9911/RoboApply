// server/src/features/credits/index.ts — public surface of the credits HTTP area (FND-5; owner WP-21a).
// The credit engine itself is platform/credits (FND-4); areas spend credits
// through `withCredit` there, not through this module.

export * from './contract.js';
export { createBillingPlansRouter, createCreditsRouter, createPublicCancelRouter } from './routes.js';
export { createCreditsAdminRouter } from './adminRoutes.js';
