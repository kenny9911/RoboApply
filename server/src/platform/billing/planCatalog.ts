// server/src/platform/billing/planCatalog.ts
//
// The seeker plan catalog (TASK_PLAN.md R-08; PRODUCT_PLAN.md §2.3, §6.3;
// ARCHITECTURE.md §7.1 "Plans"). One list of plan keys per brand; the brand
// decides currency and rail.
//
// Where a price comes from (owner rulings D5 and D6, 2026-10-11; they
// supersede R-15 "GoApply payments off until a switch is set"; amounts per
// docs/jobright-clone/market/MARKET_STRATEGY.md §4):
//   - GoApply (CNY; Alipay, optionally WeChat Pay): every paid plan has a
//     catalog default in fen (`GOAPPLY_DEFAULT_PRICE_FEN`, whole yuan), so a
//     GoApply plan is never "price not set" and is on sale by default.
//       CN_PRICE_<PLANKEY>_FEN   optional override; used only when it is a
//                                positive multiple of 100 (the payment worker
//                                bills whole yuan). Anything else is ignored
//                                and logged, and the default stands.
//       CN_PAYMENTS_ENABLED      the kill switch: a false value ('false', '0',
//                                'off', 'no') marks every plan unsellable
//                                ('payments_disabled'). Unset means on.
//   - RoboApply (USD, Stripe): unchanged in the parity wave.
//       STRIPE_PRICE_<PLANKEY>        the Stripe price id
//       STRIPE_PRICE_<PLANKEY>_CENTS  the display amount (must equal the Stripe price)
//     A RoboApply plan whose price is unset is listed but not sellable. (USD
//     catalog defaults and the Stripe catalog sync are the market wave's.)
// "Sellable" is about the price and the kill switch only. Whether a payment
// can open right now also needs a rail that is configured
// (`availableRails`, e.g. ALIPAY_CALLBACK_SECRET): `GET /billing/plans` puts
// the two together as `paymentsOpen`.
//
// V2 additions (WP-79; PRODUCT_PLAN.md §6.3, TW-06, R-25):
//   - Taiwan prices: STRIPE_PRICE_<PLANKEY>_TWD (a Stripe TWD price id) and
//     STRIPE_PRICE_<PLANKEY>_TWD_CENTS (its amount in TWD minor units, e.g.
//     NT$749 = 74900). Both set → `twdPrice`; otherwise Taiwan keeps the USD
//     price with the reference line. Hidden until configured.
//   - Student plans (`student_monthly`, `student_quarterly`) are priced like
//     any plan; their discount is computed from the two catalog prices
//     (`studentDiscountPercent`, rounded down), never from copy. On GoApply
//     they are passes (学生月卡 30 days, 学生季卡 90 days), like every GoApply plan.
//
// Rules carried here so every caller gets them right:
//   - weekly plans are never the default selection (H24);
//   - auto-renewing plans need the unticked acknowledgement (consent
//     `auto_renew_ack`, kept 3 years);
//   - GoApply sells one-time products only (the mainland rails have no
//     stored agreement and no auto-debit): no GoApply plan renews, and there
//     is no `pro_weekly` there (the weekly product is `pro_week_pass`);
//   - "Save N%" is computed from our own monthly price and rounded DOWN so
//     the claim is never larger than the real saving (PRODUCT §6.1 rule 2);
//   - legacy `starter` / `growth` are grandfathered: never sold, Free-tier
//     limits for everything but their practice credits (PRODUCT §6.3).

import { logger } from '../../services/LoggerService.js';
import { BRANDS, type BrandId, type ProductBrand } from '../brand/registry.js';
import type { EnvSource } from '../brand/brandEnv.js';
import { cnPaymentsKilled } from '../flags.js';

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

/**
 * Why a plan cannot be bought. `price_unset`: RoboApply only (no Stripe price
 * configured). `payments_disabled`: GoApply only, and only under the kill
 * switch (`CN_PAYMENTS_ENABLED` set to a false value).
 */
export type UnsellableReason = 'free' | 'price_unset' | 'payments_disabled';

/** A real price in a second currency (Taiwan, V2). */
export interface LocalPrice {
  currency: 'TWD';
  /** Minor units (NT$749 = 74900). */
  amountMinor: number;
  stripePriceId: string;
}

export interface CatalogPlan extends PlanDefinition {
  currency: ProductBrand['currency'];
  /** Display amount in minor units (cents / fen); null when not configured (RoboApply only: GoApply always has one). */
  amountMinor: number | null;
  /** Stripe price id (RoboApply); null on GoApply (amount-priced passes) and when unset. */
  stripePriceId: string | null;
  /** Taiwan price (Stripe TWD), only when both env values are set and the plan is sellable. */
  twdPrice: LocalPrice | null;
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

// GoApply: one-time passes and packs only, no auto-renew (PRODUCT §6.3;
// MARKET_STRATEGY §4.2 and rule A9). The student passes carry the practice
// allowance of the pass they discount.
const GOAPPLY_PLANS: Def[] = [
  { key: 'free', kind: 'free', interval: null, passDays: null, autoRenews: false, entitlementProfile: 'free', practice: null, defaultLabel: '免费版', phase: 'mvp', neverPreselected: true },
  { key: 'pro_week_pass', kind: 'pass', interval: 'pass', passDays: 7, autoRenews: false, entitlementProfile: 'pro', practice: { credits: 1, per: 'once' }, defaultLabel: '会员周卡', phase: 'mvp', neverPreselected: true },
  { key: 'pro_monthly', kind: 'pass', interval: 'pass', passDays: 30, autoRenews: false, entitlementProfile: 'pro', practice: { credits: 3, per: 'once' }, defaultLabel: '会员月卡', phase: 'mvp', neverPreselected: false },
  { key: 'pro_quarterly', kind: 'pass', interval: 'pass', passDays: 90, autoRenews: false, entitlementProfile: 'pro', practice: { credits: 3, per: 'month' }, defaultLabel: '会员季卡', phase: 'mvp', neverPreselected: false },
  { key: 'practice_pack_5', kind: 'pack', interval: null, passDays: null, autoRenews: false, entitlementProfile: null, practice: { credits: 5, per: 'once', validMonths: 12 }, defaultLabel: '面试练习包 5 次', phase: 'mvp', neverPreselected: true },
  { key: 'practice_pack_15', kind: 'pack', interval: null, passDays: null, autoRenews: false, entitlementProfile: null, practice: { credits: 15, per: 'once', validMonths: 12 }, defaultLabel: '面试练习包 15 次', phase: 'mvp', neverPreselected: true },
  { key: 'student_monthly', kind: 'pass', interval: 'pass', passDays: 30, autoRenews: false, entitlementProfile: 'pro', practice: { credits: 3, per: 'once' }, defaultLabel: '学生月卡', phase: 'v2', requiresFlag: 'student', neverPreselected: true },
  { key: 'student_quarterly', kind: 'pass', interval: 'pass', passDays: 90, autoRenews: false, entitlementProfile: 'pro', practice: { credits: 3, per: 'month' }, defaultLabel: '学生季卡', phase: 'v2', requiresFlag: 'student', neverPreselected: true },
];

/**
 * GoApply catalog default prices in fen (MARKET_STRATEGY.md §4.2: whole yuan,
 * tax-inclusive, paid once, 到期不自动续费). Every paid GoApply plan has one,
 * so none is ever "price not set". `CN_PRICE_<PLANKEY>_FEN` overrides a row.
 */
export const GOAPPLY_DEFAULT_PRICE_FEN: Readonly<Partial<Record<PlanKey, number>>> = {
  pro_week_pass: 1200,
  pro_monthly: 3900,
  pro_quarterly: 9900,
  practice_pack_5: 2900,
  practice_pack_15: 7900,
  student_monthly: 2900,
  student_quarterly: 6900,
};

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

/**
 * The env variables that price a plan on a brand (for docs, admin and
 * errors). GoApply: the optional override of the catalog default.
 * `CN_PAYMENTS_ENABLED` is not a price variable: it is the kill switch.
 */
export function priceEnvNames(brand: BrandId, key: PlanKey): string[] {
  const seg = envKeySegment(key);
  return brand === 'goapply' ? [`CN_PRICE_${seg}_FEN`] : [`STRIPE_PRICE_${seg}`, `STRIPE_PRICE_${seg}_CENTS`];
}

/** The optional Taiwan price variables of a RoboApply plan. */
export function twdPriceEnvNames(key: PlanKey): [string, string] {
  const seg = envKeySegment(key);
  return [`STRIPE_PRICE_${seg}_TWD`, `STRIPE_PRICE_${seg}_TWD_CENTS`];
}

function readMinor(env: EnvSource, name: string): number | null {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Ignored overrides already reported, so a bad value is logged once, not on every catalog read. */
const reportedBadOverrides = new Set<string>();

/**
 * A GoApply price override in fen: a positive multiple of 100 (the payment
 * worker bills whole yuan, and ¥x.9 prices are not ours). Unset or blank →
 * null without a word. Any other value is ignored and logged once; the
 * catalog default stands.
 */
function readFenOverride(env: EnvSource, name: string): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(n) && n > 0 && n % 100 === 0) return n;
  const seen = `${name}=${raw}`;
  if (!reportedBadOverrides.has(seen)) {
    reportedBadOverrides.add(seen);
    logger.warn('RA_BILLING', 'ignored price override: not a whole-yuan amount in fen; the catalog default is used', { variable: name, value: raw.slice(0, 20) });
  }
  return null;
}

function readString(env: EnvSource, name: string): string | null {
  const raw = env[name]?.trim();
  return raw ? raw : null;
}

function priceFor(
  def: PlanDefinition,
  env: EnvSource,
): { amountMinor: number | null; stripePriceId: string | null; twdPrice: LocalPrice | null; sellable: boolean; unsellableReason: UnsellableReason | null } {
  if (def.kind === 'free') return { amountMinor: 0, stripePriceId: null, twdPrice: null, sellable: false, unsellableReason: 'free' };
  const seg = envKeySegment(def.key);
  if (def.brand === 'goapply') {
    // The catalog default, unless a whole-yuan override is set. Every paid
    // GoApply plan has a default (planCatalog.test.ts holds that), so the
    // 'price_unset' branch below is a guard for a plan added without one.
    const amountMinor = readFenOverride(env, `CN_PRICE_${seg}_FEN`) ?? GOAPPLY_DEFAULT_PRICE_FEN[def.key] ?? null;
    if (amountMinor === null) return { amountMinor: null, stripePriceId: null, twdPrice: null, sellable: false, unsellableReason: 'price_unset' };
    // On sale by default (D5). CN_PAYMENTS_ENABLED=false is the kill switch.
    if (cnPaymentsKilled(env)) {
      return { amountMinor, stripePriceId: null, twdPrice: null, sellable: false, unsellableReason: 'payments_disabled' };
    }
    return { amountMinor, stripePriceId: null, twdPrice: null, sellable: true, unsellableReason: null };
  }
  const stripePriceId = readString(env, `STRIPE_PRICE_${seg}`);
  const amountMinor = readMinor(env, `STRIPE_PRICE_${seg}_CENTS`);
  if (!stripePriceId || amountMinor === null) {
    return { amountMinor, stripePriceId, twdPrice: null, sellable: false, unsellableReason: 'price_unset' };
  }
  return { amountMinor, stripePriceId, twdPrice: twdPriceFor(def.key, env), sellable: true, unsellableReason: null };
}

/** The Taiwan price of a plan, or null unless both variables are set (never derived from the USD price). */
export function twdPriceFor(key: PlanKey, env: EnvSource = process.env): LocalPrice | null {
  const [idName, centsName] = twdPriceEnvNames(key);
  const stripePriceId = readString(env, idName);
  const amountMinor = readMinor(env, centsName);
  return stripePriceId && amountMinor !== null ? { currency: 'TWD', amountMinor, stripePriceId } : null;
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

/** Find the plan a Stripe price id belongs to (webhook reconciliation); Taiwan price ids count too. */
export function planKeyForStripePrice(priceId: string | null | undefined, env: EnvSource = process.env): PlanKey | null {
  if (!priceId) return null;
  return getPlanCatalog('roboapply', env).find((p) => p.stripePriceId === priceId || p.twdPrice?.stripePriceId === priceId)?.key ?? null;
}

// ── Student plans (V2) ──────────────────────────────────────────────────

/** The regular plan each student plan is a discount of. */
export const STUDENT_BASE_PLAN: Readonly<Partial<Record<PlanKey, PlanKey>>> = {
  student_monthly: 'pro_monthly',
  student_quarterly: 'pro_quarterly',
};

export function isStudentPlan(plan: Pick<PlanDefinition, 'requiresFlag'> | null | undefined): boolean {
  return plan?.requiresFlag === 'student';
}

/**
 * How much cheaper a student plan is than its regular plan, from the two
 * configured prices, rounded DOWN (the claim is never larger than the real
 * saving). Null when either price is unknown or there is no saving. The
 * product target is 30% (PRODUCT_PLAN.md §6.3); the number shown is always
 * this computed one.
 */
export function studentDiscountPercent(
  plan: Pick<CatalogPlan, 'key' | 'amountMinor'>,
  catalog: ReadonlyArray<Pick<CatalogPlan, 'key' | 'amountMinor'>>,
): number | null {
  const baseKey = STUDENT_BASE_PLAN[plan.key];
  const base = baseKey ? catalog.find((p) => p.key === baseKey) : undefined;
  if (!base || base.amountMinor === null || plan.amountMinor === null || base.amountMinor <= 0) return null;
  if (plan.amountMinor >= base.amountMinor) return null;
  const pct = Math.floor(((base.amountMinor - plan.amountMinor) / base.amountMinor) * 100);
  return pct > 0 ? pct : null;
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
