// server/src/platform/billing/twRevenue.ts
//
// TW revenue monitor (CN_TW_LAUNCH_PLAN.md TW-06 / T-4; TASK_PLAN.md WP-21a).
// Taiwan requires a foreign e-service provider to register for business tax
// once B2C sales reach NT$600,000 a year. This sums the year-to-date Stripe
// charges paid with a Taiwan-issued card (`payment_method_details.card.country
// === 'TW'`), net of refunds, converts USD at the admin reference rate
// (fxReference.ts) and warns at 70 % of the threshold.
//
// D3: the source is Stripe and the rate carries its own source and as-of.
// Without a fresh rate the NT$ figure is null (shown as "—"), never guessed;
// the USD total is still reported.

import type { FxReference } from './fxReference.js';
import { isFxFresh } from './fxReference.js';

export const TW_VAT_THRESHOLD_TWD = 600_000 as const;
export const TW_WARN_RATIO = 0.7;
/** Hard stop for one scan; the response says `truncated` when hit. */
export const TW_REVENUE_MAX_CHARGES = 10_000;

export interface ChargeLike {
  id: string;
  amount: number;
  amount_refunded?: number | null;
  currency: string;
  status?: string | null;
  paid?: boolean | null;
  created: number;
  payment_method_details?: { card?: { country?: string | null } | null } | null;
}

export interface StripeChargesLike {
  charges: {
    list(params: { created: { gte: number }; limit: number; starting_after?: string }): Promise<{ data: ChargeLike[]; has_more: boolean }>;
  };
}

export interface TwRevenueReport {
  /** Start of the Taiwan calendar year (Asia/Taipei midnight, as UTC ISO). */
  periodStart: string;
  /** Year-to-date NT$ (USD converted at the reference rate + any TWD charges); null without a fresh rate. */
  revenueTwd: number | null;
  /** Year-to-date USD from TW cards, cents. */
  revenueUsdMinor: number;
  /** TWD-denominated charges (Stripe TWD prices, V2), in whole NT$. */
  revenueTwdChargesWhole: number;
  thresholdTwd: typeof TW_VAT_THRESHOLD_TWD;
  warnAt: number;
  /** revenueTwd ≥ 70 % of the threshold. */
  warning: boolean;
  chargeCount: number;
  /** Charges in other currencies that were not counted. */
  skippedOtherCurrency: number;
  truncated: boolean;
  fx: { ratePerUsd: number; source: string; asOf: string; fresh: boolean } | null;
  source: 'stripe';
  asOf: string;
}

/** Midnight 1 January in Asia/Taipei (UTC+8, no DST) for the Taipei year containing `now`. */
export function taipeiYearStart(now: Date): Date {
  const taipei = new Date(now.getTime() + 8 * 3_600_000);
  return new Date(Date.UTC(taipei.getUTCFullYear(), 0, 1) - 8 * 3_600_000);
}

export async function computeTwRevenue(input: {
  stripe: StripeChargesLike;
  fx: FxReference | null;
  now: Date;
  maxCharges?: number;
}): Promise<TwRevenueReport> {
  const start = taipeiYearStart(input.now);
  const max = input.maxCharges ?? TW_REVENUE_MAX_CHARGES;
  let usdMinor = 0;
  let twdMinor = 0;
  let count = 0;
  let skipped = 0;
  let scanned = 0;
  let truncated = false;
  let startingAfter: string | undefined;

  for (;;) {
    const page = await input.stripe.charges.list({
      created: { gte: Math.floor(start.getTime() / 1000) },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const ch of page.data) {
      scanned += 1;
      const paid = ch.paid !== false && (ch.status ?? 'succeeded') === 'succeeded';
      const country = ch.payment_method_details?.card?.country?.toUpperCase() ?? null;
      if (!paid || country !== 'TW') continue;
      const net = Math.max(0, ch.amount - (ch.amount_refunded ?? 0));
      const cur = ch.currency.toLowerCase();
      if (cur === 'usd') {
        usdMinor += net;
        count += 1;
      } else if (cur === 'twd') {
        twdMinor += net;
        count += 1;
      } else {
        skipped += 1;
      }
    }
    if (!page.has_more || page.data.length === 0) break;
    if (scanned >= max) {
      truncated = true;
      break;
    }
    startingAfter = page.data[page.data.length - 1]!.id;
  }

  const fresh = isFxFresh(input.fx, input.now);
  const twdChargesWhole = Math.round(twdMinor / 100);
  const revenueTwd = fresh && input.fx ? Math.round((usdMinor / 100) * input.fx.ratePerUsd) + twdChargesWhole : null;
  const warnAt = Math.round(TW_VAT_THRESHOLD_TWD * TW_WARN_RATIO);
  return {
    periodStart: start.toISOString(),
    revenueTwd,
    revenueUsdMinor: usdMinor,
    revenueTwdChargesWhole: twdChargesWhole,
    thresholdTwd: TW_VAT_THRESHOLD_TWD,
    warnAt,
    warning: revenueTwd !== null && revenueTwd >= warnAt,
    chargeCount: count,
    skippedOtherCurrency: skipped,
    truncated,
    fx: input.fx ? { ratePerUsd: input.fx.ratePerUsd, source: input.fx.source, asOf: input.fx.asOf, fresh } : null,
    source: 'stripe',
    asOf: input.now.toISOString(),
  };
}
