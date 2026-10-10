// server/src/features/tools/index.ts — public surface of free tools (FND-5; owner WP-57).
//
// Seams:
//   `runToolsPurge`   the 24 h purge (jobs-maintain).
// A result is kept in an account only from the browser that ran the check
// (the visitor cookie) — by the tool page's "Keep it" or ToolResultClaimHost
// after signup — so there is no server-side claim at signup.

export * from './contract.js';
export { createToolsPublicRouter } from './routes.js';
export { runToolsPurge, createToolsPurge } from './cron.js';
export { createToolsService, createToolsRate, toolsOpen } from './service.js';
export type { ToolsService, ToolsServiceDeps } from './service.js';
