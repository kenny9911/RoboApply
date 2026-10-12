// server/src/platform/billing/offers.ts
//
// Offers seam (ARCHITECTURE.md §7.4; PRODUCT_PLAN.md §6.4, F-BILL-04; R-08).
// **No offer ships at launch.** The seam exists so an owner-approved
// "Welcome price" (OPS-B1) can be switched on later without touching the
// checkout or the plan sheet, and it encodes the rules such an offer must
// follow:
//   - server-timed only: the start time is persisted (RAUserUiState), never a
//     countdown that resets;
//   - ends 7 days after signup and is shown as a date, never a ticking timer;
//   - no comparison price; "instead of {price}" only once that price has been
//     charged for 30 days;
//   - plan badge and /pricing only: no popup, no struck-through anchor.
// `activeOffers()` returns [] until an owner decision flips OFFERS_SHIPPED
// AND a definition is added here; nothing reads an offer amount from copy.

import type { BrandId } from '../brand/registry.js';
import type { PlanKey } from './planCatalog.js';

export interface Offer {
  id: string;
  kind: 'welcome_price';
  brand: BrandId;
  planKey: PlanKey;
  /** The offer price, minor units, from config only. */
  amountMinor: number;
  startsAt: string;
  /** Shown as a date. */
  endsAt: string;
  /** Present only when the regular price has been charged for at least 30 days. */
  regularAmountMinor: number | null;
}

export interface OfferContext {
  brand: BrandId;
  userId: string | null;
  signedUpAt: Date | null;
  now: Date;
}

/** False at launch (H23: no offer). Flip only with an owner decision and a definition below. */
export const OFFERS_SHIPPED = false as const;

/** The offers a user may see right now. Always empty at launch. */
export function activeOffers(_ctx: OfferContext): Offer[] {
  if (!OFFERS_SHIPPED) return [];
  return [];
}

/** Rule check for any future offer definition (used by its tests). */
export function offerViolations(offer: Offer, ctx: { now: Date; regularPriceChargedSince: Date | null }): string[] {
  const out: string[] = [];
  const start = Date.parse(offer.startsAt);
  const end = Date.parse(offer.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) out.push('invalid_window');
  if (end - start > 7 * 24 * 3_600_000) out.push('longer_than_7_days');
  if (offer.regularAmountMinor !== null) {
    const since = ctx.regularPriceChargedSince?.getTime() ?? null;
    if (since === null || ctx.now.getTime() - since < 30 * 24 * 3_600_000) out.push('comparison_price_not_established');
  }
  if (!(offer.amountMinor > 0)) out.push('invalid_amount');
  return out;
}
