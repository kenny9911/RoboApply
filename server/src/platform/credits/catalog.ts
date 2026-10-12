// server/src/platform/credits/catalog.ts
//
// CREDIT_CATALOG: buckets, windows and caps per brand × plan profile
// (PRODUCT_PLAN.md §6.2 is canonical; bucket names per TASK_PLAN.md R-07 and
// §4.1.f; ARCHITECTURE.md §7.1 for the buckets PRODUCT does not list:
// `ai_answer`, `competitiveness`, `contact_lookup`). Where the market strategy
// changes a number, MARKET_STRATEGY.md §3 wins: free `autofill` is 20 a day on
// both brands (M-14).
//
// Every plan has a cap, Pro included (fair-use caps, R-07). UI copy prints the
// cap ("Up to 50 a day"), never "unlimited".
//
// Admins can change caps without a deploy: AppConfig key `credits.catalog.v1`
// holds a partial override (validated with zod, merged over the defaults,
// cached for 30 s). An invalid blob is ignored and logged; the defaults stand.
//
// `practice` is not a window bucket: practice interview credits stay in
// `mockCreditService` (see ./practice.ts).

import { z } from 'zod';
import { BRAND_IDS, type BrandId } from '../brand/registry.js';
import type { PlanProfile } from '../billing/planCatalog.js';
import type { CreditWindow } from './windows.js';
import { logger } from '../../services/LoggerService.js';

export const CREDIT_BUCKETS = [
  'fit_analysis',
  'tailor',
  'cover_letter',
  'resume_check',
  'rewrite',
  'outreach',
  'assistant',
  'autofill',
  'ai_answer',
  'job_import',
  'ready_kits',
  'competitiveness',
  'contact_lookup',
  'practice',
] as const;
export type CreditBucket = (typeof CREDIT_BUCKETS)[number];

/** Buckets metered by RACreditWindow (everything but `practice`). */
export const WINDOW_BUCKETS = CREDIT_BUCKETS.filter((b) => b !== 'practice') as Exclude<CreditBucket, 'practice'>[];
export type WindowBucket = Exclude<CreditBucket, 'practice'>;

/**
 * Feature entitlements (counts and switches, not counters). There is
 * deliberately no entitlement for the recruiter-jobs filter: it is free on
 * every plan (PRODUCT F-FEED-04, ruling C16).
 */
export const ENTITLEMENT_KEYS = ['saved_searches', 'instant_alerts', 'competitivenessFull'] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

/** Pro "as they arrive" instant alerts are stored as this daily cap (never called unlimited). */
export const INSTANT_ALERTS_AS_THEY_ARRIVE = 100;

export interface EntitlementValues {
  saved_searches: number;
  instant_alerts: number;
  competitivenessFull: boolean;
}

export interface BucketCap {
  cap: number;
  window: CreditWindow;
}

export interface BucketDefinition {
  bucket: WindowBucket;
  /** Whether RACreditGrant rows (bucket or '*') may pay for it after the window is spent. */
  grantable: boolean;
  /** Default UsageDeductionLog SKU (ARCH §7.5); callers may pass a more specific one. */
  sku: string | null;
  caps: Record<PlanProfile, BucketCap>;
}

export interface CreditCatalog {
  version: 1;
  buckets: Record<WindowBucket, BucketDefinition>;
  entitlements: Record<PlanProfile, EntitlementValues>;
}

const day = (cap: number): BucketCap => ({ cap, window: 'day' });
const week = (cap: number): BucketCap => ({ cap, window: 'week' });

function def(bucket: WindowBucket, free: BucketCap, pro: BucketCap, sku: string | null, grantable = true): BucketDefinition {
  return { bucket, grantable, sku, caps: { free, pro } };
}

function buildCatalog(brand: BrandId): CreditCatalog {
  const tailorFree = brand === 'goapply' ? 3 : 2; // PRODUCT §6.2: GoApply 免费版 tailors 3 a day
  const buckets: Record<WindowBucket, BucketDefinition> = {
    fit_analysis: def('fit_analysis', day(10), day(200), 'ra_fit_analysis'),
    tailor: def('tailor', day(tailorFree), day(50), 'ra_tailor_v2'),
    cover_letter: def('cover_letter', day(2), day(50), 'ra_cover_letter'),
    resume_check: def('resume_check', day(1), day(20), 'ra_resume_grade'),
    rewrite: def('rewrite', day(20), day(300), 'ra_resume_fix'),
    outreach: def('outreach', day(3), day(50), 'ra_outreach_draft'),
    assistant: def('assistant', day(30), day(300), 'ra_copilot_turn'),
    // MARKET_STRATEGY §3, M-14: 20 a day on both brands (a deterministic fill costs no model call).
    autofill: def('autofill', day(20), day(100), null),
    ai_answer: def('ai_answer', day(10), day(200), 'ra_ext_answer'),
    job_import: def('job_import', day(10), day(50), 'ra_job_import'),
    ready_kits: def('ready_kits', week(3), week(30), null),
    // ARCH §7.1: free 1 a week; Pro 3 a day.
    competitiveness: def('competitiveness', week(1), day(3), 'ra_competitiveness'),
    // Gated until a licensed provider exists (D3); grants never unlock it.
    contact_lookup: def('contact_lookup', day(0), day(0), null, false),
  };
  return {
    version: 1,
    buckets,
    entitlements: {
      free: { saved_searches: 1, instant_alerts: 1, competitivenessFull: false },
      pro: { saved_searches: 10, instant_alerts: INSTANT_ALERTS_AS_THEY_ARRIVE, competitivenessFull: true },
    },
  };
}

/** Defaults per brand (PRODUCT §6.2). Frozen copies; never mutate. */
export const DEFAULT_CREDIT_CATALOG: Record<BrandId, CreditCatalog> = {
  roboapply: buildCatalog('roboapply'),
  goapply: buildCatalog('goapply'),
};

export function isWindowBucket(value: unknown): value is WindowBucket {
  return typeof value === 'string' && (WINDOW_BUCKETS as readonly string[]).includes(value);
}

export function isCreditBucket(value: unknown): value is CreditBucket {
  return typeof value === 'string' && (CREDIT_BUCKETS as readonly string[]).includes(value);
}

export function isEntitlementKey(value: unknown): value is EntitlementKey {
  return typeof value === 'string' && (ENTITLEMENT_KEYS as readonly string[]).includes(value);
}

// ── AppConfig override (`credits.catalog.v1`) ─────────────────────────────

export const CREDIT_CATALOG_CONFIG_KEY = 'credits.catalog.v1';

/** Largest cap an override may set; keeps a typo from turning a cap into "unlimited". */
export const MAX_OVERRIDE_CAP = 10_000;

const CapPatchSchema = z
  .object({
    cap: z.number().int().min(0).max(MAX_OVERRIDE_CAP).optional(),
    window: z.enum(['day', 'week', 'month']).optional(),
  })
  .strict();

const BucketPatchSchema = z
  .object({ free: CapPatchSchema.optional(), pro: CapPatchSchema.optional(), grantable: z.boolean().optional() })
  .strict();

const EntitlementPatchSchema = z
  .object({
    saved_searches: z.number().int().min(0).max(100).optional(),
    instant_alerts: z.number().int().min(0).max(INSTANT_ALERTS_AS_THEY_ARRIVE).optional(),
    competitivenessFull: z.boolean().optional(),
  })
  .strict();

const BrandPatchSchema = z
  .object({
    buckets: z.partialRecord(z.enum(WINDOW_BUCKETS as [WindowBucket, ...WindowBucket[]]), BucketPatchSchema).optional(),
    entitlements: z.object({ free: EntitlementPatchSchema.optional(), pro: EntitlementPatchSchema.optional() }).strict().optional(),
  })
  .strict();

export const CreditCatalogOverrideSchema = z
  .object({
    version: z.literal(1).optional(),
    brands: z.partialRecord(z.enum(BRAND_IDS as [BrandId, ...BrandId[]]), BrandPatchSchema).optional(),
  })
  .strict();

export type CreditCatalogOverride = z.infer<typeof CreditCatalogOverrideSchema>;

/** Merge a validated override over a brand's defaults (pure; returns a new catalog). */
export function mergeCreditCatalog(base: CreditCatalog, patch: z.infer<typeof BrandPatchSchema> | undefined): CreditCatalog {
  const buckets = {} as Record<WindowBucket, BucketDefinition>;
  for (const bucket of WINDOW_BUCKETS) {
    const b = base.buckets[bucket];
    const p = patch?.buckets?.[bucket];
    buckets[bucket] = {
      bucket,
      // contact_lookup stays non-grantable whatever the override says (D3 gate).
      grantable: bucket === 'contact_lookup' ? false : (p?.grantable ?? b.grantable),
      sku: b.sku,
      caps: {
        free: { cap: p?.free?.cap ?? b.caps.free.cap, window: p?.free?.window ?? b.caps.free.window },
        pro: { cap: p?.pro?.cap ?? b.caps.pro.cap, window: p?.pro?.window ?? b.caps.pro.window },
      },
    };
  }
  return {
    version: 1,
    buckets,
    entitlements: {
      free: { ...base.entitlements.free, ...(patch?.entitlements?.free ?? {}) },
      pro: { ...base.entitlements.pro, ...(patch?.entitlements?.pro ?? {}) },
    },
  };
}

/** Parse the AppConfig string. Returns null (and the reason) when absent or invalid. */
export function parseCreditCatalogOverride(raw: string | null | undefined): { override: CreditCatalogOverride | null; error: string | null } {
  if (!raw || !raw.trim()) return { override: null, error: null };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { override: null, error: 'invalid_json' };
  }
  const parsed = CreditCatalogOverrideSchema.safeParse(json);
  if (!parsed.success) return { override: null, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { override: parsed.data, error: null };
}

/** The effective catalog for a brand given an (optional) override. */
export function catalogFor(brand: BrandId, override: CreditCatalogOverride | null): CreditCatalog {
  return mergeCreditCatalog(DEFAULT_CREDIT_CATALOG[brand], override?.brands?.[brand]);
}

// ── Loader with a 30 s cache ───────────────────────────────────────────────

export type CreditCatalogConfigLoader = () => Promise<string | null>;

const defaultConfigLoader: CreditCatalogConfigLoader = async () => {
  if (process.env.CREDITS_CATALOG_DB_DISABLED === 'true') return null;
  const { default: prisma } = await import('../../lib/prisma.js');
  const row = await prisma.appConfig.findUnique({ where: { key: CREDIT_CATALOG_CONFIG_KEY }, select: { value: true } });
  return row?.value ?? null;
};

let configLoader: CreditCatalogConfigLoader = defaultConfigLoader;
const CACHE_TTL_MS = 30_000;
let cache: { override: CreditCatalogOverride | null; expiresAt: number } | null = null;

/** Test seam: replace the AppConfig reader (null restores the Prisma one). Clears the cache. */
export function setCreditCatalogConfigLoader(loader: CreditCatalogConfigLoader | null): void {
  configLoader = loader ?? defaultConfigLoader;
  cache = null;
}

export function invalidateCreditCatalog(): void {
  cache = null;
}

async function loadOverride(): Promise<CreditCatalogOverride | null> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.override;
  let override: CreditCatalogOverride | null = null;
  try {
    const parsed = parseCreditCatalogOverride(await configLoader());
    if (parsed.error) logger.warn('CREDITS', 'credits.catalog.v1 ignored (invalid)', { error: parsed.error });
    override = parsed.override;
  } catch (err) {
    // A failed lookup degrades to the defaults; never block a request on it.
    override = null;
    logger.warn('CREDITS', 'credits.catalog.v1 lookup failed; using defaults', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  cache = { override, expiresAt: now + CACHE_TTL_MS };
  return override;
}

/** The effective catalog for a brand (defaults + AppConfig override). Never throws. */
export async function getCreditCatalog(brand: BrandId): Promise<CreditCatalog> {
  return catalogFor(brand, await loadOverride());
}
