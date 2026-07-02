import type { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma.js';
import * as OverageBilling from '../services/OverageBillingService.js';
import { formatMoney, type Currency, type PayPerUseSku } from '../services/CurrencyService.js';
import { writeDeductionLog, type DeductionSku } from '../lib/matchBilling.js';
import { evaluateSubscriptionGate } from '../lib/subscriptionGate.js';
import { resolveGraceDaysForUser } from '../lib/subscriptionGraceConfig.js';

// ---------------------------------------------------------------------------
// Feature flag — multi-currency overage billing
// ---------------------------------------------------------------------------
// Default is ON: single-unit quota overflow routes through the new
// OverageBillingService (ledger + market-currency debit from
// topUpBalanceMinor). This is now the canonical pricing path — per-market
// rates displayed on the Pricing page must be what gets charged.
//
// Set `OVERAGE_ENABLED=false` to fall back to the legacy USD-topUpBalance
// path. Kept as an opt-out safety valve for emergency rollback; not
// recommended for steady-state because it charges USD regardless of the
// user's market, causing price mismatch with the display.
//
// `OVERAGE_SHADOW=true` is an obsolete pre-launch verification mode —
// writes a ledger row on the legacy path without debiting. Retained for
// completeness; new deployments should not rely on it.
function isOverageEnabled(): boolean {
  return (process.env.OVERAGE_ENABLED ?? '').toLowerCase() !== 'false';
}
function isOverageShadow(): boolean {
  return (process.env.OVERAGE_SHADOW ?? '').toLowerCase() === 'true';
}

/**
 * Grace-aware subscription lock check shared by the interview/match quota
 * gates below. Returns true only when the user is locked BEYOND the grace
 * window — a lapsed/past-due paid user inside the grace window is NOT locked
 * and keeps consuming (usage counts). Mirrors lib/matchBilling.ts so Layer A
 * (route middleware) and Layer B (quota) agree on the grace boundary.
 */
async function isSubscriptionLockedForQuota(u: {
  subscriptionTier?: string | null;
  subscriptionStatus?: string | null;
  currentPeriodEnd?: Date | null;
  subscriptionGraceDays?: number | null;
  role?: string | null;
}): Promise<boolean> {
  const gate = evaluateSubscriptionGate({
    subscriptionTier: u.subscriptionTier ?? null,
    subscriptionStatus: u.subscriptionStatus ?? null,
    currentPeriodEnd: u.currentPeriodEnd ?? null,
    isActive: true,
    role: u.role ?? null,
    graceDays: await resolveGraceDaysForUser(u.subscriptionGraceDays ?? null),
  });
  return gate.locked;
}

type UsageLimitAwareUser = {
  subscriptionTier?: string | null;
  customMaxInterviews?: number | null;
  customMaxMatches?: number | null;
};

export interface UsageLimitSnapshot {
  planMaxInterviews: number | null;
  planMaxMatches: number | null;
  effectiveMaxInterviews: number | null;
  effectiveMaxMatches: number | null;
}

/**
 * Default plan limits (fallback when no DB config exists).
 */
const DEFAULT_PLAN_LIMITS: Record<string, { interviews: number; matches: number }> = {
  free: { interviews: 2, matches: 10 },
  starter: { interviews: 15, matches: 30 },
  growth: { interviews: 120, matches: 1000 },
  business: { interviews: 300, matches: 3000 },
  custom: { interviews: Infinity, matches: Infinity },
};

/**
 * Default storage quotas per tier (BigInt bytes). null = unlimited.
 *
 * Locked by the File Vault PRD (see docs/prd-file-vault.md):
 *   Free      25 MB
 *   Starter  500 MB
 *   Growth     5 GB
 *   Business  20 GB
 *   Custom unlimited
 *
 * Admin can override per-tier via AppConfig keys `storage_limit_{tier}`
 * (value is a string of bytes, parsed as BigInt). Per-user override lives
 * on `User.customMaxStorageBytes`.
 */
const STORAGE_PLAN_LIMITS: Record<string, bigint | null> = {
  free:     25n * 1024n * 1024n,            // 25 MiB
  starter:  500n * 1024n * 1024n,           // 500 MiB
  growth:   5n * 1024n * 1024n * 1024n,     // 5 GiB
  business: 20n * 1024n * 1024n * 1024n,    // 20 GiB
  custom:   null,                            // unlimited
};

/** Default pay-per-use prices in USD. Kept aligned with the
 *  multi-currency OverageRate seed (backend/src/services/
 *  OverageBillingService.ts SEED_RATES → market='other').
 *  Only consulted by the legacy path when OVERAGE_ENABLED is
 *  explicitly disabled — new default is the market-aware overage
 *  billing service. */
const DEFAULT_PAY_PER_USE = {
  interview: 2.0, // $2.00 per interview
  match: 0.2, // $0.20 per résumé match (matches PRD §5.1)
};

// ---------------------------------------------------------------------------
// In-memory cache for DB-backed config (5-minute TTL)
// ---------------------------------------------------------------------------
let cachedLimits: Record<string, { interviews: number; matches: number }> | null = null;
let cachedPayPerUse: { interview: number; match: number } | null = null;
let cachedStorageLimits: Record<string, bigint | null> | null = null;
let cacheTimestamp = 0;
let storageCacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Clear the in-memory cache (called after admin updates limits). */
export function clearLimitsCache(): void {
  cachedLimits = null;
  cachedPayPerUse = null;
  cachedStorageLimits = null;
  cacheTimestamp = 0;
  storageCacheTimestamp = 0;
}

async function loadConfigFromDb(): Promise<void> {
  if (cachedLimits && cachedPayPerUse && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return; // cache still fresh
  }

  try {
    const rows = await prisma.appConfig.findMany({
      where: {
        key: { startsWith: 'limit_' },
      },
    });
    const ppuRows = await prisma.appConfig.findMany({
      where: {
        key: { startsWith: 'payperuse_' },
      },
    });

    // Build limits from DB rows, merging with defaults
    const limits: Record<string, { interviews: number; matches: number }> = {};
    for (const [tier, defaults] of Object.entries(DEFAULT_PLAN_LIMITS)) {
      limits[tier] = { ...defaults };
    }
    for (const row of rows) {
      // key format: limit_{tier}_{action}  e.g. limit_starter_interviews
      const match = row.key.match(/^limit_(\w+)_(interviews|matches)$/);
      if (match) {
        const tier = match[1];
        const action = match[2] as 'interviews' | 'matches';
        const val = Number(row.value);
        if (limits[tier] && Number.isFinite(val) && val >= 0) {
          limits[tier][action] = val;
        }
      }
    }
    // custom tier is always unlimited
    limits.custom = { interviews: Infinity, matches: Infinity };

    // Build pay-per-use from DB
    const ppu = { ...DEFAULT_PAY_PER_USE };
    for (const row of ppuRows) {
      if (row.key === 'payperuse_interview') {
        const val = Number(row.value);
        if (Number.isFinite(val) && val > 0) ppu.interview = val;
      }
      if (row.key === 'payperuse_match') {
        const val = Number(row.value);
        if (Number.isFinite(val) && val > 0) ppu.match = val;
      }
    }

    cachedLimits = limits;
    cachedPayPerUse = ppu;
    cacheTimestamp = Date.now();
  } catch {
    // On DB error, fall back to defaults
    cachedLimits = { ...DEFAULT_PLAN_LIMITS };
    cachedPayPerUse = { ...DEFAULT_PAY_PER_USE };
    cacheTimestamp = Date.now();
  }
}

/** Get plan limits (DB-backed with fallback). */
export async function getPlanLimits(): Promise<Record<string, { interviews: number; matches: number }>> {
  await loadConfigFromDb();
  return cachedLimits!;
}

/** Get pay-per-use rates (DB-backed with fallback). */
export async function getPayPerUseRates(): Promise<{ interview: number; match: number }> {
  await loadConfigFromDb();
  return cachedPayPerUse!;
}

/**
 * Storage tier defaults loader. Reads AppConfig rows keyed
 * `storage_limit_{tier}` whose value is a stringified byte count, falls
 * back to STORAGE_PLAN_LIMITS for missing tiers. The `custom` tier is
 * always unlimited (null) — admin can't downgrade that.
 *
 * Cached 5 min in-memory like the interview/match limits; cleared on
 * admin update via `clearLimitsCache()`.
 */
async function loadStorageLimitsFromDb(): Promise<void> {
  if (cachedStorageLimits && Date.now() - storageCacheTimestamp < CACHE_TTL_MS) return;
  try {
    const rows = await prisma.appConfig.findMany({
      where: { key: { startsWith: 'storage_limit_' } },
    });
    const out: Record<string, bigint | null> = {};
    for (const [tier, defaultBytes] of Object.entries(STORAGE_PLAN_LIMITS)) {
      out[tier] = defaultBytes;
    }
    for (const row of rows) {
      const m = row.key.match(/^storage_limit_(\w+)$/);
      if (!m) continue;
      const tier = m[1];
      // value is a decimal string of bytes; "0" or empty = use default; "-1" = unlimited
      const trimmed = (row.value || '').trim();
      if (!trimmed) continue;
      if (trimmed === '-1') {
        out[tier] = null;
        continue;
      }
      try {
        const bn = BigInt(trimmed);
        if (bn >= 0n) out[tier] = bn;
      } catch {
        // ignore malformed value, keep default
      }
    }
    out.custom = null; // custom is always unlimited
    cachedStorageLimits = out;
    storageCacheTimestamp = Date.now();
  } catch {
    cachedStorageLimits = { ...STORAGE_PLAN_LIMITS };
    storageCacheTimestamp = Date.now();
  }
}

/** Get storage tier defaults (DB-backed with fallback). null = unlimited. */
export async function getStoragePlanLimits(): Promise<Record<string, bigint | null>> {
  await loadStorageLimitsFromDb();
  return cachedStorageLimits!;
}

/** Default tier values, exposed for admin config UI seeding. */
export function getStoragePlanLimitsDefaults(): Record<string, bigint | null> {
  return { ...STORAGE_PLAN_LIMITS };
}

function serializeLimit(limit: number): number | null {
  return Number.isFinite(limit) ? limit : null;
}

export function resolveUserUsageLimitsFromPlan(
  user: UsageLimitAwareUser,
  planLimits: Record<string, { interviews: number; matches: number }>
): UsageLimitSnapshot {
  const tier = (user.subscriptionTier || 'free').toLowerCase();
  const limits = planLimits[tier] || planLimits.free;
  const planMaxInterviews = serializeLimit(limits.interviews);
  const planMaxMatches = serializeLimit(limits.matches);

  return {
    planMaxInterviews,
    planMaxMatches,
    effectiveMaxInterviews: user.customMaxInterviews ?? planMaxInterviews,
    effectiveMaxMatches: user.customMaxMatches ?? planMaxMatches,
  };
}

export async function resolveUserUsageLimits(user: UsageLimitAwareUser): Promise<UsageLimitSnapshot> {
  const planLimits = await getPlanLimits();
  return resolveUserUsageLimitsFromPlan(user, planLimits);
}

export async function withUserUsageLimits<T extends UsageLimitAwareUser>(
  user: T
): Promise<T & UsageLimitSnapshot> {
  return {
    ...user,
    ...(await resolveUserUsageLimits(user)),
  };
}

type BillableAction = 'interview' | 'match';

function isBillableEndpointForAction(action: BillableAction, path: string): boolean {
  const normalized = path.toLowerCase();

  if (action === 'match') {
    return normalized.endsWith('/match-resume');
  }

  if (action === 'interview') {
    return normalized.endsWith('/invite-candidate') || normalized.endsWith('/batch-invite');
  }

  return false;
}

/**
 * Middleware factory that checks usage limits and handles billing
 * before allowing a billable API call to proceed.
 *
 * Logic:
 * 1. Check if user's plan has remaining quota for this action
 * 2. If within plan limits → allow and increment counter
 * 3. If over plan limits → check topUpBalance, deduct pay-per-use fee, allow
 * 4. If no balance → reject with 402 Payment Required
 *
 * @deprecated for the `match` SKU. Use `runMatchWithQuota` (or
 * `gateMatchUsage` + `commitMatchUsage`) from `lib/matchBilling.ts`.
 * The `interview` SKU still uses this middleware.
 */
export function checkUsageLimit(action: BillableAction) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (action === 'match' && process.env.NODE_ENV !== 'production') {
        console.warn(
          '[matchBilling] checkUsageLimit middleware was called for the match SKU — this is the deprecated pre-pay path. ' +
          'Use runMatchWithQuota from lib/matchBilling.js. See docs/prd-resume-match-quota-rule.md.',
        );
      }
      // Safety guard: only bill explicitly billable endpoints for the given action.
      // This prevents accidental quota deduction if middleware is attached to free endpoints.
      if (!isBillableEndpointForAction(action, req.path)) {
        (req as any).usageBilling = { source: 'free', action, cost: 0 };
        next();
        return;
      }

      const user = req.user;
      if (!user) {
        res.status(401).json({ success: false, error: 'Authentication required', code: 'AUTH_REQUIRED' });
        return;
      }

      // Fetch fresh user data from DB for accurate counters
      const freshUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: {
          subscriptionTier: true,
          subscriptionStatus: true,
          interviewsUsed: true,
          resumeMatchesUsed: true,
          topUpBalance: true,
          currentPeriodEnd: true,
          subscriptionGraceDays: true,
          role: true,
          customMaxInterviews: true,
          customMaxMatches: true,
        },
      });

      if (!freshUser) {
        res.status(401).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      const tier = freshUser.subscriptionTier || 'free';
      const planLimits = await getPlanLimits();
      const payPerUse = await getPayPerUseRates();
      const limits = planLimits[tier] || planLimits.free;

      // Grace-aware subscription check: in-grace (past-due within window)
      // users keep consuming — only lock once the grace window closes, and
      // even then allow spending top-up balance.
      if ((await isSubscriptionLockedForQuota(freshUser)) && freshUser.topUpBalance <= 0) {
        res.status(402).json({
          success: false,
          error: 'Your subscription is inactive. Please update your payment method or top up your balance.',
          code: 'SUBSCRIPTION_INACTIVE',
        });
        return;
      }

      const usedField = action === 'interview' ? 'interviewsUsed' : 'resumeMatchesUsed';
      const used = action === 'interview' ? freshUser.interviewsUsed : freshUser.resumeMatchesUsed;
      // Per-user admin override takes precedence over plan defaults
      const limit = action === 'interview'
        ? (freshUser.customMaxInterviews ?? limits.interviews)
        : (freshUser.customMaxMatches ?? limits.matches);
      const price = action === 'interview' ? payPerUse.interview : payPerUse.match;

      if (used < limit) {
        // Within plan limits — increment counter
        await prisma.user.update({
          where: { id: user.id },
          data: { [usedField]: { increment: 1 } },
        });
        // Append-only audit row. UsageDeductionLog is the source of
        // truth for "did this user actually pay?". See
        // docs/prd-resume-match-quota-rule.md.
        if (action === 'interview') {
          await writeDeductionLog({
            userId: user.id,
            apiKeyId: req.apiKeyId ?? null,
            sku: 'interview',
            source: 'plan',
            tierAtCommit: tier,
            usedBefore: used,
            usedAfter: used + 1,
            limitAtCommit: Number.isFinite(limit) ? limit : null,
            requestId: req.requestId ?? null,
            relatedEntityType: 'api',
            relatedEntityId: req.path,
            metadata: { endpoint: req.path, source: 'checkUsageLimit_middleware' },
          });
        }
        // Tag the request so downstream knows it was plan-included
        (req as any).usageBilling = { source: 'plan', action, cost: 0 };
        next();
        return;
      }

      // Over plan limits — overage charging.
      //
      // When OVERAGE_ENABLED=true, we delegate to OverageBillingService
      // which handles market-currency debit from topUpBalanceMinor,
      // writes a ledger row, and respects per-user overage preferences
      // (enabled flag, monthly cap, per-user rate override). We still
      // increment the legacy counter here so analytics queries that
      // read `interviewsUsed` / `resumeMatchesUsed` keep working.
      //
      // When OVERAGE_ENABLED=false (default), the legacy USD debit from
      // `topUpBalance` continues as-is so existing users aren't affected
      // during rollout. OVERAGE_SHADOW=true writes a ledger row on the
      // legacy path too — useful to verify counts match before go-live.
      if (isOverageEnabled()) {
        const sku: PayPerUseSku = action === 'interview' ? 'interview' : 'resume_match';
        const requestId = req.requestId ?? null;
        const result = await OverageBilling.charge({ userId: user.id, sku, requestId });
        if (result.charged) {
          await prisma.user.update({
            where: { id: user.id },
            data: { [usedField]: { increment: 1 } },
          });
          if (action === 'interview') {
            await writeDeductionLog({
              userId: user.id,
              apiKeyId: req.apiKeyId ?? null,
              sku: 'interview',
              source: 'overage',
              tierAtCommit: tier,
              usedBefore: used,
              usedAfter: used + 1,
              limitAtCommit: Number.isFinite(limit) ? limit : null,
              costMinor: result.amountMinor ?? null,
              currency: (result.currency ?? null) as string | null,
              overageChargeId: result.chargeId ?? null,
              requestId,
              relatedEntityType: 'api',
              relatedEntityId: req.path,
              metadata: { endpoint: req.path, source: 'checkUsageLimit_middleware_overage' },
            });
          }
          (req as any).usageBilling = {
            source: 'overage',
            action,
            cost: result.amountMinor ?? 0,
            currency: result.currency ?? 'USD',
            chargeId: result.chargeId,
          };
          next();
          return;
        }
        // Blocked by overage system (disabled flag, insufficient balance,
        // monthly cap reached). Return a tailored 402.
        res.status(402).json(formatOverageBlockedResponse(result, action, limit, used));
        return;
      }

      // ── Legacy USD overage path ────────────────────────────────────
      if (freshUser.topUpBalance >= price) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            [usedField]: { increment: 1 },
            topUpBalance: { decrement: price },
          },
        });
        if (action === 'interview') {
          await writeDeductionLog({
            userId: user.id,
            apiKeyId: req.apiKeyId ?? null,
            sku: 'interview',
            source: 'overage',
            tierAtCommit: tier,
            usedBefore: used,
            usedAfter: used + 1,
            limitAtCommit: Number.isFinite(limit) ? limit : null,
            costMinor: Math.round(price * 100), // approximate USD-cents snapshot
            currency: 'USD',
            requestId: req.requestId ?? null,
            relatedEntityType: 'api',
            relatedEntityId: req.path,
            metadata: { endpoint: req.path, source: 'checkUsageLimit_middleware_legacy_topup', priceUsd: price },
          });
        }
        // Shadow-mode: write a ledger row for reconciliation, without
        // debiting topUpBalanceMinor (the legacy path already charged
        // in USD). Safe to run in prod before flipping OVERAGE_ENABLED.
        if (isOverageShadow()) {
          await writeShadowLedgerRow(user.id, action, req.requestId ?? null).catch((err) =>
            console.error('Shadow ledger write failed:', err),
          );
        }
        (req as any).usageBilling = { source: 'topup', action, cost: price };
        next();
        return;
      }

      // Insufficient balance (legacy USD path)
      const actionLabel = action === 'interview' ? 'interview' : 'resume match';
      res.status(402).json({
        success: false,
        error: `You've reached your monthly ${actionLabel} limit (${limit}). Top up your balance to continue — $${price.toFixed(2)} per ${actionLabel}.`,
        code: 'USAGE_LIMIT_EXCEEDED',
        details: {
          action,
          used,
          limit,
          pricePerUnit: price,
          currentBalance: freshUser.topUpBalance,
          requiredBalance: price,
        },
      });
    } catch (error) {
      console.error('Usage meter error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to check usage limits',
        code: 'USAGE_CHECK_ERROR',
      });
    }
  };
}

/**
 * Check and deduct usage for a batch of billable actions (e.g. batch-invite).
 * Returns the number of units that can be processed, or an error object.
 *
 * Logic:
 * 1. Compute how many units fit within the plan quota
 * 2. For remaining units, check top-up balance
 * 3. Deduct everything atomically
 * 4. Return breakdown of plan-covered vs top-up-covered units
 *
 * @deprecated for the `match` SKU. Match quota is billed on success only —
 * call `gateMatchUsage` (pre-flight) and `commitMatchUsage` (post-success)
 * from `lib/matchBilling.ts` instead. See
 * docs/prd-resume-match-quota-rule.md. The `interview` SKU still uses this.
 */
export async function checkBatchUsage(
  userId: string,
  action: BillableAction,
  count: number,
  // API key (rh_...) that drove the batch, when API-key authenticated.
  // Threaded onto each per-unit UsageDeductionLog row for per-key billing.
  apiKeyId?: string | null,
): Promise<
  | { ok: true; planUnits: number; topUpUnits: number; topUpCost: number }
  | { ok: false; error: string; code: string; details?: Record<string, unknown> }
> {
  if (action === 'match' && process.env.NODE_ENV !== 'production') {
    // Loud signal in dev / CI. Production keeps the legacy path silent
    // for emergency rollback compatibility, but new code paths should
    // never hit it under the new resume-match quota rule.
    console.warn(
      '[matchBilling] checkBatchUsage was called with action=match — this is the deprecated pre-pay path. ' +
      'Use gateMatchUsage + commitMatchUsage from lib/matchBilling.js. ' +
      'See docs/prd-resume-match-quota-rule.md.',
    );
  }
  const freshUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      subscriptionTier: true,
      subscriptionStatus: true,
      interviewsUsed: true,
      resumeMatchesUsed: true,
      topUpBalance: true,
      currentPeriodEnd: true,
      subscriptionGraceDays: true,
      role: true,
      customMaxInterviews: true,
      customMaxMatches: true,
    },
  });

  if (!freshUser) {
    return { ok: false, error: 'User not found', code: 'USER_NOT_FOUND' };
  }

  const tier = freshUser.subscriptionTier || 'free';
  const planLimits = await getPlanLimits();
  const payPerUse = await getPayPerUseRates();
  const limits = planLimits[tier] || planLimits.free;

  // Grace-aware: in-grace users keep consuming; lock only past the window.
  if ((await isSubscriptionLockedForQuota(freshUser)) && freshUser.topUpBalance <= 0) {
    return { ok: false, error: 'Your subscription is inactive.', code: 'SUBSCRIPTION_INACTIVE' };
  }

  const used = action === 'interview' ? freshUser.interviewsUsed : freshUser.resumeMatchesUsed;
  const limit = action === 'interview'
    ? (freshUser.customMaxInterviews ?? limits.interviews)
    : (freshUser.customMaxMatches ?? limits.matches);
  const price = action === 'interview' ? payPerUse.interview : payPerUse.match;
  const usedField = action === 'interview' ? 'interviewsUsed' : 'resumeMatchesUsed';

  // How many fit within the plan quota
  const remainingQuota = Math.max(0, limit - used);
  const planUnits = Math.min(count, remainingQuota);
  const overageUnits = count - planUnits;

  // Check top-up balance for overage
  const overageCost = overageUnits * price;
  if (overageCost > 0 && freshUser.topUpBalance < overageCost) {
    const affordable = Math.floor(freshUser.topUpBalance / price);
    const totalAffordable = planUnits + affordable;
    if (totalAffordable === 0) {
      const actionLabel = action === 'interview' ? 'interview' : 'resume match';
      return {
        ok: false,
        error: `You've reached your monthly ${actionLabel} limit (${limit}). Top up your balance to continue.`,
        code: 'USAGE_LIMIT_EXCEEDED',
        details: { used, limit, pricePerUnit: price, currentBalance: freshUser.topUpBalance, requested: count },
      };
    }
    // Partial: can only afford some — reject so user knows upfront
    const actionLabel = action === 'interview' ? 'interviews' : 'resume matches';
    return {
      ok: false,
      error: `Insufficient balance for ${count} ${actionLabel}. You can afford ${totalAffordable} (${planUnits} in plan + ${affordable} from balance). Top up or reduce batch size.`,
      code: 'INSUFFICIENT_BALANCE',
      details: { used, limit, pricePerUnit: price, currentBalance: freshUser.topUpBalance, requested: count, affordable: totalAffordable },
    };
  }

  // Deduct usage + balance
  const updateData: Record<string, unknown> = {
    [usedField]: { increment: count },
  };
  if (overageCost > 0) {
    updateData.topUpBalance = { decrement: overageCost };
  }

  await prisma.user.update({
    where: { id: userId },
    data: updateData,
  });

  // Append-only audit rows. Only the `interview` SKU still flows through
  // this batch debit path (the `match` SKU is handled in matchBilling.ts
  // per docs/prd-resume-match-quota-rule.md). Write one row per unit so
  // forensics can reconstruct "which of the 50 invitations did this user
  // pay plan vs overage for".
  if (action === 'interview') {
    const sku: DeductionSku = 'interview';
    let usedRunning = used;
    for (let i = 0; i < count; i++) {
      const isPlanUnit = i < planUnits;
      await writeDeductionLog({
        userId,
        apiKeyId: apiKeyId ?? null,
        sku,
        source: isPlanUnit ? 'plan' : 'overage',
        tierAtCommit: tier,
        usedBefore: usedRunning,
        usedAfter: usedRunning + 1,
        limitAtCommit: Number.isFinite(limit) ? limit : null,
        costMinor: isPlanUnit ? null : Math.round(price * 100),
        currency: isPlanUnit ? null : 'USD',
        relatedEntityType: 'batch_invite',
        relatedEntityId: null,
        metadata: { source: 'checkBatchUsage', batchSize: count, batchIndex: i },
      });
      usedRunning += 1;
    }
  }

  return { ok: true, planUnits, topUpUnits: overageUnits, topUpCost: overageCost };
}

// ---------------------------------------------------------------------------
// peekBatchUsage — non-debiting read of "would this run succeed?"
// ---------------------------------------------------------------------------
// Mirrors checkBatchUsage's quota math without mutating User.* counters or
// User.topUpBalance. Used by Phase 1C cost-estimate endpoint to power the
// recruiter-facing pre-flight card (Pattern 1 zone 3).
//
// Returns the same outcome buckets as checkBatchUsage but with an extra
// snapshot field so the UI can render "X of Y used this month" without
// a second query.
//
// Important: this is a READ. Calling it 100 times in quick succession does
// NOT consume quota or money. checkBatchUsage is the only function that
// debits.
// ---------------------------------------------------------------------------

export interface PeekBatchUsageSnapshot {
  /** Tier the user is currently on (free / starter / growth / business / custom). */
  tier: string;
  /** Effective monthly limit for the requested action (after custom overrides). */
  limit: number;
  /** Units already consumed this period. */
  used: number;
  /** Units remaining in the plan quota. */
  remainingQuota: number;
  /** User's current top-up wallet balance (USD-equivalent for legacy path). */
  topUpBalance: number;
  /** Per-unit price for the action (USD). */
  pricePerUnit: number;
}

export type PeekBatchUsageResult =
  | {
      ok: true;
      snapshot: PeekBatchUsageSnapshot;
      /** How many of `count` would be covered by the plan quota. */
      planUnits: number;
      /** How many of `count` would overflow into the top-up wallet. */
      overageUnits: number;
      /** Estimated cost (USD) of the overage portion. */
      overageCost: number;
    }
  | {
      ok: false;
      code: 'USER_NOT_FOUND' | 'SUBSCRIPTION_INACTIVE' | 'USAGE_LIMIT_EXCEEDED' | 'INSUFFICIENT_BALANCE';
      error: string;
      snapshot?: PeekBatchUsageSnapshot;
      details?: Record<string, unknown>;
    };

export async function peekBatchUsage(
  userId: string,
  action: BillableAction,
  count: number,
): Promise<PeekBatchUsageResult> {
  const freshUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      subscriptionTier: true,
      subscriptionStatus: true,
      interviewsUsed: true,
      resumeMatchesUsed: true,
      topUpBalance: true,
      currentPeriodEnd: true,
      subscriptionGraceDays: true,
      role: true,
      customMaxInterviews: true,
      customMaxMatches: true,
    },
  });
  if (!freshUser) {
    return { ok: false, code: 'USER_NOT_FOUND', error: 'User not found' };
  }

  const tier = freshUser.subscriptionTier || 'free';
  const planLimits = await getPlanLimits();
  const payPerUse = await getPayPerUseRates();
  const limits = planLimits[tier] || planLimits.free;

  const used = action === 'interview' ? freshUser.interviewsUsed : freshUser.resumeMatchesUsed;
  const limit = action === 'interview'
    ? (freshUser.customMaxInterviews ?? limits.interviews)
    : (freshUser.customMaxMatches ?? limits.matches);
  const price = action === 'interview' ? payPerUse.interview : payPerUse.match;
  const remainingQuota = Math.max(0, limit - used);

  const snapshot: PeekBatchUsageSnapshot = {
    tier,
    limit,
    used,
    remainingQuota,
    topUpBalance: freshUser.topUpBalance,
    pricePerUnit: price,
  };

  // Grace-aware: in-grace users keep consuming; lock only past the window.
  if ((await isSubscriptionLockedForQuota(freshUser)) && freshUser.topUpBalance <= 0) {
    return { ok: false, code: 'SUBSCRIPTION_INACTIVE', error: 'Your subscription is inactive.', snapshot };
  }

  const planUnits = Math.min(count, remainingQuota);
  const overageUnits = count - planUnits;
  const overageCost = overageUnits * price;

  if (overageCost > 0 && freshUser.topUpBalance < overageCost) {
    const affordable = Math.floor(freshUser.topUpBalance / price);
    const totalAffordable = planUnits + affordable;
    if (totalAffordable === 0) {
      const actionLabel = action === 'interview' ? 'interview' : 'resume match';
      return {
        ok: false,
        code: 'USAGE_LIMIT_EXCEEDED',
        error: `You've reached your monthly ${actionLabel} limit (${limit}). Top up your balance to continue.`,
        snapshot,
        details: { used, limit, pricePerUnit: price, currentBalance: freshUser.topUpBalance, requested: count },
      };
    }
    const actionLabel = action === 'interview' ? 'interviews' : 'resume matches';
    return {
      ok: false,
      code: 'INSUFFICIENT_BALANCE',
      error: `Insufficient balance for ${count} ${actionLabel}. You can afford ${totalAffordable} (${planUnits} in plan + ${affordable} from balance). Top up or reduce batch size.`,
      snapshot,
      details: { used, limit, pricePerUnit: price, currentBalance: freshUser.topUpBalance, requested: count, affordable: totalAffordable },
    };
  }

  return { ok: true, snapshot, planUnits, overageUnits, overageCost };
}

/**
 * Reset usage counters for a user. Called when subscription renews (Stripe/
 * Alipay webhooks) and from the AnniversaryUsageResetService daily cron.
 * Stamps `lastUsageResetAt` so admins can audit the per-user reset history
 * and diagnose missed-webhook cases.
 */
export async function resetUsageCounters(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      interviewsUsed: 0,
      resumeMatchesUsed: 0,
      assessmentInvitesUsed: 0,
      lastUsageResetAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Overage billing helpers (Phase 2)
// ---------------------------------------------------------------------------

function formatOverageBlockedResponse(
  result: OverageBilling.ChargeResult,
  action: BillableAction,
  limit: number,
  used: number,
): Record<string, unknown> {
  const actionLabel = action === 'interview' ? 'interview' : 'resume match';
  const currency = (result.currency ?? 'USD') as Currency;
  const amountFormatted = result.amountMinor != null
    ? formatMoney(result.amountMinor, currency)
    : null;

  // Map blockedReason to a user-facing message + error code. The code
  // is stable (frontend branches on it) so keep in sync with the
  // consent banner + billing page messages.
  switch (result.blockedReason) {
    case 'insufficient_balance':
      return {
        success: false,
        error: `You've used all ${limit} ${actionLabel}s this period and don't have enough wallet balance for another${amountFormatted ? ` (${amountFormatted} per ${actionLabel})` : ''}. Top up to continue.`,
        code: 'OVERAGE_INSUFFICIENT_BALANCE',
        details: {
          action, used, limit,
          pricePerUnitMinor: result.amountMinor,
          currency,
          currentBalanceMinor: result.newBalanceMinor ?? 0,
        },
      };
    case 'monthly_cap_reached':
      return {
        success: false,
        error: `Your monthly overage cap has been reached. Raise the cap in Billing settings or wait until next month.`,
        code: 'OVERAGE_MONTHLY_CAP',
        details: {
          action, used, limit,
          pricePerUnitMinor: result.amountMinor,
          currency,
          monthToDateMinor: result.monthToDateMinor,
          monthlyCapMinor: result.monthlyCapMinor,
        },
      };
    case 'overage_disabled':
    case 'free_tier_no_overage':
      return {
        success: false,
        error: `You've reached your monthly ${actionLabel} limit (${limit}). Enable overage in Billing settings or upgrade your plan.`,
        code: 'OVERAGE_DISABLED',
        details: { action, used, limit, blockedReason: result.blockedReason },
      };
    case 'rate_not_configured':
      return {
        success: false,
        error: `Your account isn't configured for overage on this action. Contact support.`,
        code: 'OVERAGE_RATE_MISSING',
        details: { action, used, limit },
      };
    case 'user_not_found':
    default:
      return {
        success: false,
        error: `You've reached your monthly ${actionLabel} limit (${limit}).`,
        code: 'USAGE_LIMIT_EXCEEDED',
        details: { action, used, limit, blockedReason: result.blockedReason ?? 'unknown' },
      };
  }
}

/**
 * Shadow-mode ledger writer. Inserts an OverageCharge row WITHOUT
 * debiting the user's balance — the legacy USD path is still the real
 * debit. Lets ops confirm the ledger counts match before flipping
 * OVERAGE_ENABLED. Errors are logged but non-fatal.
 */
async function writeShadowLedgerRow(
  userId: string,
  action: BillableAction,
  requestId: string | null,
): Promise<void> {
  const sku: PayPerUseSku = action === 'interview' ? 'interview' : 'resume_match';
  const rate = await OverageBilling.resolvePayPerUseRate(userId, sku);
  if (!rate) return;
  // Fire-and-forget insert; status='charged' matches a real charge for
  // counting purposes, but no balance decrement happened.
  await prisma.overageCharge.create({
    data: {
      userId,
      sku,
      market: rate.market,
      currency: rate.currency,
      amountMinor: rate.amountMinor,
      balanceAfterMinor: 0, // shadow: balance unchanged by this record
      requestId,
      status: 'charged',
    },
  });
}
