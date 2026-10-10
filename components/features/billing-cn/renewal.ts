// components/features/billing-cn/renewal.ts — can a plan of this brand renew?
//
// RoboApply sells subscriptions (Stripe) that renew until cancelled. The
// mainland market (GoApply) sells passes that are paid once and never renew
// (PRODUCT F-BILL-03 cn; the plan catalog has no renewing GoApply plan), so
// there is never a subscription to cancel there. Plain module (no 'use
// client'): server pages call it.

/** Brands whose paid plans can renew, so a subscription can exist to cancel. */
export function brandHasRenewingPlans(brand: { market: 'intl' | 'cn' }): boolean {
  return brand.market !== 'cn';
}
