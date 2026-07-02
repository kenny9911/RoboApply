// backend/src/lib/mockInterviewPlans.ts
//
// Single source of truth for the RoboApply mock-interview SUBSCRIPTION plans
// (Free / Starter / Growth) and the credit math (1 credit = 20 minutes).
//
// This is the REVENUE catalogue for the candidate-facing mock-interview product.
// It is deliberately separate from rateCard.ts `tiers` (which keeps the legacy
// auto-apply daily-cap pricing) so the two products can price independently.
//
// Precedence per field (mirrors rateCard.ts / the LLM-settings stack):
//   AppConfig['mock_plans.{env}'] (DB override) ?? env var ?? hardcoded default.
// The hardcoded default is the owner-locked pricing, so an empty DB resolves
// byte-for-byte to it (the "empty DB == env == default" invariant). Admins can
// retune price / credits without a redeploy by writing the AppConfig blob.
//
// Never throws: a cold cache or DB error degrades to env/default.

import prisma from './prisma.js';
import { logger } from '../services/LoggerService.js';
import { getActiveEnvironment, type ConfigEnvironment } from './llm/llmStackConfigSchema.js';

export type MockPlanKey = 'free' | 'starter' | 'growth';

export interface MockPlan {
  key: MockPlanKey;
  /** Monthly mock-interview credit allotment. 1 credit = CREDIT_MINUTES minutes. */
  credits: number;
  /** Monthly price in USD minor units (cents). 0 for free. */
  usdMinor: number;
  /** Monthly price in CNY minor units (fen). 0 for free. */
  cnyMinor: number;
  /** Stripe recurring price id for the USD subscription. null when not configured. */
  stripePriceId: string | null;
}

export interface MockPlanCatalog {
  /** Minutes covered by one credit (default 20). */
  creditMinutes: number;
  plans: Record<MockPlanKey, MockPlan>;
}

// ─── Hardcoded defaults (owner-locked pricing, the "empty DB" tier) ───────────

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : fallback;
}
function envFloat(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export const CREDIT_MINUTES_DEFAULT = 20;

function buildDefaultCatalog(): MockPlanCatalog {
  return {
    creditMinutes: envInt('RA_MOCK_CREDIT_MINUTES', CREDIT_MINUTES_DEFAULT),
    plans: {
      free: {
        key: 'free',
        credits: envFloat('RA_MOCK_PLAN_FREE_CREDITS', 1),
        usdMinor: 0,
        cnyMinor: 0,
        stripePriceId: null,
      },
      starter: {
        key: 'starter',
        credits: envFloat('RA_MOCK_PLAN_STARTER_CREDITS', 10),
        usdMinor: envInt('RA_MOCK_PLAN_STARTER_USD_MINOR', 1500), // $15
        cnyMinor: envInt('RA_MOCK_PLAN_STARTER_CNY_MINOR', 1900), // ¥19
        stripePriceId: process.env.STRIPE_ROBOAPPLY_STARTER_PRICE_ID ?? null,
      },
      growth: {
        key: 'growth',
        credits: envFloat('RA_MOCK_PLAN_GROWTH_CREDITS', 28),
        usdMinor: envInt('RA_MOCK_PLAN_GROWTH_USD_MINOR', 2900), // $29
        cnyMinor: envInt('RA_MOCK_PLAN_GROWTH_CNY_MINOR', 4500), // ¥45
        stripePriceId: process.env.STRIPE_ROBOAPPLY_GROWTH_PRICE_ID ?? null,
      },
    },
  };
}

// ─── DB override blob (partial, deep-merged over defaults) ────────────────────

export interface MockPlanOverride {
  creditMinutes?: number;
  plans?: Partial<
    Record<MockPlanKey, Partial<Omit<MockPlan, 'key'>>>
  >;
}

function appConfigKey(env: ConfigEnvironment): string {
  return `mock_plans.${env}`;
}
function isDbDisabled(): boolean {
  return process.env.LLM_SETTINGS_DB_DISABLED === 'true';
}

function mergeCatalog(base: MockPlanCatalog, override: MockPlanOverride | null): MockPlanCatalog {
  if (!override) return base;
  const mergePlan = (k: MockPlanKey): MockPlan => {
    const o = override.plans?.[k] ?? {};
    return {
      key: k,
      credits: typeof o.credits === 'number' && o.credits >= 0 ? o.credits : base.plans[k].credits,
      usdMinor: typeof o.usdMinor === 'number' && o.usdMinor >= 0 ? Math.round(o.usdMinor) : base.plans[k].usdMinor,
      cnyMinor: typeof o.cnyMinor === 'number' && o.cnyMinor >= 0 ? Math.round(o.cnyMinor) : base.plans[k].cnyMinor,
      stripePriceId: o.stripePriceId !== undefined ? o.stripePriceId : base.plans[k].stripePriceId,
    };
  };
  return {
    creditMinutes:
      typeof override.creditMinutes === 'number' && override.creditMinutes > 0
        ? Math.round(override.creditMinutes)
        : base.creditMinutes,
    plans: { free: mergePlan('free'), starter: mergePlan('starter'), growth: mergePlan('growth') },
  };
}

// ─── 30s cache ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;
interface CacheEntry {
  catalog: MockPlanCatalog;
  source: 'db' | 'env';
  fetchedAt: number;
  expiresAt: number;
}
let cache: CacheEntry | null = null;

export async function getMockPlanCatalog(): Promise<MockPlanCatalog> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.catalog;
  return refresh();
}

async function refresh(): Promise<MockPlanCatalog> {
  const now = Date.now();
  const base = buildDefaultCatalog();
  if (isDbDisabled()) {
    cache = { catalog: base, source: 'env', fetchedAt: now, expiresAt: now + CACHE_TTL_MS };
    return base;
  }
  try {
    const env = getActiveEnvironment();
    const row = await prisma.appConfig.findUnique({ where: { key: appConfigKey(env) } });
    let override: MockPlanOverride | null = null;
    if (row?.value) {
      try {
        override = JSON.parse(row.value) as MockPlanOverride;
      } catch {
        override = null;
      }
    }
    const catalog = mergeCatalog(base, override);
    cache = { catalog, source: override ? 'db' : 'env', fetchedAt: now, expiresAt: now + CACHE_TTL_MS };
    return catalog;
  } catch (err) {
    logger.warn('MOCK_PLANS', 'resolve failed; degrading to env/default', {
      error: err instanceof Error ? err.message : String(err),
    });
    cache = { catalog: base, source: 'env', fetchedAt: now, expiresAt: now + CACHE_TTL_MS };
    return base;
  }
}

export function invalidateMockPlanCatalog(): void {
  cache = null;
}

export async function saveMockPlanOverride(
  blob: MockPlanOverride,
  env = getActiveEnvironment(),
): Promise<MockPlanCatalog> {
  await prisma.appConfig.upsert({
    where: { key: appConfigKey(env) },
    update: { value: JSON.stringify(blob) },
    create: { key: appConfigKey(env), value: JSON.stringify(blob) },
  });
  if (env === getActiveEnvironment()) invalidateMockPlanCatalog();
  return getMockPlanCatalog();
}

// ─── Convenience getters ──────────────────────────────────────────────────────

export async function getMockPlan(key: MockPlanKey): Promise<MockPlan> {
  const cat = await getMockPlanCatalog();
  return cat.plans[key] ?? cat.plans.free;
}

/** Reverse map a Stripe price id → plan key (for webhook reconciliation). */
export function priceIdToMockPlanKey(catalog: MockPlanCatalog, priceId: string | null | undefined): MockPlanKey | null {
  if (!priceId) return null;
  for (const k of ['starter', 'growth'] as MockPlanKey[]) {
    if (catalog.plans[k].stripePriceId === priceId) return k;
  }
  return null;
}

export function isPaidMockPlan(key: string | null | undefined): key is 'starter' | 'growth' {
  return key === 'starter' || key === 'growth';
}

// ─── Credit math (1 credit = creditMinutes minutes; round UP so we never undercharge) ─

/** Round credits up to 2 decimals (avoids float dust + never undercharges). */
export function roundCreditsUp(credits: number): number {
  if (!Number.isFinite(credits) || credits <= 0) return 0;
  return Math.ceil(credits * 100) / 100;
}

export function creditsForMinutes(minutes: number, creditMinutes = CREDIT_MINUTES_DEFAULT): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  const per = creditMinutes > 0 ? creditMinutes : CREDIT_MINUTES_DEFAULT;
  return roundCreditsUp(minutes / per);
}

export function creditsForSeconds(seconds: number, creditMinutes = CREDIT_MINUTES_DEFAULT): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const perSec = (creditMinutes > 0 ? creditMinutes : CREDIT_MINUTES_DEFAULT) * 60;
  return roundCreditsUp(seconds / perSec);
}
