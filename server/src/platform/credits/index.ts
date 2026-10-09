// server/src/platform/credits/index.ts — public surface of credits + entitlements.
//
//   import { creditService, entitlementService, CreditsExhaustedError } from '../../platform/credits/index.js';
//
//   await creditService.withCredit(
//     { userId, bucket: 'tailor', idempotencyKey: req.get('Idempotency-Key') ?? sessionId, refType: 'tailor_session', refId: sessionId },
//     () => tailorAgent.run(...),
//   );
//   // route: const http = creditErrorToHttp(err); if (http) return res.status(http.status).json(http.body);

export {
  CREDIT_BUCKETS,
  CREDIT_CATALOG_CONFIG_KEY,
  CreditCatalogOverrideSchema,
  DEFAULT_CREDIT_CATALOG,
  ENTITLEMENT_KEYS,
  INSTANT_ALERTS_AS_THEY_ARRIVE,
  MAX_OVERRIDE_CAP,
  WINDOW_BUCKETS,
  catalogFor,
  getCreditCatalog,
  invalidateCreditCatalog,
  isCreditBucket,
  isEntitlementKey,
  isWindowBucket,
  mergeCreditCatalog,
  parseCreditCatalogOverride,
  setCreditCatalogConfigLoader,
} from './catalog.js';
export type {
  BucketCap,
  BucketDefinition,
  CreditBucket,
  CreditCatalog,
  CreditCatalogOverride,
  EntitlementKey,
  EntitlementValues,
  WindowBucket,
} from './catalog.js';
export {
  ACTIVE_SUBSCRIPTION_STATUSES,
  createEntitlementService,
  createPrismaEntitlementSource,
  entitlementService,
  liveSubscription,
  resolveEntitlementsFrom,
} from './EntitlementService.js';
export type {
  AccountSnapshot,
  EntitlementOverrideRow,
  EntitlementService,
  EntitlementSource,
  ResolvedBucket,
  ResolvedEntitlements,
} from './EntitlementService.js';
export { STALE_RESERVATION_MS, createCreditService, creditService, ledgerIdempotencyKey } from './CreditService.js';
export type { BucketUsage, CreditService, Reservation, ReserveOptions } from './CreditService.js';
export {
  CreditReplayError,
  CreditsExhaustedError,
  InvalidIdempotencyKeyError,
  ReservationNotFoundError,
  ReservationStateError,
  UnknownBucketError,
  creditErrorToHttp,
  isCreditError,
} from './errors.js';
export { createPracticeCredits, getPracticeBalance, grantPracticeCredit } from './practice.js';
export type { PracticeBalance, PracticeGrantReason, PracticeGrantResult, PracticeGrantStatus } from './practice.js';
export { summarizeEntitlementsForMe } from './summary.js';
export type { BucketSummary, EntitlementSummary } from './summary.js';
export { createPrismaCreditStore } from './store.js';
export type { CreditStore, CreditTx, LedgerRow, LedgerStatus } from './store.js';
export { createMemoryCreditStore } from './memoryStore.js';
export type { MemoryCreditStore } from './memoryStore.js';
export { CREDIT_WINDOWS, currentWindow, isValidTimeZone, resetsAtFor, safeTimeZone, windowKeyFor } from './windows.js';
export type { CreditWindow } from './windows.js';
