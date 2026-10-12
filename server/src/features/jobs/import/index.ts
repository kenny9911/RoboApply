// server/src/features/jobs/import/index.ts — public surface of "Added by you" (WP-35).
//
// Callers in other areas:
//   - the Assistant's add_external_job proposal (WP-50) applies through
//     `jobImportService.importJob(userId, { url })` then `saveJob(...)`
//     (or `importJob(userId, { manual })` with the confirmed fields);
//   - the extension's "Save" (WP-55a, F-EXT-09) creates the private job with
//     `jobImportService.saveJob(userId, fields, { source: 'extension', idempotencyKey })`
//     — same limits (active lock → 429, 10 per hour), same dedupe (own
//     import → public job → new private job), same `job_import` credit, same
//     enrichment; pass `importId` when the fields confirm a draft;
//   - the IMPORT_FETCH_DENYLIST check (`isDeniedHost`) for any surface that
//     must not fetch a board's page.

export * from './contract.js';
export { createJobImportRouter } from './routes.js';
export type { JobImportRouterDeps } from './routes.js';
export { createJobImportService, defaultJobImportDeps, importExternalId, jobImportService, storedWarnings, warningsFrom, IMPORT_ENRICH_TIMEOUT_MS } from './service.js';
export type { JobImportDeps, JobImportService, SaveJobOptions, SaveSource } from './service.js';
export { checkImportUrl, hostMatchesPattern, importDenylist, isDeniedHost } from './urlPolicy.js';
