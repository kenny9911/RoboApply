/**
 * subscriptionGraceConfig
 *
 * DB-backed global default for the subscription grace period — the number
 * of days a paid user keeps AI access after their `currentPeriodEnd`
 * lapses (or Stripe flips them to `past_due`) before `evaluateSubscriptionGate`
 * hard-locks them. Usage keeps counting during the window.
 *
 * Resolution precedence (per the LLM-settings / limitsConfig convention):
 *   per-user `User.subscriptionGraceDays`  →  this global default
 *   global default = AppConfig `subscription_grace_days`
 *                    ?? env SUBSCRIPTION_GRACE_DAYS
 *                    ?? DEFAULT_GRACE_DAYS (5)
 *
 * Admins edit the global default on the dedicated Subscriptions admin view
 * (PUT /api/v1/admin/subscriptions/grace-days). The per-user override is set
 * via POST /api/v1/admin/users/:id/set-billing-period.
 *
 * Cached in-memory (60s TTL) so the per-request resolvers in
 * `middleware/auth.ts`, `lib/matchBilling.ts` and `middleware/usageMeter.ts`
 * don't add a DB round-trip on the hot path. `invalidateGraceDaysCache()`
 * forces an immediate re-read after an admin save. The cache is optional —
 * an empty/failed read degrades to env/default, never throws.
 */

import prisma from './prisma.js';
import { logger } from '../services/LoggerService.js';

export const GRACE_CONFIG_KEY = 'subscription_grace_days';

/** Hard fallback when neither DB nor env provide a value. */
export const DEFAULT_GRACE_DAYS = 5;

/** Clamp range for any grace-days value (global or per-user). */
export const MIN_GRACE_DAYS = 0;
export const MAX_GRACE_DAYS = 90;

const CACHE_TTL_MS = 60_000;

let cached: { value: number; expiresAt: number } | null = null;

/** Clamp + floor an arbitrary number into the allowed grace-days range. */
export function clampGraceDays(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_GRACE_DAYS;
  return Math.min(MAX_GRACE_DAYS, Math.max(MIN_GRACE_DAYS, Math.floor(n)));
}

/** Env default, used when the DB has no override. */
function envGraceDays(): number {
  const raw = process.env.SUBSCRIPTION_GRACE_DAYS;
  if (raw == null || raw.trim() === '') return DEFAULT_GRACE_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) ? clampGraceDays(n) : DEFAULT_GRACE_DAYS;
}

/**
 * Resolve the effective GLOBAL grace-days default (DB override ?? env ??
 * built-in). Cached 60s. Never throws — DB errors degrade to env/default.
 */
export async function getGlobalGraceDays(): Promise<number> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let value = envGraceDays();
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: GRACE_CONFIG_KEY } });
    if (row && row.value != null && row.value.trim() !== '') {
      const n = Number(row.value);
      if (Number.isFinite(n)) value = clampGraceDays(n);
    }
  } catch (err) {
    logger.warn('SUBSCRIPTION_GRACE', 'Failed to read global grace days, using env/default', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/**
 * Resolve the EFFECTIVE grace days for a specific user: their per-user
 * override if set, otherwise the global default. `perUserOverride` is
 * `User.subscriptionGraceDays`.
 */
export async function resolveGraceDaysForUser(
  perUserOverride: number | null | undefined,
): Promise<number> {
  if (perUserOverride != null && Number.isFinite(perUserOverride)) {
    return clampGraceDays(perUserOverride);
  }
  return getGlobalGraceDays();
}

/** Drop the cache — call after an admin writes the global default. */
export function invalidateGraceDaysCache(): void {
  cached = null;
}

/**
 * Persist the global default grace days to AppConfig and invalidate the
 * cache. Returns the clamped value actually stored.
 */
export async function setGlobalGraceDays(days: number, adminUserId: string): Promise<number> {
  const clamped = clampGraceDays(days);
  await prisma.appConfig.upsert({
    where: { key: GRACE_CONFIG_KEY },
    create: { key: GRACE_CONFIG_KEY, value: String(clamped), updatedBy: adminUserId },
    update: { value: String(clamped), updatedBy: adminUserId },
  });
  invalidateGraceDaysCache();
  return clamped;
}
