// server/src/features/growth/index.ts — public surface of GROW (FND-5; WP-23 fills; WP-60 adds invites).
//
// Push-model seams (ruling C20):
//   - markChecklistStep(userId, step): WP-34 ('save_job'), WP-36a ('tailor'),
//     WP-43 ('practice') call it on every occurrence (idempotent: the first
//     time is kept; finishing all three grants 1 practice credit, once).
//   - recordAttribution(userId, touch, { anonId, linkAllowed, lastTouchOnly }):
//     WP-10 signup. The client sends `getAttribution()` (lib/analytics.ts) as
//     `body.attribution`; read it with `touchesFromClient()` (Touch field
//     names), fall back to `touchFromQuery(req.query, { landingPath })` (URL
//     query keys), and take `anonId` + `linkAllowed` from
//     `analyticsIdentity(req, brand.market)`. Write `lastTouch` with a second
//     call (`lastTouchOnly: true`). Recipe in attribution.ts.
//   - deleteEventsForUser(userId): WP-10 account wipe (rows by userId and
//     linked anonIds). Call it before the user's RAAttribution row is deleted.
//   - pruneProductEvents(): WP-13 retention schedule (≈13 months).
// Callers should still catch errors so analytics never breaks the action that
// triggered it.

import type { ChecklistState, ChecklistStep, Touch } from './contract.js';
import { growthServiceImpl, type RecordAttributionOptions } from './service.js';

export * from './contract.js';
export { createInvitesRouter, createGrowthRouter } from './routes.js';
export { createEventsPublicRouter } from './publicRoutes.js';
export { GROWTH_WORK_KINDS } from './workers.js';
export {
  analyticsIdentity,
  functionalTouch,
  requestCountry,
  sanitizeTouch,
  touchFromQuery,
  touchesFromClient,
  ATTRIBUTION_QUERY_KEYS,
  FUNCTIONAL_TOUCH_FIELDS,
} from './attribution.js';
export type { AnalyticsIdentity } from './attribution.js';
export { analyticsLinkAllowed, isAnalyticsConsentRequired, isProductEventName, redactTokenPath, sanitizeEventPath, sanitizeEventProps } from './events.js';
export { CHECKLIST_REWARD_KEY, createGrowthService } from './service.js';
export type { EventsBatchInput, GrowthService, GrowthServiceDeps, IngestContext, RecordAttributionOptions } from './service.js';
export type { ChecklistStore } from './checklistStore.js';

export const growthService = growthServiceImpl;

export const markChecklistStep = (userId: string, step: ChecklistStep): Promise<ChecklistState> => growthService.markChecklistStep(userId, step);
export const recordAttribution = (userId: string, touch: Touch, options?: RecordAttributionOptions) =>
  growthService.recordAttribution(userId, touch, options);
export const deleteEventsForUser = (userId: string) => growthService.deleteEventsForUser(userId);
export const pruneProductEvents = (options?: { now?: Date; retentionDays?: number }) => growthService.pruneProductEvents(options);
