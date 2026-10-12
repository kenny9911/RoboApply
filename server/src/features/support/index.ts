// server/src/features/support/index.ts — public surface of the support area (WP-40).

export * from './contract.js';
export { createSupportRouter, SUPPORT_CONTACT_WINDOWS } from './routes.js';
export { createSupportService, supportAddress, supportService, type SupportService } from './service.js';
export { publicCountWhere, roundDownSignificant } from './stats.js';
