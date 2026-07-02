// backend/src/lib/rateCard.ts
//
// Unified RATE CARD resolver — the single home for every per-unit cost rate the
// platform uses to compute "cost to serve", PLUS the RoboApply subscription
// tier prices (the revenue side of profitability).
//
// Precedence per field: AppConfig['rate_card.{env}'] (DB override) ?? env ??
// hardcoded default. The hardcoded LLM tier RE-EXPORTS lib/modelPricing.ts so
// an empty DB resolves byte-for-byte to the existing constants (the same
// "empty DB == env == default" invariant the LLM-settings stack enforces).
//
// Covers:
//   • llm        — per-1M-token input/output rates (default = MODEL_PRICING)
//   • stt        — USD per minute of speech-to-text audio
//   • tts        — USD per 1M characters (preferred) / per minute (fallback)
//   • egress     — USD per GB for recording egress (R2 / LiveKit)
//   • storage    — USD per GB-month for stored interview artifacts
//   • tiers      — RoboApply free/premium/premium_plus monthly price + daily cap
//
// This is read-mostly: the admin rate-card panel reads it; an admin PATCH can
// upsert the DB blob (Phase 2). Cost CAPTURE for LLM tokens stays on the
// synchronous modelPricing path (logLLMCall); the rate card's LLM rates feed
// the admin display + async recompute paths (interview sessionCost). STT/TTS/
// egress/tier rates are the rate card's primary live job.
//
// Never throws: a cold cache or DB error degrades to env/default.

import prisma from './prisma.js';
import { logger } from '../services/LoggerService.js';
import { MODEL_PRICING } from './modelPricing.js';
import { getActiveEnvironment, type ConfigEnvironment } from './llm/llmStackConfigSchema.js';

export type RoboApplyTierKey = 'free' | 'premium' | 'premium_plus' | 'starter' | 'growth';

export interface RateCard {
  /** Per-1M-token rates by model id. Default = MODEL_PRICING (modelPricing.ts). */
  llm: Record<string, { input: number; output: number }>;
  llmDefault: { input: number; output: number };
  /** USD per minute of STT audio. `default` applies unless a model substring matches. */
  stt: { default: number; byModelSubstring: Record<string, number> };
  /** USD per 1M characters (preferred) and USD per minute (fallback) of TTS audio. */
  tts: { usdPer1MChars: number; usdPerMin: number };
  /** USD per GB of recording egress (download from R2 / LiveKit egress). */
  egress: { usdPerGb: number };
  /** USD per GB-month of stored interview artifacts (transcript + report + recording). */
  storage: { usdPerGbMonth: number };
  /** RoboApply subscription tiers — monthly price + daily application cap. */
  tiers: Record<RoboApplyTierKey, { priceUsdMonthly: number; dailyCap: number; stripePriceId: string | null }>;
}

// ─── Hardcoded defaults (the "empty DB" tier) ─────────────────────────────────

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Tier price + daily cap defaults — de-duplicates the constants previously
 *  hardcoded in roboapply/routes/settings.ts and RoboApplyMissionService.ts. */
const TIER_DEFAULTS: Record<RoboApplyTierKey, { priceUsdMonthly: number; dailyCap: number }> = {
  free: { priceUsdMonthly: 0, dailyCap: 3 },
  premium: { priceUsdMonthly: 19, dailyCap: 15 },
  premium_plus: { priceUsdMonthly: 49, dailyCap: 30 },
  // Mock-interview subscription plans (canonical pricing lives in
  // mockInterviewPlans.ts; dailyCap here only governs legacy auto-apply so
  // starter/growth don't fall through to the free default).
  starter: { priceUsdMonthly: 15, dailyCap: 15 },
  growth: { priceUsdMonthly: 29, dailyCap: 30 },
};

function buildDefaultRateCard(): RateCard {
  return {
    llm: MODEL_PRICING,
    llmDefault: MODEL_PRICING.default ?? { input: 1.0, output: 3.0 },
    stt: {
      // Default ≈ Deepgram Nova streaming list price. Env-overridable so the
      // pricing plan can tune without a redeploy. Mirrors the historical
      // sessionCost.ts placeholder.
      default: envNum('INTERVIEW_STT_USD_PER_MIN', 0.0077),
      byModelSubstring: {
        'nova-3': envNum('INTERVIEW_STT_USD_PER_MIN', 0.0077),
        'nova-2': envNum('INTERVIEW_STT_USD_PER_MIN_NOVA2', 0.0058),
      },
    },
    tts: {
      usdPer1MChars: envNum('INTERVIEW_TTS_USD_PER_1M_CHARS', 30),
      usdPerMin: envNum('INTERVIEW_TTS_USD_PER_MIN', 0.18),
    },
    // Default 0 → recording/egress cost stays $0 until a rate is configured
    // (no silent change to historical interview totals).
    egress: { usdPerGb: envNum('RA_EGRESS_USD_PER_GB', 0) },
    storage: { usdPerGbMonth: envNum('RA_STORAGE_USD_PER_GB_MONTH', 0) },
    tiers: {
      free: {
        ...TIER_DEFAULTS.free,
        stripePriceId: process.env.STRIPE_ROBOAPPLY_FREE_PRICE_ID ?? null,
      },
      premium: {
        ...TIER_DEFAULTS.premium,
        stripePriceId: process.env.STRIPE_ROBOAPPLY_PREMIUM_PRICE_ID ?? null,
      },
      premium_plus: {
        ...TIER_DEFAULTS.premium_plus,
        stripePriceId: process.env.STRIPE_ROBOAPPLY_PREMIUM_PLUS_PRICE_ID ?? null,
      },
      starter: {
        ...TIER_DEFAULTS.starter,
        stripePriceId: process.env.STRIPE_ROBOAPPLY_STARTER_PRICE_ID ?? null,
      },
      growth: {
        ...TIER_DEFAULTS.growth,
        stripePriceId: process.env.STRIPE_ROBOAPPLY_GROWTH_PRICE_ID ?? null,
      },
    },
  };
}

// ─── DB override blob (partial, deep-merged over defaults) ────────────────────

/** Shape of AppConfig['rate_card.{env}'].value (JSON). All fields optional. */
export interface RateCardOverride {
  llm?: Record<string, { input: number; output: number }>;
  stt?: { default?: number; byModelSubstring?: Record<string, number> };
  tts?: { usdPer1MChars?: number; usdPerMin?: number };
  egress?: { usdPerGb?: number };
  storage?: { usdPerGbMonth?: number };
  tiers?: Partial<Record<RoboApplyTierKey, { priceUsdMonthly?: number; dailyCap?: number; stripePriceId?: string | null }>>;
}

function appConfigKey(env: ConfigEnvironment): string {
  return `rate_card.${env}`;
}

function isDbDisabled(): boolean {
  return process.env.LLM_SETTINGS_DB_DISABLED === 'true';
}

function mergeRateCard(base: RateCard, override: RateCardOverride | null): RateCard {
  if (!override) return base;
  const merged: RateCard = {
    llm: { ...base.llm, ...(override.llm ?? {}) },
    llmDefault: base.llmDefault,
    stt: {
      default: override.stt?.default ?? base.stt.default,
      byModelSubstring: { ...base.stt.byModelSubstring, ...(override.stt?.byModelSubstring ?? {}) },
    },
    tts: {
      usdPer1MChars: override.tts?.usdPer1MChars ?? base.tts.usdPer1MChars,
      usdPerMin: override.tts?.usdPerMin ?? base.tts.usdPerMin,
    },
    egress: { usdPerGb: override.egress?.usdPerGb ?? base.egress.usdPerGb },
    storage: { usdPerGbMonth: override.storage?.usdPerGbMonth ?? base.storage.usdPerGbMonth },
    tiers: {
      free: { ...base.tiers.free, ...(override.tiers?.free ?? {}) },
      premium: { ...base.tiers.premium, ...(override.tiers?.premium ?? {}) },
      premium_plus: { ...base.tiers.premium_plus, ...(override.tiers?.premium_plus ?? {}) },
      starter: { ...base.tiers.starter, ...(override.tiers?.starter ?? {}) },
      growth: { ...base.tiers.growth, ...(override.tiers?.growth ?? {}) },
    },
  };
  return merged;
}

// ─── 30s cache ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;
const STALE_TTL_MS = 10_000;

interface CacheEntry {
  card: RateCard;
  source: 'db' | 'env';
  fetchedAt: number;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

/** Resolve the active rate card (DB override ?? env ?? default), cached 30s. */
export async function getRateCard(): Promise<RateCard> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    // Background refresh if within the staleness window (keeps reads non-blocking).
    if (cache.expiresAt - now < CACHE_TTL_MS - STALE_TTL_MS) void refresh().catch(() => {});
    return cache.card;
  }
  return refresh();
}

async function refresh(): Promise<RateCard> {
  const now = Date.now();
  const base = buildDefaultRateCard();
  if (isDbDisabled()) {
    cache = { card: base, source: 'env', fetchedAt: now, expiresAt: now + CACHE_TTL_MS };
    return base;
  }
  try {
    const env = getActiveEnvironment();
    const row = await prisma.appConfig.findUnique({ where: { key: appConfigKey(env) } });
    let override: RateCardOverride | null = null;
    if (row?.value) {
      try {
        override = JSON.parse(row.value) as RateCardOverride;
      } catch {
        override = null;
      }
    }
    const card = mergeRateCard(base, override);
    cache = { card, source: override ? 'db' : 'env', fetchedAt: now, expiresAt: now + CACHE_TTL_MS };
    return card;
  } catch (err) {
    logger.warn('RATE_CARD', 'resolve failed; degrading to env/default', {
      error: err instanceof Error ? err.message : String(err),
    });
    cache = { card: base, source: 'env', fetchedAt: now, expiresAt: now + STALE_TTL_MS };
    return base;
  }
}

export function invalidateRateCard(): void {
  cache = null;
}

export async function warmupRateCard(): Promise<void> {
  try {
    await getRateCard();
  } catch {
    /* best-effort */
  }
}

/** Resolved card + source flag, for the admin rate-card panel. */
export async function getRateCardWithSource(): Promise<{ card: RateCard; source: 'db' | 'env'; cacheAgeMs: number | null }> {
  const card = await getRateCard();
  return { card, source: cache?.source ?? 'env', cacheAgeMs: cache ? Date.now() - cache.fetchedAt : null };
}

/** Persist a rate-card override blob + invalidate cache. Audit is written by
 *  the caller (admin route) via AdminAdjustment. Returns the resolved card. */
export async function saveRateCardOverride(blob: RateCardOverride, env = getActiveEnvironment()): Promise<RateCard> {
  await prisma.appConfig.upsert({
    where: { key: appConfigKey(env) },
    update: { value: JSON.stringify(blob) },
    create: { key: appConfigKey(env), value: JSON.stringify(blob) },
  });
  if (env === getActiveEnvironment()) invalidateRateCard();
  return getRateCard();
}

// ─── Convenience getters (used by sessionCost + analytics) ────────────────────

export function sttUsdPerMinuteFrom(card: RateCard, model: string): number {
  const m = (model || '').toLowerCase();
  for (const [sub, rate] of Object.entries(card.stt.byModelSubstring)) {
    if (m.includes(sub)) return rate;
  }
  return card.stt.default;
}

export function tierPriceUsd(card: RateCard, tier: string): number {
  return card.tiers[(tier as RoboApplyTierKey)]?.priceUsdMonthly ?? 0;
}

export function tierDailyCap(card: RateCard, tier: string): number {
  return card.tiers[(tier as RoboApplyTierKey)]?.dailyCap ?? TIER_DEFAULTS.free.dailyCap;
}

/** Reverse map a Stripe price id → tier key (for webhook reconciliation). */
export function priceIdToTier(card: RateCard, priceId: string | null | undefined): RoboApplyTierKey | null {
  if (!priceId) return null;
  for (const t of ['free', 'premium', 'premium_plus', 'starter', 'growth'] as RoboApplyTierKey[]) {
    if (card.tiers[t].stripePriceId === priceId) return t;
  }
  return null;
}
