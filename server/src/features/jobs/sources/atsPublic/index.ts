// server/src/features/jobs/sources/atsPublic/index.ts — public surface (FND-5; owner WP-42).
// WP-42's adapters plug into WP-16b's provider interface as `ats_public`.

export * from './contract.js';
export { createCareerSourcesAdminRouter } from './routes.js';
export { atsPublicHooks } from './hooks.js';
