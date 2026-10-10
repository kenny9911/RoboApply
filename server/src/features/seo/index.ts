// server/src/features/seo/index.ts — public surface of SEO (owner WP-56).
//
// Other areas import from here only:
//   - `createSeoPublicRouter` (features/index.ts mounts it at /api/v1/public/seo);
//   - `toPublicCard` / `jobPath` / `jobIdSlug`: the public job card and URL of a job row;
//   - `publicJobWhere` / `basePublicWhere` / `allowedPublicBoards`: the predicate
//     for jobs a public surface may show (TASK_PLAN §2.2, ARCH §9.4);
//   - `createMemorySeoRepo` / `seoJob` (testkit): mount the router without a
//     database in another area's route tests (`{ service: createSeoService({ repo }) }`).

export * from './contract.js';
export { createSeoPublicRouter, isInternalRequest, seoRateLimiter, SEO_RATE_LIMIT_NAME } from './routes.js';
export type { SeoRouterDeps } from './routes.js';
export { createSeoService, defaultSeoService, toPublicCard, toPublicDetail, SeoGoneError } from './service.js';
export type { SeoService, SeoServiceDeps } from './service.js';
export { jobIdSlug, jobPath, parseIdSlug, resolveBrowsePath, classifyBrowsePath, seoCacheTag } from './paths.js';
export { allowedPublicBoards, basePublicWhere, publicDisplayProviders, publicJobWhere } from './scope.js';
export type { JobScope, ScopeContext } from './scope.js';
export { createMemorySeoRepo, seoJob, seoJobs } from './testkit.js';
export { createPrismaSeoRepo } from './repo.js';
export type { SeoRepo, SeoJobRow, SeoJobDetailRow } from './repo.js';
export { createSeoRebuild, runSeoRebuild } from './cron.js';
export { SEO_WORK_KINDS } from './workers.js';
