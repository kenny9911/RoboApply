// server/src/platform/billing/planViews.ts
//
// What the plan sheet and /pricing receive (PRODUCT_PLAN.md §6.1, §6.3;
// F-BILL-02): every plan of the brand with its configured price, whether it
// can be bought now, the "Save N%" computed from our own monthly price
// (rounded down), the weekly plan's monthly equivalent ("about $43 a month"),
// and the preselected plan (never weekly, never a pass). Student plans (V2)
// appear only when the `student` capability is on.

import type { EnvSource } from '../brand/brandEnv.js';
import type { BrandId } from '../brand/registry.js';
import { getPlanCatalog, monthlyEquivalentMinor, savingsPercent, type CatalogPlan } from './planCatalog.js';

export interface PlanView extends CatalogPlan {
  /** "Save N%" against 3 × our own monthly price, rounded down; null when there is no real saving. */
  savingsPercent: number | null;
  /** Weekly plans only: price × 52 / 12, minor units. */
  monthlyEquivalentMinor: number | null;
  /** The signed-in user's current plan. */
  current: boolean;
}

export interface PlanViewOptions {
  env?: EnvSource;
  currentPlanKey?: string | null;
  /** The `student` capability (V2 plans). */
  studentEnabled?: boolean;
}

export function buildPlanViews(brand: BrandId, options: PlanViewOptions = {}): { plans: PlanView[]; defaultSelection: string | null } {
  const catalog = getPlanCatalog(brand, options.env ?? process.env);
  const monthly = catalog.find((p) => p.key === 'pro_monthly') ?? null;
  const plans = catalog
    .filter((p) => p.phase === 'mvp' || (p.requiresFlag === 'student' && options.studentEnabled))
    .map((p) => ({
      ...p,
      savingsPercent: savingsPercent(p, monthly),
      monthlyEquivalentMinor: monthlyEquivalentMinor(p),
      current: Boolean(options.currentPlanKey) && options.currentPlanKey === p.key,
    }));
  const chosen = plans.find((p) => p.isDefaultSelection && !p.neverPreselected);
  return { plans, defaultSelection: chosen?.key ?? null };
}
