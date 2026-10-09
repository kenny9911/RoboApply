// server/src/platform/credits/EntitlementService.ts
//
// EntitlementService.resolve(userId) (ARCHITECTURE.md §7.2). Resolution order:
//   1. the brand's credit catalog (defaults + AppConfig `credits.catalog.v1`);
//   2. the plan: the active SeekerSubscription picks the `free` or `pro`
//      column (status active|trialing and currentPeriodEnd in the future);
//   3. live RAEntitlementOverride rows (`bucket:<bucket>` → cap,
//      `entitlement:<key>` → number|boolean), newest wins, expired ignored.
//
// The result is memoized per request (keyed by request id + user, 10 s
// ceiling) so several credit checks in one request read the DB once. The
// client never computes entitlements; `/auth/me` returns `summarizeForMe()`.

import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import { getCurrentBrandOrDefault } from '../brand/brandContext.js';
import { BRANDS, parseBrandId, type BrandId, type Market } from '../brand/registry.js';
import { entitlementProfileFor, hasSellableProPlan, isLegacyPlanKey, isPlanKey, type PlanProfile } from '../billing/planCatalog.js';
import {
  ENTITLEMENT_KEYS,
  WINDOW_BUCKETS,
  getCreditCatalog,
  isEntitlementKey,
  isWindowBucket,
  MAX_OVERRIDE_CAP,
  type CreditCatalog,
  type EntitlementValues,
  type WindowBucket,
} from './catalog.js';
import { CREDIT_WINDOWS, safeTimeZone, type CreditWindow } from './windows.js';

export const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing'] as const;

export interface AccountSnapshot {
  brand: string | null;
  timezone: string | null;
  subscription: {
    tier: string | null;
    planKey: string | null;
    status: string | null;
    interval: string | null;
    currentPeriodEnd: Date | null;
  } | null;
}

export interface EntitlementOverrideRow {
  key: string;
  value: unknown;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface EntitlementSource {
  loadAccount(userId: string): Promise<AccountSnapshot | null>;
  loadOverrides(userId: string): Promise<EntitlementOverrideRow[]>;
}

export type CapSource = 'catalog' | 'override';

export interface ResolvedBucket {
  bucket: WindowBucket;
  cap: number;
  window: CreditWindow;
  grantable: boolean;
  sku: string | null;
  /** The Pro column's cap (for `upgradable`). */
  proCap: number;
  source: CapSource;
}

export interface ResolvedEntitlements {
  userId: string;
  brand: BrandId;
  market: Market;
  /** The plan key that decided the profile ('free' when there is no live paid plan). */
  planKey: string;
  planProfile: PlanProfile;
  /** True for grandfathered `starter` / `growth` subscribers. */
  legacyPlan: boolean;
  interval: string | null;
  periodEnd: Date | null;
  timezone: string;
  buckets: Record<WindowBucket, ResolvedBucket>;
  entitlements: EntitlementValues;
  /** Override keys that changed the result (for admin tooling and logs). */
  appliedOverrides: string[];
  /** A sellable Pro plan exists on this brand. */
  proSellable: boolean;
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Is the subscription a live paid plan right now? */
export function liveSubscription(sub: AccountSnapshot['subscription'], now: Date): boolean {
  if (!sub) return false;
  if (!sub.status || !(ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status)) return false;
  const end = asDate(sub.currentPeriodEnd);
  return !!end && end.getTime() > now.getTime();
}

function parseOverrideCap(value: unknown): { cap?: number; window?: CreditWindow } | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_OVERRIDE_CAP) return { cap: value };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as { cap?: unknown; window?: unknown };
    const out: { cap?: number; window?: CreditWindow } = {};
    if (typeof v.cap === 'number' && Number.isInteger(v.cap) && v.cap >= 0 && v.cap <= MAX_OVERRIDE_CAP) out.cap = v.cap;
    if (typeof v.window === 'string' && (CREDIT_WINDOWS as readonly string[]).includes(v.window)) out.window = v.window as CreditWindow;
    return out.cap !== undefined || out.window ? out : null;
  }
  return null;
}

export interface ResolveInput {
  userId: string;
  account: AccountSnapshot | null;
  overrides: EntitlementOverrideRow[];
  catalogFor: (brand: BrandId) => CreditCatalog;
  now: Date;
  /** Brand when the account has none stored (the request's brand). */
  fallbackBrand: BrandId;
  proSellable: (brand: BrandId) => boolean;
}

/** Pure resolution (catalog → plan → override). */
export function resolveEntitlementsFrom(input: ResolveInput): ResolvedEntitlements {
  const brand = parseBrandId(input.account?.brand) ?? input.fallbackBrand;
  const brandDef = BRANDS[brand];
  const catalog = input.catalogFor(brand);
  const sub = input.account?.subscription ?? null;
  const live = liveSubscription(sub, input.now);
  const planProfile: PlanProfile = live ? entitlementProfileFor({ planKey: sub?.planKey, tier: sub?.tier }) : 'free';
  const rawPlan = live ? (sub?.planKey ?? sub?.tier ?? 'free') : 'free';
  const planKey = isPlanKey(rawPlan) || isLegacyPlanKey(rawPlan) ? rawPlan : planProfile === 'pro' ? 'pro' : 'free';

  const buckets = {} as Record<WindowBucket, ResolvedBucket>;
  for (const bucket of WINDOW_BUCKETS) {
    const def = catalog.buckets[bucket];
    const col = def.caps[planProfile];
    buckets[bucket] = {
      bucket,
      cap: col.cap,
      window: col.window,
      grantable: def.grantable,
      sku: def.sku,
      proCap: def.caps.pro.cap,
      source: 'catalog',
    };
  }
  const entitlements: EntitlementValues = { ...catalog.entitlements[planProfile] };

  // Overrides: oldest first so the newest live row wins.
  const applied = new Set<string>();
  const rows = [...input.overrides].sort((a, b) => asDate(a.createdAt)!.getTime() - asDate(b.createdAt)!.getTime());
  for (const row of rows) {
    const expires = asDate(row.expiresAt);
    if (expires && expires.getTime() <= input.now.getTime()) continue;
    if (row.key.startsWith('bucket:')) {
      const bucket = row.key.slice('bucket:'.length);
      if (!isWindowBucket(bucket) || bucket === 'contact_lookup') continue; // contact lookup stays gated (D3)
      const patch = parseOverrideCap(row.value);
      if (!patch) continue;
      const cur = buckets[bucket];
      buckets[bucket] = { ...cur, cap: patch.cap ?? cur.cap, window: patch.window ?? cur.window, source: 'override' };
      applied.add(row.key);
    } else if (row.key.startsWith('entitlement:')) {
      const key = row.key.slice('entitlement:'.length);
      if (!isEntitlementKey(key)) continue;
      if (key === 'competitivenessFull') {
        if (typeof row.value !== 'boolean') continue;
        entitlements.competitivenessFull = row.value;
      } else {
        if (typeof row.value !== 'number' || !Number.isInteger(row.value) || row.value < 0 || row.value > MAX_OVERRIDE_CAP) continue;
        entitlements[key] = row.value;
      }
      applied.add(row.key);
    }
  }

  return {
    userId: input.userId,
    brand,
    market: brandDef.market,
    planKey,
    planProfile,
    legacyPlan: live && isLegacyPlanKey(rawPlan),
    interval: live ? (sub?.interval ?? null) : null,
    periodEnd: live ? asDate(sub?.currentPeriodEnd) : null,
    timezone: safeTimeZone(input.account?.timezone, brandDef.defaultTimezone),
    buckets,
    entitlements,
    appliedOverrides: [...applied],
    proSellable: input.proSellable(brand),
  };
}

// ── Prisma source ──────────────────────────────────────────────────────────

type Db = Pick<ExtendedPrismaClient, 'user' | 'rAEntitlementOverride'>;

export function createPrismaEntitlementSource(getDb: () => Promise<Db>): EntitlementSource {
  return {
    async loadAccount(userId) {
      const db = await getDb();
      const user = await db.user.findUnique({
        where: { id: userId },
        select: {
          brand: true,
          seekerProfile: {
            select: {
              timezone: true,
              subscription: { select: { tier: true, planKey: true, status: true, interval: true, currentPeriodEnd: true } },
            },
          },
        },
      });
      if (!user) return null;
      const sub = user.seekerProfile?.subscription ?? null;
      return {
        brand: user.brand ?? null,
        timezone: user.seekerProfile?.timezone ?? null,
        subscription: sub
          ? {
              tier: sub.tier ? String(sub.tier) : null,
              planKey: sub.planKey ?? null,
              status: sub.status ?? null,
              interval: sub.interval ?? null,
              currentPeriodEnd: sub.currentPeriodEnd ?? null,
            }
          : null,
      };
    },
    async loadOverrides(userId) {
      const db = await getDb();
      return db.rAEntitlementOverride.findMany({
        where: { userId, OR: [{ key: { startsWith: 'bucket:' } }, { key: { startsWith: 'entitlement:' } }] },
        select: { key: true, value: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
    },
  };
}

const defaultGetDb = async (): Promise<Db> => (await import('../../lib/prisma.js')).default;

// ── Service ────────────────────────────────────────────────────────────────

export interface EntitlementServiceDeps {
  source?: EntitlementSource;
  /** Effective catalog per brand (defaults to the AppConfig-backed loader). */
  loadCatalog?: (brand: BrandId) => Promise<CreditCatalog>;
  now?: () => Date;
  /** Whether the brand sells a Pro plan (defaults to the plan catalog over process.env). */
  proSellable?: (brand: BrandId) => boolean;
  /** Memo lifetime per request; 0 disables the memo. */
  memoTtlMs?: number;
}

export interface EntitlementService {
  resolve(userId: string, options?: { brand?: BrandId }): Promise<ResolvedEntitlements>;
  /** Drop memoized results for a user (after a plan change or override write). */
  invalidate(userId: string): void;
}

const MEMO_MAX = 500;

export function createEntitlementService(deps: EntitlementServiceDeps = {}): EntitlementService {
  const source = deps.source ?? createPrismaEntitlementSource(defaultGetDb);
  const loadCatalog = deps.loadCatalog ?? getCreditCatalog;
  const now = deps.now ?? (() => new Date());
  const proSellable = deps.proSellable ?? ((brand: BrandId) => hasSellableProPlan(brand));
  const ttl = deps.memoTtlMs ?? 10_000;
  const memo = new Map<string, { at: number; value: Promise<ResolvedEntitlements> }>();

  async function compute(userId: string, fallbackBrand: BrandId): Promise<ResolvedEntitlements> {
    const [account, overrides] = await Promise.all([source.loadAccount(userId), source.loadOverrides(userId)]);
    const brand = parseBrandId(account?.brand) ?? fallbackBrand;
    const catalog = await loadCatalog(brand);
    return resolveEntitlementsFrom({
      userId,
      account,
      overrides,
      catalogFor: () => catalog,
      now: now(),
      fallbackBrand,
      proSellable,
    });
  }

  return {
    async resolve(userId, options = {}) {
      const fallbackBrand = options.brand ?? getCurrentBrandOrDefault().id;
      const requestId = getCurrentRequestId();
      if (!ttl || !requestId) return compute(userId, fallbackBrand);
      const key = `${requestId}:${userId}:${fallbackBrand}`;
      const hit = memo.get(key);
      const t = Date.now();
      if (hit && t - hit.at < ttl) return hit.value;
      if (memo.size >= MEMO_MAX) memo.clear();
      const value = compute(userId, fallbackBrand);
      memo.set(key, { at: t, value });
      value.catch(() => memo.delete(key));
      return value;
    },
    invalidate(userId) {
      for (const key of [...memo.keys()]) if (key.includes(`:${userId}:`)) memo.delete(key);
    },
  };
}

/** The process-wide service (Prisma + AppConfig). */
export const entitlementService: EntitlementService = createEntitlementService();

export { ENTITLEMENT_KEYS };
