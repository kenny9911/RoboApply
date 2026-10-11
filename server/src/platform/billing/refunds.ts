// server/src/platform/billing/refunds.ts
//
// Refund policy calculator (PRODUCT_PLAN.md F-BILL-08; TASK_PLAN.md WP-21a).
// Pure: give it the facts about one charge, get back whether a refund is due,
// how much, under which rule and until when.
//
// Rules, checked in this order:
//   1. Right of withdrawal (EU/EEA, UK, TW billing country): a first purchase
//      or a pack is refunded in full within 14 days unless the user ticked
//      the withdrawal waiver at checkout ("Start now: I understand I lose my
//      right of withdrawal once I use paid features"). TW applies the
//      digital-services exemption only with that prior agreement, and we use
//      the same 14 days there (more generous than the statutory 7).
//   1b. The same right WITH the waiver ticked, for an auto-renewing
//      subscription (MARKET_STRATEGY.md §4.4 "Statutory withdrawal", M-21;
//      the default until counsel rules): within 14 days of a first purchase
//      and before the paid period ends, the unused days of that period are
//      refunded pro rata. The "lose the right once it starts" exception covers
//      digital content, not a subscription service. Needs the bounds of the
//      period the charge paid for; without them, or with bounds of a later
//      period (the paid one is then over), this rule does not apply and the
//      rules below decide. A pass and practice credits keep rules 2 to 4.
//   2. Practice packs: refundable while no credit from the pack was used
//      (within the pack's 12-month validity).
//   3. First purchase of a plan: within 7 days (weekly plan and 7-day pass:
//      48 hours) if fewer than 5 paid-only credits were used.
//   4. Renewal charged by mistake: within 3 days of the renewal.
//   Otherwise no refund is due under the policy (support may still refund).
//
// A withdrawal (rule 1 or 1b) ends the contract: the decision says so in
// `endsAccess`, and stripeRefunds.ts `withdrawPurchase` cancels the
// subscription before it refunds.
//
// GoApply uses the same standard rules for its passes pending counsel review
// (CN consumer law, OPS-C); the decision says so in `policyVersion`.

import type { BrandId } from '../brand/registry.js';
import { withdrawalRegion, type WithdrawalRegion } from './acknowledgements.js';

/**
 * The rule set a decision was made under (stored with the decision). RoboApply
 * is on v2 since rule 1b (pro-rata withdrawal with the waiver); GoApply's
 * passes are outside that rule, so its rule set keeps its name. Anything a
 * buyer can read uses the public label (features/credits/service.ts
 * `publicRefundPolicyVersion`), never this value.
 */
export const REFUND_POLICY_VERSION = { roboapply: 'refund-v2-2026-10', goapply: 'refund-v1-2026-10-pending-counsel' } as const;

export const WITHDRAWAL_DAYS = 14;
export const FIRST_PURCHASE_DAYS = 7;
export const SHORT_PLAN_HOURS = 48;
export const ACCIDENTAL_RENEWAL_DAYS = 3;
export const PACK_VALID_MONTHS = 12;
/** "fewer than 5 paid-only credits used". */
export const PAID_ONLY_CREDIT_LIMIT = 5;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type RefundRule =
  | 'withdrawal_14d'
  | 'withdrawal_14d_prorata'
  | 'unused_pack'
  | 'first_purchase_7d'
  | 'first_purchase_48h'
  | 'accidental_renewal_3d'
  | 'none';

/** The two statutory withdrawal rules (1 and 1b). */
export type WithdrawalRule = Extract<RefundRule, 'withdrawal_14d' | 'withdrawal_14d_prorata'>;

export function isWithdrawalRule(rule: RefundRule): rule is WithdrawalRule {
  return rule === 'withdrawal_14d' || rule === 'withdrawal_14d_prorata';
}

export type RefundBlocker =
  | 'window_passed'
  | 'credits_used'
  | 'pack_used'
  | 'nothing_charged';

export interface RefundInput {
  brand: BrandId;
  /** R-08 plan key or a legacy key ('starter' | 'growth'). */
  planKey: string;
  chargeKind: 'first_purchase' | 'renewal';
  chargedAt: Date;
  /** The amount charged for this purchase, minor units. */
  amountMinor: number;
  currency: string;
  now: Date;
  /** ISO country of the paying card / billing address, when known. */
  billingCountry: string | null;
  /** The user ticked the withdrawal waiver at this checkout. */
  withdrawalWaiver: boolean;
  /** Metered AI credits used since the charge beyond the Free caps. */
  paidOnlyCreditsUsed: number;
  /** Packs only: practice credits from this pack already used. */
  packCreditsUsed?: number;
  /**
   * Subscriptions only: the paid period THIS charge bought (the period of the
   * invoice's subscription line). Rule 1b needs both; without them it does not
   * apply. Bounds that start after the charge are those of a later period
   * (Stripe moves a subscription to its next period before it collects the
   * renewal): the paid period is over, and rule 1b does not apply either.
   */
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

export interface RefundDecision {
  eligible: boolean;
  /**
   * The amount to refund when eligible, else 0: the full charge, or the unused
   * days' share under `withdrawal_14d_prorata` (which is 0 on the last day of
   * a period: the contract still ends, nothing is left to return).
   */
  amountMinor: number;
  currency: string;
  rule: RefundRule;
  /** Why not, when not eligible. */
  blocker: RefundBlocker | null;
  /** Last moment the rule that applies (or applied) allows a refund; null when none. */
  deadline: string | null;
  withdrawalRegion: WithdrawalRegion | null;
  policyVersion: string;
  /** Rule `withdrawal_14d_prorata` only: the whole days counted as used and the days of the period. */
  prorata: { usedDays: number; periodDays: number } | null;
  /** The refund ends the contract (both withdrawal rules): the plan stops now, whatever the amount. */
  endsAccess: boolean;
}

const PACK_KEYS = new Set(['practice_pack_5', 'practice_pack_15']);
/** Plans whose first-purchase window is 48 hours. */
const SHORT_PLANS = new Set(['pro_weekly', 'pro_week_pass']);
/**
 * RoboApply's auto-renewing subscriptions (rule 1b). GoApply sells the same
 * keys as one-time passes (rule A9), so the rule never applies to that brand.
 * refunds.test.ts holds this list equal to the plan catalog.
 */
export const PRORATA_WITHDRAWAL_PLANS: ReadonlySet<string> = new Set(['pro_weekly', 'pro_monthly', 'pro_quarterly', 'student_monthly', 'student_quarterly']);

export function isPackPlan(planKey: string): boolean {
  return PACK_KEYS.has(planKey);
}

function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

export function computeRefund(input: RefundInput): RefundDecision {
  const region = withdrawalRegion(input.billingCountry);
  const policyVersion = REFUND_POLICY_VERSION[input.brand];
  const base = { currency: input.currency, withdrawalRegion: region, policyVersion };
  const no = (rule: RefundRule, blocker: RefundBlocker, deadline: Date | null): RefundDecision => ({
    ...base,
    eligible: false,
    amountMinor: 0,
    rule,
    blocker,
    deadline: deadline ? deadline.toISOString() : null,
    prorata: null,
    endsAccess: false,
  });
  const yes = (rule: RefundRule, deadline: Date): RefundDecision => ({
    ...base,
    eligible: true,
    amountMinor: input.amountMinor,
    rule,
    blocker: null,
    deadline: deadline.toISOString(),
    prorata: null,
    endsAccess: isWithdrawalRule(rule),
  });

  if (!(input.amountMinor > 0)) return no('none', 'nothing_charged', null);
  const now = input.now.getTime();
  const pack = isPackPlan(input.planKey);

  // 1. Statutory right of withdrawal (first purchases and packs; never renewals).
  if (region && !input.withdrawalWaiver && (input.chargeKind === 'first_purchase' || pack)) {
    const deadline = addMs(input.chargedAt, WITHDRAWAL_DAYS * DAY_MS);
    if (now <= deadline.getTime()) return yes('withdrawal_14d', deadline);
  }

  // 1b. The same right with the waiver ticked: the unused days of an
  // auto-renewing subscription's first period, pro rata.
  if (
    region &&
    input.withdrawalWaiver &&
    input.chargeKind === 'first_purchase' &&
    input.brand === 'roboapply' &&
    PRORATA_WITHDRAWAL_PLANS.has(input.planKey) &&
    input.periodStart &&
    input.periodEnd
  ) {
    const start = input.periodStart.getTime();
    const end = input.periodEnd.getTime();
    const charged = input.chargedAt.getTime();
    const withdrawalEnd = charged + WITHDRAWAL_DAYS * DAY_MS;
    // The bounds must be those of the period this charge paid for: it started
    // by the time of the charge (an hour of slack for the provider's clock)
    // and had not ended. A period that starts later is the next, unpaid one.
    const paidPeriod = start <= charged + HOUR_MS && charged < end;
    if (end > start && paidPeriod && now <= withdrawalEnd && now < end) {
      const periodDays = Math.max(1, Math.round((end - start) / DAY_MS));
      const usedDays = Math.min(periodDays, Math.max(0, Math.ceil((now - start) / DAY_MS)));
      return {
        ...base,
        eligible: true,
        amountMinor: Math.floor((input.amountMinor * (periodDays - usedDays)) / periodDays),
        rule: 'withdrawal_14d_prorata',
        blocker: null,
        deadline: new Date(Math.min(withdrawalEnd, end)).toISOString(),
        prorata: { usedDays, periodDays },
        endsAccess: true,
      };
    }
  }

  // 2. Practice packs: refundable while unused, within their validity.
  if (pack) {
    const deadline = addMonths(input.chargedAt, PACK_VALID_MONTHS);
    if ((input.packCreditsUsed ?? 0) > 0) return no('unused_pack', 'pack_used', deadline);
    if (now > deadline.getTime()) return no('unused_pack', 'window_passed', deadline);
    return yes('unused_pack', deadline);
  }

  // 3. First purchase of a plan.
  if (input.chargeKind === 'first_purchase') {
    const short = SHORT_PLANS.has(input.planKey);
    const rule: RefundRule = short ? 'first_purchase_48h' : 'first_purchase_7d';
    const deadline = addMs(input.chargedAt, short ? SHORT_PLAN_HOURS * HOUR_MS : FIRST_PURCHASE_DAYS * DAY_MS);
    if (now > deadline.getTime()) return no(rule, 'window_passed', deadline);
    if (input.paidOnlyCreditsUsed >= PAID_ONLY_CREDIT_LIMIT) return no(rule, 'credits_used', deadline);
    return yes(rule, deadline);
  }

  // 4. A renewal charged by mistake.
  const deadline = addMs(input.chargedAt, ACCIDENTAL_RENEWAL_DAYS * DAY_MS);
  if (now > deadline.getTime()) return no('accidental_renewal_3d', 'window_passed', deadline);
  return yes('accidental_renewal_3d', deadline);
}

/**
 * Paid-only credits used: committed metered usage above the Free cap of each
 * window. `usage` is one row per (bucket, window) with the units committed in
 * it since the charge; `freeCaps` the Free column cap per bucket.
 */
export function paidOnlyCreditsUsed(
  usage: ReadonlyArray<{ bucket: string; windowKey: string | null; units: number }>,
  freeCaps: Readonly<Record<string, number>>,
): number {
  const perWindow = new Map<string, { bucket: string; units: number }>();
  for (const row of usage) {
    const key = `${row.bucket}|${row.windowKey ?? ''}`;
    const cur = perWindow.get(key);
    perWindow.set(key, { bucket: row.bucket, units: (cur?.units ?? 0) + Math.max(0, row.units) });
  }
  let total = 0;
  for (const { bucket, units } of perWindow.values()) {
    const cap = freeCaps[bucket];
    if (cap === undefined) continue;
    total += Math.max(0, units - cap);
  }
  return total;
}
