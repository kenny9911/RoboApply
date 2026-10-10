// server/src/features/jobs/sources/atsPublic/index.ts — public surface (FND-5; owner WP-42).
// WP-42's adapters plug into WP-16b's provider interface as `ats_public`.

export * from './contract.js';
export { createCareerSourcesAdminRouter } from './routes.js';
export { atsPublicHooks, isTaiwanJob, twCardMeta } from './hooks.js';
export { atsPublicAdapter, ensureAtsPublicAdapter } from './register.js';
export { atsPublicEnabled, createAtsPublicAdapter, ATS_PUBLIC_KILL_SWITCH } from './adapter.js';
export { CONNECTORS, connectorFor } from './connectors.js';
export { extractPermitTags } from './permitTags.js';
export { careerSourcesService } from './service.js';
export { ensureSeedCareerSources, parseSeedFile, seedFileFor } from './seeds.js';
export type { SeedBoard, SeedFile, SeedResult } from './seeds.js';
