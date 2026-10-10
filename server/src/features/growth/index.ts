// server/src/features/growth/index.ts — public surface of GROW (FND-5; WP-23 fills; WP-60 adds invites).
//
// Invite friends (WP-60):
//   - recordAttribution (below) attaches a new account to the invite code it
//     signed up with (`ref` / `inviteCode` in the touch; the first that reads
//     as a code). Pass `signals: { ip, userAgent, deviceId }` from the signup
//     request for the risk check. EVERY sign-up path of a brand must call it
//     before the brand is listed in INVITE_SIGNUP_WIRED_BRANDS (contract.ts):
//     GoApply's phone and WeChat sign-ups (features/auth-cn) do not yet, so
//     the programme is hidden on GoApply (request R-60-3).
//   - checkReferralFor(userId): call after the user verifies their email or
//     phone, links Google/LINE/WeChat, or finishes onboarding; it grants the
//     invite credits at once when they are due (otherwise the
//     growth.referralRisk worker gets there within its polling schedule).
//   - createInvitesAdminRouter: held rewards review (mount requested from INT).
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
import { referralServiceImpl } from './referrals.js';

export * from './contract.js';
export { createInvitesRouter, createInvitesAdminRouter, createGrowthRouter, requestSignals, INVITE_SHARED_LIMITS } from './routes.js';
export { createEventsPublicRouter } from './publicRoutes.js';
export { GROWTH_WORK_KINDS, createReferralWorker, createSignalPruneWorker, nextCheckDelayMs } from './workers.js';
export { createReferralService, inviteOrigin, referralServiceImpl, REFERRAL_WORK_KIND, SIGNAL_PRUNE_WORK_KIND, yearStart } from './referrals.js';
export type { AttachResult, EvaluateOutcome, ReferralDb, ReferralService, ReferralServiceDeps } from './referrals.js';
export { generateReferralCode, invitePath, normalizeReferralCode } from './referralCodes.js';
export { hashSignals, normalizeEmailForReferral, normalizeIp, scoreReferralRisk, RISK_WEIGHTS } from './referralRisk.js';
export type { HashedSignals, RawSignals, RiskReason, RiskResult, SignalRow } from './referralRisk.js';
export { createDelegateSignalStore, resolvePrismaSignalStore, MAX_ROWS_PER_USER_PER_DAY } from './referralSignalStore.js';
export type { ReferralSignalStore } from './referralSignalStore.js';
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

/** Check the user's invite now (after verification or finishing onboarding). Never throws. */
export const checkReferralFor = (userId: string) => referralServiceImpl.checkReferralFor(userId);
/** Delete invite risk signals older than 30 days (the growth.referralSignalPrune worker also does this; safe to call from the daily cron). */
export const pruneReferralSignals = (options?: { now?: Date }) => referralServiceImpl.pruneSignals(options);
