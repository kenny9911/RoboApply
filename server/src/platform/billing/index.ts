// server/src/platform/billing/index.ts — public surface of billing (WP-21a).
//
//   Plans        getPlanCatalog / getPlan / savingsPercent / monthlyEquivalentMinor (planCatalog.ts)
//   Rails        resolveRail(brand, requested?) · registerRail(id, impl) · availableRails (rails/)
//   CN fulfil    fulfilPass({ outTradeNo, channel, paidAmountMinor }) — every CN rail (WP-62 too)
//   Checkout     recordCheckoutAcknowledgements · withdrawalRegion · autoRenewAckSentence
//   Changes      cancelSubscription · quoteSwitch · confirmSwitch (Stripe)
//   Policy       computeRefund (F-BILL-08) · activeOffers (none at launch)
//   Money        fx reference (TWD line) · TW revenue monitor
//   V2 (WP-79)   Taiwan prices (twdPrice / usesTwdPrice) · student discount ·
//                promotion codes · winback sweep (runWinbackSweep)
//   Stripe       key and webhook-secret rules (stripeEnv.ts) · the one client
//                factory (stripeClient.ts) · Products and Prices by lookup key
//                (stripeCatalog.ts) · webhook claims and the event handler
//                registry (stripeEvents.ts)
//
// One bundle per phase owns this file. A module added by another bundle of the
// same phase is imported by its file path until the next owner exports it here.
//
// Importing this module registers the built-in Stripe and Alipay rails.

export * from './planCatalog.js';
export * from './errors.js';
export * from './rails/index.js';
export { PAID_NOTICE_HREF, fulfilPass, closePendingOrder } from './fulfilPass.js';
export type { FulfilDeps, FulfilResult, FulfilStatus, PaidNotice, PassOrderRef } from './fulfilPass.js';
export { grantPracticePack, packExpiry } from './packs.js';
export type { GrantPackInput } from './packs.js';
export {
  CHECKOUT_ACK_PROSE_VERSION,
  EU_COUNTRIES,
  WITHDRAWAL_WAIVER_SENTENCE,
  autoRenewAckSentence,
  proseHash,
  recordCheckoutAcknowledgements,
  showsWithdrawalWaiver,
  withdrawalRegion,
} from './acknowledgements.js';
export type { CheckoutAcknowledgementInput, RecordedAcknowledgements, WithdrawalRegion } from './acknowledgements.js';
export {
  QUOTE_TTL_SEC,
  cancelSubscription,
  confirmSwitch,
  describePlan,
  loadBillingAccount,
  planDefinitionFor,
  quoteSwitch,
  stripePeriod,
  switchPriceFor,
  toSubscriptionRow,
} from './subscriptions.js';
export type { BillingAccount, BillingDb, CancelInput, CancelOutcome, PlanState, PlanStatus, SubscriptionRow, SwitchQuote } from './subscriptions.js';
export {
  ACCIDENTAL_RENEWAL_DAYS,
  FIRST_PURCHASE_DAYS,
  PACK_VALID_MONTHS,
  PAID_ONLY_CREDIT_LIMIT,
  REFUND_POLICY_VERSION,
  SHORT_PLAN_HOURS,
  WITHDRAWAL_DAYS,
  computeRefund,
  isPackPlan,
  paidOnlyCreditsUsed,
} from './refunds.js';
export type { RefundBlocker, RefundDecision, RefundInput, RefundRule } from './refunds.js';
export { OFFERS_SHIPPED, activeOffers, offerViolations } from './offers.js';
export type { Offer, OfferContext } from './offers.js';
export {
  FX_REFERENCE_CONFIG_KEY,
  FX_REFERENCE_MAX_AGE_DAYS,
  fxAgeDays,
  isFxFresh,
  publicFxReference,
  readFxReference,
  saveFxReference,
  twdReferenceWhole,
} from './fxReference.js';
export type { FxReference, PublicFxReference } from './fxReference.js';
export { TW_VAT_THRESHOLD_TWD, TW_WARN_RATIO, computeTwRevenue, taipeiYearStart } from './twRevenue.js';
export type { TwRevenueReport } from './twRevenue.js';
export { STRIPE_CLIENT_CONFIG, getStripe, resetStripeClientForTests, setStripeClientForTests } from './stripeClient.js';
export type { StripeClient } from './stripeClient.js';
export {
  STRIPE_LIVE_KEY_OVERRIDE_ENV,
  STRIPE_WEBHOOK_TRIES_EVERY_SECRET,
  liveKeyAllowed,
  stripeKeyMode,
  stripeKeyUsable,
  stripeRailBlocker,
  stripeRailReady,
  stripeSecretKey,
  stripeWebhookCanVerify,
  stripeWebhookSecrets,
} from './stripeEnv.js';
export type { StripeKeyMode, StripeKeyRefusal, StripeRailBlocker } from './stripeEnv.js';
export {
  STRIPE_LOOKUP_KEYS_PER_CALL,
  STRIPE_PRODUCT_FOR_PLAN,
  STRIPE_PRODUCT_IDS,
  parseStripeLookupKey,
  planKeyForPrice,
  resetStripeCatalogCacheForTests,
  resolveStripePriceId,
  stripeLookupKey,
  stripeRecurringFor,
  syncStripeCatalog,
} from './stripeCatalog.js';
export type { StripeCatalogCurrency, StripeProductId, SyncedPrice } from './stripeCatalog.js';
export {
  billingEventClaimKey,
  claimBillingEvent,
  findBillingOwnerByCustomer,
  invoiceSubscriptionId,
  registerStripeEventHandler,
  stripeEventHandler,
  unregisterStripeEventHandlerForTests,
} from './stripeEvents.js';
export type {
  BillingClaimDb,
  BillingOwner,
  BillingOwnerDb,
  StripeEventContext,
  StripeEventDb,
  StripeEventHandler,
  StripeEventResult,
} from './stripeEvents.js';
export {
  CHECKOUT_ATTEMPT_BUCKET_MS,
  CHECKOUT_ATTEMPT_KEY_PATTERN,
  checkoutAttemptKey,
  checkoutIdempotencyKey,
  checkoutSubmitMessage,
  stripeCheckoutLocale,
} from './rails/stripe.js';
export { appOrigin, callbackOrigin, safeReturnPath } from './origins.js';
export { acceptsPromotionCode, buildPlanViews, promotionCodesEnabled, usesTwdPrice } from './planViews.js';
export { buyerCountryFromRequest } from './buyerCountry.js';
export { assertStudentOrder, studentPlansListedFor, studentVerifiedForPlan } from './studentPlans.js';
export { canBuyPro } from './proPurchase.js';
export type { StudentGateDeps } from './studentPlans.js';
export type { LocalPriceView, PlanView, PlanViewOptions } from './planViews.js';
export {
  WINBACK_AFTER_DAYS,
  WINBACK_TEMPLATE,
  WINBACK_WINDOW_DAYS,
  createWinbackSweep,
  defaultWinbackDeps,
  runWinbackSweep,
  winbackEmail,
  winbackPrice,
} from './winback.js';
export type { WinbackDb, WinbackDeps, WinbackEmailParams } from './winback.js';
