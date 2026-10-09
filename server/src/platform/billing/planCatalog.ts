// server/src/platform/billing/planCatalog.ts
//
// The seeker plan catalog (TASK_PLAN.md R-08; PRODUCT_PLAN.md §2.3, §6.3;
// ARCHITECTURE.md §7.1 "Plans"). One list of plan keys per brand; the brand
// decides currency and rail.
//
// Prices are owner decisions (OPS-B1). Nothing here hard-codes an amount:
//   - RoboApply (USD, Stripe):  STRIPE_PRICE_<PLANKEY>        the Stripe price id
//                               STRIPE_PRICE_<PLANKEY>_CENTS  the display amount (must equal the Stripe price)
//   - GoApply  (CNY, Alipay / WeChat Pay):
//                               CN_PRICE_<PLANKEY>_FEN        charge and display amount
//                               CN_PAYMENTS_ENABLED=true      (R-15; off until the EDI licence)
// A plan whose price is unset is listed but not sellable, so `/pricing` can
// show the schedule (GoApply: "暂未开放") and nothing is purchasable.
//
// Rules carried here so every caller gets them right:
//   - weekly plans are never the default selection (H24);
//   - auto-renewing plans need the unticked acknowledgement (consent
//     `auto_renew_ack`, kept 3 years);
//   - "Save N%" is computed from our own monthly price and rounded DOWN so
//     the claim is never larger than the real saving (PRODUCT §6.1 rule 2);
//   - legacy `starter` / `growth` are grandfathered: never sold, Free-tier
//     limits for everything but their practice credits (PRODUCT §6.3).

import { BRANDS, type BrandId, type ProductBrand } from '../brand/registry.js';
import { parseBoolEnv, type EnvSource } from '../brand/brandEnv.js';

export const PLAN_KEYS = [
  'free',
  'pro_weekly',
  'pro_monthly',
  'pro_quarterly',
  'pro_week_pass',
  'practice_pack_5',
  'practice_pack_15',
  'student_monthly',
  'student_quarterly',
] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/** Grandfathered practice plans (`server/src/lib/mockInterviewPlans.ts`). */
export const LEGACY_PLAN_KEYS = ['starter', 'growth'] as const;
export type LegacyPlanKey = (typeof LEGACY_PLAN_KEYS)[number];

/** Which column of the credit catalog a plan unlocks. */
export type PlanProfile = 'free' | 'pro';

export type PlanKind = 'free' | 'subscription' | 'pass' | 'pack';
/** `SeekerSubscription.interval` values. */
export type PlanInterval = 'week' | 'month' | 'quarter' | 'pass';

export interface PracticeAllowance {
  /** Practice credits (1 credit = RA_MOCK_CREDIT_MINUTES minutes, default 20). */
  credits: number;
  /** 'period' = every billing period; 'month' = granted monthly; 'once' = at purchase. */
  per: 'period' | 'month' | 'once';
  /** Packs: months the credits stay valid. */
  validMonths?: number;
}

export interface PlanDefinition {
  key: PlanKey;
  brand: BrandId;
  kind: PlanKind;
  interval: PlanInterval | null;
  /** Fixed access length for passes (days); null for renewing plans and packs. */
  passDays: number | null;
  autoRenews: boolean;
  /** Credit catalog column this plan unlocks; null for packs (they add practice credits only). */
  entitlementProfile: PlanProfile | null;
  practice: PracticeAllowance | null;
  /** i18n key for the display name (billing namespace, WP-21b). */
  labelKey: string;
  /** Canonical name until the i18n key exists (R-08 names; GoApply names are Chinese, PRODUCT §2.3). */
  defaultLabel: string;
  phase: 'mvp' | 'v2';
  /** Hidden unless this capability flag is on (student plans: `student`). */
  requiresFlag?: 'student';
  /** H24: weekly plans and passes are never preselected. */
  neverPreselected: boolean;
}

export type UnsellableReason = 'free' | 'price_unset' | 'payments_disabled';

export interface CatalogPlan extends PlanDefinition {
  currency: ProductBrand['currency'];
  /** Display amount in minor units (cents / fen); null when not configured. */
  amountMinor: number | null;
  /** Stripe price id (RoboApply); null on GoApply (amount-priced passes) and when unset. */
  stripePriceId: string | null;
  sellable: boolean;
  unsellableReason: UnsellableReason | null;
  /** Needs the unticked "renews automatically" acknowledgement at checkout. */
  requiresAutoRenewAck: boolean;
  isDefaultSelection: boolean;
}

type Def = Omit<PlanDefinition, 'brand' | 'labelKey'>;

const ROBOAPPLY_PLANS: Def[] = [
  { key: 'free', kind: 'free', interval: null, passDays: null, autoRenews: false, entitlementProfile: 'free', practice: null, defaultLabel: 'Free', phase: 'mvp', neverPreselected: true },
  { key: 'pro_weekly', kind: 'subscription', interval: 'week', passDays: null, autoRenews: true, entitlementProfile: 'pro', practice: { credits: 1, per: 'period' }, defaultLabel: 'Pro, billed weekly (renews until you cancel)', phase: 'mvp', neverPreselected: true },
  { key: 'pro_monthly', kind: 'subscription', interval: 'month', passDays: null, autoRenews: true, entitlementProfile: 'pro', practice: { credits: 3, per: 'period' }, defaultLabel: 'Pro Monthly', phase: 'mvp', neverPreselected: false },
  { key: 'pro_quarterly', kind: 'subscription', interval: 'quarter', passDays: null, autoRenews: true, entitlementProfile: 'pro', practice: { credits: 3, per: 'month' }, defaultLabel: 'Pro Quarterly', phase: 'mvp', neverPreselected: false },
  { key: 'pro_week_pass', kind: 'pass', interval: 'pass', passDays: 7, autoRenews: false, entitlementProfile: 'pro', practice: { credits: 1, per: 'once' }, defaultLabel: '7-day pass (no renewal)', phase: 'mvp', neverPreselected: true },
  { key: 'practice_pack_5', kind: 'pack', interval: null, passDays: null, autoRenews: false, entitlementProfile: null, practice: { credits: 5, per: 'once', validMonths: 12 }, defaultLabel: 'Practice pack (5)', phase: 'mvp', neverPreselected: true },
  { key: 'practice_pack_15', kind: 'pack', interval: null, passDays: null, autoRenews: false, entitlementProfile: null, practice: { credits: 15, per: 'once', validMonths: 12 }, defaultLabel: 'Practice pack (15)', phase: 'mvp', neverPreselected: true },
  { key: 'student_monthly', kind: 'subscription', interval: 'month', passDays: null, autoRenews: true, entitlementProfile: 'pro', practice: { credits: 3, per: 'period' }, defaultLabel: 'Student Monthly', phase: 'v2', requiresFlag: 'student', neverPreselected: true },
  { key: 'student_quarterly', kind: 'subscription', interval: 'quarter', passDays: null, autoRenews: true, entitlementProfile: 'pro', practice: { credits: 3, per: 'month' }, defaultLabel: 'Student Quarterly', phase: 'v2', requiresFlag: 'student', neverPreselected: true },
];

// GoApply: one-time passes only, no auto-renew (PRODUCT §6.3, CN plan WP-PAY).
const GOAPPLY_PLANS: Def[] = [
  { key: 'free', kind: 'free', interval: null, passDays: null, autoRenews: false, entitlementProfile: 'free', practice: null, defaultLabel: '免费版', phase: 'mvp', neverPreselected: true },
  { key: 'pro_week_pass', kind: 'pass', interval: 'pass', passDays: 7, autoRenews: false, entitlementProfile: 'pro', practice: { credits: 1, per: 'once' }, defaultLabel: '会员周卡', phase: 'mvp', neverPreselected: true },
  { key: 'pro_monthly', kind: 'pass', interval: 'pass', passDays: 30, autoRenews: false, entitlementProfile: 'pro', practice: { credits: 3, per: 'once' }, defaultLabel: '会员月卡', phase: 'mvp', neverPreselected: false },
  { key: 'pro_quarterly', kind: 'pass', interval: 'pass', passDays: 90, autoRenews: false, entitlementProfile: 'pro', practice: { credits: 3, per: 'month' }, defaultLabel: '会员季卡', phase: 'mvp', neverPreselected: false },
  { key: 'practice_pack_5', kind: 'pack', interval: null, passDays: null, autoRenews: false, entitlementProfile: null, practice: { credits: 5, per: 'once', validMonths: 12 }, defaultLabel: '面试练习包 5 次', phase: 'mvp', neverPreselected: true },
  { key: 'practice_pack_15', kind: 'pack', interval: null, passDays: null, autoRenews: false, entitlementProfile: null, practice: { credits: 15, per: 'once', validMonths: 12 }, defaultLabel: '面试练习包 15 次', phase: 'mvp', neverPreselected: true },
];

/** Static plan definitions per brand (no env). */
export const PLAN_DEFINITIONS: Record<BrandId, readonly PlanDefinition[]> = {
  roboapply: ROBOAPPLY_PLANS.map((d) => ({ ...d, brand: 'roboapply' as const, labelKey: `billing.plans.${d.key}.name` })),
  goapply: GOAPPLY_PLANS.map((d) => ({ ...d, brand: 'goapply' as const, labelKey: `billing.plans.${d.key}.name` })),
};

/** Selection order for the default plan; weekly plans and passes never appear here. */
const DEFAULT_SELECTION_ORDER: readonly PlanKey[] = ['pro_monthly', 'pro_quarterly'];

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === 'string' && (PLAN_KEYS as readonly string[]).includes(value);
}

export function isLegacyPlanKey(value: unknown): value is LegacyPlanKey {
  return typeof value === 'string' && (LEGACY_PLAN_KEYS as readonly string[]).includes(value);
}

function envKeySegment(key: PlanKey): string {
  return key.toUpperCase();
}

/** The env variables that price a plan on a brand (for docs, admin and errors). */
export function priceEnvNames(brand: BrandId, key: PlanKey): string[] {
  const seg = envKeySegment(key);
  return brand === 'goapply' ? [`CN_PRICE_${seg}_FEN`, 'CN_PAYMENTS_ENABLED'] : [`STRIPE_PRICE_${seg}`, `STRIPE_PRICE_${seg}_CENTS`];
}

function readMinor(env: EnvSource, name: string): number | null {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function readString(env: EnvSource, name: string): string | null {
  const raw = env[name]?.trim();
  return raw ? raw : null;
}

function priceFor(
  def: PlanDefinition,
  env: EnvSource,
): { amountMinor: number | null; stripePriceId: string | null; sellable: boolean; unsellableReason: UnsellableReason | null } {
  if (def.kind === 'free') return { amountMinor: 0, stripePriceId: null, sellable: false, unsellableReason: 'free' };
  const seg = envKeySegment(def.key);
  if (def.brand === 'goapply') {
    const amountMinor = readMinor(env, `CN_PRICE_${seg}_FEN`);
    if (amountMinor === null) return { amountMinor: null, stripePriceId: null, sellable: false, unsellableReason: 'price_unset' };
    if (!parseBoolEnv(env.CN_PAYMENTS_ENABLED)) {
      return { amountMinor, stripePriceId: null, sellable: false, unsellableReason: 'payments_disabled' };
    }
    return { amountMinor, stripePriceId: null, sellable: true, unsellableReason: null };
  }
  const stripePriceId = readString(env, `STRIPE_PRICE_${seg}`);
  const amountMinor = readMinor(env, `STRIPE_PRICE_${seg}_CENTS`);
  if (!stripePriceId || amountMinor === null) {
    return { amountMinor, stripePriceId, sellable: false, unsellableReason: 'price_unset' };
  }
  return { amountMinor, stripePriceId, sellable: true, unsellableReason: null };
}

/**
 * The resolved catalog for a brand: every plan definition plus its configured
 * price and whether it can be sold now. Order is stable (definition order).
 */
export function getPlanCatalog(brand: BrandId, env: EnvSource = process.env): CatalogPlan[] {
  const currency = BRANDS[brand].currency;
  const plans: CatalogPlan[] = PLAN_DEFINITIONS[brand].map((def) => ({
    ...def,
    currency,
    ...priceFor(def, env),
    requiresAutoRenewAck: def.autoRenews,
    isDefaultSelection: false,
  }));
  const chosen = DEFAULT_SELECTION_ORDER.map((k) => plans.find((p) => p.key === k && p.sellable)).find(Boolean);
  if (chosen) chosen.isDefaultSelection = true;
  return plans;
}

export function getPlan(brand: BrandId, key: PlanKey, env: EnvSource = process.env): CatalogPlan | null {
  return getPlanCatalog(brand, env).find((p) => p.key === key) ?? null;
}

/** The preselected plan key on the plan sheet, or null when no default-eligible plan is sellable. */
export function defaultSelection(brand: BrandId, env: EnvSource = process.env): PlanKey | null {
  return getPlanCatalog(brand, env).find((p) => p.isDefaultSelection)?.key ?? null;
}

/** True when the brand sells at least one plan that unlocks the Pro column (drives `upgradable`). */
export function hasSellableProPlan(brand: BrandId, env: EnvSource = process.env): boolean {
  return getPlanCatalog(brand, env).some((p) => p.sellable && p.entitlementProfile === 'pro' && p.phase === 'mvp');
}

/** Find the plan a Stripe price id belongs to (webhook reconciliation). */
export function planKeyForStripePrice(priceId: string | null | undefined, env: EnvSource = process.env): PlanKey | null {
  if (!priceId) return null;
  return getPlanCatalog('roboapply', env).find((p) => p.stripePriceId === priceId)?.key ?? null;
}

/**
 * Which credit-catalog column a subscription unlocks. `planKey` wins when it
 * is a known key; otherwise the legacy tier decides. Legacy `starter` /
 * `growth` (and the retired V1 `premium*` tiers) get the Free column.
 */
export function entitlementProfileFor(input: { planKey?: string | null; tier?: string | null }): PlanProfile {
  if (isPlanKey(input.planKey)) {
    const def = PLAN_DEFINITIONS.roboapply.find((d) => d.key === input.planKey) ?? PLAN_DEFINITIONS.goapply.find((d) => d.key === input.planKey);
    if (def?.entitlementProfile) return def.entitlementProfile;
    return 'free';
  }
  return input.tier === 'pro' ? 'pro' : 'free';
}

/**
 * "Save N%" for a plan against the brand's monthly price, computed from our
 * own prices and rounded down. Null when either price is unknown, the plan is
 * not multi-month, or there is no saving.
 */
export function savingsPercent(plan: CatalogPlan, monthly: CatalogPlan | null | undefined): number | null {
  if (!monthly || monthly.amountMinor === null || plan.amountMinor === null) return null;
  const months = plan.key === 'pro_quarterly' || plan.key === 'student_quarterly' ? 3 : plan.passDays === 90 ? 3 : 0;
  if (!months) return null;
  const reference = monthly.amountMinor * months;
  if (reference <= 0 || plan.amountMinor >= reference) return null;
  const pct = Math.floor(((reference - plan.amountMinor) / reference) * 100);
  return pct > 0 ? pct : null;
}

/** Weekly plans: the monthly equivalent ("about $43 a month"), 52 weeks / 12, in minor units. */
export function monthlyEquivalentMinor(plan: CatalogPlan): number | null {
  if (plan.interval !== 'week' || plan.amountMinor === null) return null;
  return Math.round((plan.amountMinor * 52) / 12);
}
