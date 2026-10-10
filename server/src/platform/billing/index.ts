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
  switchPrice,
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
export { getStripe, setStripeClientForTests } from './stripeClient.js';
export type { StripeClient } from './stripeClient.js';
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
