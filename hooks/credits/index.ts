// hooks/credits — billing and credits hooks (WP-21b). The shared credit
// summary hooks live in hooks/shared (useCredits, useEntitlements,
// useCreditGate, FND-7); these add plans, billing actions, the public cancel
// flow, credit history and the admin caps console.

export { usePlans, visiblePlans, initialSelection, monthlyPlan, plansExtras, PLANS_QUERY_KEY, PLANS_STALE_MS } from './usePlans';
export { useSubscriptionState, deriveSubscriptionState, summaryCancelAtPeriodEnd, type SubscriptionState, type SubscriptionStatus } from './useSubscriptionState';
export { useVisitorCountry, VISITOR_COUNTRY_QUERY_KEY, type VisitorCountry } from './useVisitorCountry';
export {
  useCancelSubscription,
  useCancelSurvey,
  usePlanCheckout,
  useCheckoutAttempt,
  newAttemptKey,
  checkoutRedirectUrl,
  useSwitchQuote,
  useConfirmSwitch,
  usePaymentPortal,
  type CancelSurveyVars,
  type PlanCheckoutVars,
  type CheckoutAttempt,
} from './useBillingActions';
export { useRequestCancelLink, useConfirmPublicCancel } from './usePublicCancel';
export { useCreditHistory, CREDIT_HISTORY_QUERY_KEY } from './useCreditHistory';
export {
  adminCreditsKeys,
  useAdminCreditCatalog,
  useSaveCreditCatalog,
  useAdminOverrides,
  useCreateOverride,
  useDeleteOverride,
  useAdminFxReference,
  useSaveFxReference,
  useTwRevenue,
} from './useAdminCredits';
