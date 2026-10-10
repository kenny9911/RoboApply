// server/src/platform/billing/planViews.ts
//
// What the plan sheet and /pricing receive (PRODUCT_PLAN.md §6.1, §6.3;
// F-BILL-02): every plan of the brand with its configured price, whether it
// can be bought now, the "Save N%" computed from our own monthly price
// (rounded down), the weekly plan's monthly equivalent ("about $43 a month"),
// and the preselected plan (never weekly, never a pass). Student plans (V2)
// appear only when the `student` capability is on.
//
// V2 (WP-79):
//   - `localPrice`: the real Taiwan price (Stripe TWD) when the buyer's country
//     is TW and the owner configured it; its savings and weekly equivalent are
//     computed in TWD. Without it Taiwan keeps the USD price + reference line.
//   - `studentDiscountPercent`: computed from the two configured prices, in
//     the currency shown (`localPrice.studentDiscountPercent` for TWD).
//   - `promotionCodes`: the payment page accepts a promotion code
//     (STRIPE_PROMOTION_CODES=true; never on student plans, so discounts do
//     not stack by accident).

import { parseBoolEnv, type EnvSource } from '../brand/brandEnv.js';
import type { BrandId } from '../brand/registry.js';
import {
  getPlanCatalog,
  isStudentPlan,
  monthlyEquivalentMinor,
  savingsPercent,
  studentDiscountPercent,
  type CatalogPlan,
  type PlanDefinition,
} from './planCatalog.js';

export interface LocalPriceView {
  currency: 'TWD';
  amountMinor: number;
  savingsPercent: number | null;
  monthlyEquivalentMinor: number | null;
  /**
   * Student plans: % below the regular plan computed from the two TWD
   * prices (rounded down). Null when either TWD price is missing; the USD
   * percentage is never shown next to a TWD price.
   */
  studentDiscountPercent: number | null;
}

export interface PlanView extends CatalogPlan {
  /** "Save N%" against 3 × our own monthly price, rounded down; null when there is no real saving. */
  savingsPercent: number | null;
  /** Weekly plans only: price × 52 / 12, minor units. */
  monthlyEquivalentMinor: number | null;
  /** The signed-in user's current plan. */
  current: boolean;
  /** Taiwan buyers with a configured TWD price: the price they are charged. */
  localPrice: LocalPriceView | null;
  /** Student plans: % below the regular plan, from configured prices (rounded down). */
  studentDiscountPercent: number | null;
  /** The payment page takes a promotion code for this plan. */
  promotionCodes: boolean;
}

export interface PlanViewOptions {
  env?: EnvSource;
  currentPlanKey?: string | null;
  /** The `student` capability (V2 plans). */
  studentEnabled?: boolean;
  /** Buyer's country (edge header); 'TW' selects configured TWD prices. */
  country?: string | null;
}

/** Stripe promotion codes are on (F-BILL-11, V2; off by default). */
export function promotionCodesEnabled(env: EnvSource = process.env): boolean {
  return parseBoolEnv(env.STRIPE_PROMOTION_CODES);
}

/** Whether checkout for this plan accepts a promotion code. */
export function acceptsPromotionCode(plan: Pick<PlanDefinition, 'brand' | 'kind' | 'requiresFlag'>, env: EnvSource = process.env): boolean {
  return plan.brand === 'roboapply' && plan.kind !== 'free' && !isStudentPlan(plan) && promotionCodesEnabled(env);
}

/** True when this buyer is charged the plan's Taiwan price. */
export function usesTwdPrice(plan: Pick<CatalogPlan, 'twdPrice'>, country: string | null | undefined): boolean {
  return (country ?? '').trim().toUpperCase() === 'TW' && plan.twdPrice !== null;
}

function localPriceView(
  plan: CatalogPlan,
  monthly: CatalogPlan | null,
  catalog: readonly CatalogPlan[],
  country: string | null | undefined,
): LocalPriceView | null {
  if (!usesTwdPrice(plan, country)) return null;
  const twd = plan.twdPrice!;
  const asTwd = (p: CatalogPlan): CatalogPlan => ({ ...p, amountMinor: p.twdPrice?.amountMinor ?? null });
  const monthlyTwd = monthly?.twdPrice ? asTwd(monthly) : null;
  return {
    currency: 'TWD',
    amountMinor: twd.amountMinor,
    savingsPercent: savingsPercent(asTwd(plan), monthlyTwd),
    monthlyEquivalentMinor: monthlyEquivalentMinor(asTwd(plan)),
    studentDiscountPercent: isStudentPlan(plan) ? studentDiscountPercent(asTwd(plan), catalog.map(asTwd)) : null,
  };
}

export function buildPlanViews(brand: BrandId, options: PlanViewOptions = {}): { plans: PlanView[]; defaultSelection: string | null } {
  const env = options.env ?? process.env;
  const catalog = getPlanCatalog(brand, env);
  const monthly = catalog.find((p) => p.key === 'pro_monthly') ?? null;
  const plans = catalog
    .filter((p) => p.phase === 'mvp' || (p.requiresFlag === 'student' && options.studentEnabled))
    .map((p) => ({
      ...p,
      savingsPercent: savingsPercent(p, monthly),
      monthlyEquivalentMinor: monthlyEquivalentMinor(p),
      current: Boolean(options.currentPlanKey) && options.currentPlanKey === p.key,
      localPrice: localPriceView(p, monthly, catalog, options.country),
      studentDiscountPercent: isStudentPlan(p) ? studentDiscountPercent(p, catalog) : null,
      promotionCodes: p.sellable && acceptsPromotionCode(p, env),
    }));
  const chosen = plans.find((p) => p.isDefaultSelection && !p.neverPreselected);
  return { plans, defaultSelection: chosen?.key ?? null };
}
