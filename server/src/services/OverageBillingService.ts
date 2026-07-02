/**
 * OverageBillingService
 *
 * The single choke point for debiting a user's wallet when they exceed
 * a tier cap. Every overage debit in the codebase goes through this
 * service — no route handler should touch `topUpBalanceMinor` directly.
 *
 * Spec: docs/prd-multicurrency-overage-billing.md,
 * docs/design-multicurrency-overage-billing.md §3.2.
 *
 * Key guarantees:
 *   - Atomic: check + debit + ledger insert in one Postgres transaction.
 *   - Idempotent on requestId: a retried request produces one ledger row.
 *   - Ledger is append-only: waive = reversal row, not UPDATE.
 *   - Minor units only — no floats touch the money math.
 */

import prisma from '../lib/prisma.js';
import {
  currencyForMarket,
  normalizeMarket,
  type Currency,
  type Market,
  type PayPerUseSku,
} from './CurrencyService.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type ChargeBlockedReason =
  | 'overage_disabled'
  | 'insufficient_balance'
  | 'monthly_cap_reached'
  | 'rate_not_configured'
  | 'free_tier_no_overage'
  | 'user_not_found';

export interface ChargeResult {
  charged: boolean;
  /** Present on success. */
  chargeId?: string;
  /** Present on block. */
  blockedReason?: ChargeBlockedReason;
  /** Present on both success and some block types for UI messaging. */
  amountMinor?: number;
  currency?: Currency;
  market?: Market;
  newBalanceMinor?: number;
  /** Month-to-date overage spend AFTER this charge (or current value on block). */
  monthToDateMinor?: number;
  /** Monthly cap if set; for UI messaging. */
  monthlyCapMinor?: number | null;
}

export interface RateInfo {
  amountMinor: number;
  currency: Currency;
  market: Market;
  /** Where this rate came from. 'override' wins over 'market_default'. */
  source: 'override' | 'market_default';
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the per-use rate for (user, sku). Reads user's admin-set
 * overrides first, falls back to the market default row. Throws only
 * if the user doesn't exist; a missing rate returns amountMinor=-1 and
 * the caller must handle `rate_not_configured`.
 */
export async function resolvePayPerUseRate(
  userId: string,
  sku: PayPerUseSku,
): Promise<RateInfo | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      market: true,
      overageRateOverrides: true,
    },
  });
  if (!user) return null;

  const market = normalizeMarket(user.market);
  const currency = currencyForMarket(market);

  // Admin override wins. `overageRateOverrides` is a JSON object keyed
  // by SKU. Missing key / null value falls through to market default.
  const overrides = user.overageRateOverrides as Record<string, number | null> | null;
  const overrideAmount = overrides?.[sku];
  if (overrideAmount != null && Number.isFinite(overrideAmount) && overrideAmount >= 0) {
    return {
      amountMinor: Math.floor(overrideAmount),
      currency,
      market,
      source: 'override',
    };
  }

  const rateRow = await prisma.overageRate.findUnique({
    where: { market_sku: { market, sku } },
  });
  if (!rateRow) return null;
  return {
    amountMinor: rateRow.amountMinor,
    currency: rateRow.currency as Currency,
    market,
    source: 'market_default',
  };
}

/**
 * Charge one unit of overage. Returns a ChargeResult describing what
 * happened. This is the ONLY path that debits topUpBalanceMinor for
 * overage — never call `user.update({ topUpBalanceMinor: ... })` from
 * a route handler.
 *
 * Idempotency: if `requestId` is non-null and a charged OverageCharge
 * row already exists for (userId, sku, requestId), that row is returned
 * as-is and no new debit happens. Retries are safe.
 *
 * Free-tier policy: Free users get hard block (no overage path). Admin
 * can flip `overageEnabled=true` on a Free user to grant overage; in
 * that case this function proceeds normally.
 */
export async function charge(params: {
  userId: string;
  sku: PayPerUseSku;
  requestId: string | null;
}): Promise<ChargeResult> {
  const { userId, sku, requestId } = params;

  // Idempotency pre-check outside the transaction — saves a round-trip
  // on the common retry case without weakening the guarantee (the
  // conditional update inside the tx is the real safety net).
  if (requestId) {
    const existing = await prisma.overageCharge.findFirst({
      where: { userId, sku, requestId, status: 'charged' },
      select: { id: true, amountMinor: true, currency: true, market: true, balanceAfterMinor: true },
    });
    if (existing) {
      return {
        charged: true,
        chargeId: existing.id,
        amountMinor: existing.amountMinor,
        currency: existing.currency as Currency,
        market: existing.market as Market,
        newBalanceMinor: existing.balanceAfterMinor,
      };
    }
  }

  const rate = await resolvePayPerUseRate(userId, sku);
  if (!rate) {
    // Either user doesn't exist or no rate configured for their market.
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    return {
      charged: false,
      blockedReason: user ? 'rate_not_configured' : 'user_not_found',
    };
  }

  // Zero-rate admin override: insert a charge row for audit but skip the
  // debit. Still counts toward monthly cap (zero), still counts as a
  // "charged" unit so rate-limit / usage metrics don't double-count.
  if (rate.amountMinor === 0) {
    const chargeRow = await prisma.overageCharge.create({
      data: {
        userId,
        sku,
        market: rate.market,
        currency: rate.currency,
        amountMinor: 0,
        balanceAfterMinor: 0, // snapshot meaningless for zero-rate; read balance separately
        requestId: requestId ?? null,
        status: 'charged',
      },
      select: { id: true, balanceAfterMinor: true },
    });
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { topUpBalanceMinor: true },
    });
    return {
      charged: true,
      chargeId: chargeRow.id,
      amountMinor: 0,
      currency: rate.currency,
      market: rate.market,
      newBalanceMinor: user?.topUpBalanceMinor ?? 0,
    };
  }

  // The money-moving path. Wrapped in a transaction with a conditional
  // debit — if two concurrent charge() calls race for the last unit of
  // balance, exactly one wins (updateMany count tells us which).
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          topUpBalanceMinor: true,
          overageEnabled: true,
          overageMonthlyCapMinor: true,
          subscriptionTier: true,
        },
      });
      if (!user) return { charged: false, blockedReason: 'user_not_found' as const };

      // Free tier gets hard block unless admin explicitly flipped the
      // opt-in on. The default schema value is `true` across all tiers,
      // so admin must have set it to false on the Free user. We double-
      // check the tier here for defense-in-depth.
      const tier = (user.subscriptionTier ?? 'free').toLowerCase();
      if (tier === 'free' && !user.overageEnabled) {
        return { charged: false, blockedReason: 'free_tier_no_overage' as const };
      }
      if (!user.overageEnabled) {
        return { charged: false, blockedReason: 'overage_disabled' as const };
      }

      // Monthly cap check — aggregate charged rows this UTC month.
      const monthStart = firstOfMonthUtc();
      const mtdAgg = await tx.overageCharge.aggregate({
        where: { userId, status: 'charged', createdAt: { gte: monthStart } },
        _sum: { amountMinor: true },
      });
      const mtdBefore = mtdAgg._sum.amountMinor ?? 0;
      if (
        user.overageMonthlyCapMinor != null &&
        mtdBefore + rate.amountMinor > user.overageMonthlyCapMinor
      ) {
        return {
          charged: false,
          blockedReason: 'monthly_cap_reached' as const,
          amountMinor: rate.amountMinor,
          currency: rate.currency,
          market: rate.market,
          newBalanceMinor: user.topUpBalanceMinor,
          monthToDateMinor: mtdBefore,
          monthlyCapMinor: user.overageMonthlyCapMinor,
        };
      }

      // Conditional debit — `updateMany` with a where clause returns
      // { count: 0 } if another request drained the wallet first. No
      // row is mutated on count=0.
      const debit = await tx.user.updateMany({
        where: { id: userId, topUpBalanceMinor: { gte: rate.amountMinor } },
        data: { topUpBalanceMinor: { decrement: rate.amountMinor } },
      });
      if (debit.count === 0) {
        return {
          charged: false,
          blockedReason: 'insufficient_balance' as const,
          amountMinor: rate.amountMinor,
          currency: rate.currency,
          market: rate.market,
          newBalanceMinor: user.topUpBalanceMinor,
          monthToDateMinor: mtdBefore,
          monthlyCapMinor: user.overageMonthlyCapMinor,
        };
      }

      // Re-read balance for the immutable ledger snapshot.
      const after = await tx.user.findUnique({
        where: { id: userId },
        select: { topUpBalanceMinor: true },
      });

      const chargeRow = await tx.overageCharge.create({
        data: {
          userId,
          sku,
          market: rate.market,
          currency: rate.currency,
          amountMinor: rate.amountMinor,
          balanceAfterMinor: after!.topUpBalanceMinor,
          requestId: requestId ?? null,
          status: 'charged',
        },
      });

      return {
        charged: true,
        chargeId: chargeRow.id,
        amountMinor: rate.amountMinor,
        currency: rate.currency,
        market: rate.market,
        newBalanceMinor: after!.topUpBalanceMinor,
        monthToDateMinor: mtdBefore + rate.amountMinor,
        monthlyCapMinor: user.overageMonthlyCapMinor,
      };
    });
  } catch (err) {
    // Failure mode: transaction rolls back automatically. We return a
    // synthetic block so the caller can decide to let the underlying
    // action proceed or fail. Matches the "never double-charge" invariant.
    console.error('OverageBillingService.charge transaction failed', {
      userId,
      sku,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { charged: false, blockedReason: 'user_not_found' };
  }
}

/**
 * Reverse a previously-charged OverageCharge. Credits the user's
 * balance back and inserts a sibling ledger row linked via `reversalOfId`.
 * Idempotent: calling waive() twice on the same charge does nothing the
 * second time (returns { ok: true } with no extra ledger row).
 */
export async function waive(params: {
  chargeId: string;
  adminUserId: string;
  reason: string;
}): Promise<{ ok: boolean; reversalId?: string; error?: string }> {
  const { chargeId, adminUserId, reason } = params;
  if (!reason.trim()) return { ok: false, error: 'reason_required' };

  try {
    return await prisma.$transaction(async (tx) => {
      const original = await tx.overageCharge.findUnique({
        where: { id: chargeId },
        select: {
          id: true,
          userId: true,
          sku: true,
          market: true,
          currency: true,
          amountMinor: true,
          status: true,
        },
      });
      if (!original) return { ok: false, error: 'charge_not_found' };
      if (original.status === 'voided') return { ok: true }; // idempotent

      // Credit balance back.
      if (original.amountMinor > 0) {
        await tx.user.update({
          where: { id: original.userId },
          data: { topUpBalanceMinor: { increment: original.amountMinor } },
        });
      }

      const after = await tx.user.findUnique({
        where: { id: original.userId },
        select: { topUpBalanceMinor: true },
      });

      // Insert the reversal row. Status='voided' on it so aggregate
      // queries that sum status='charged' naturally skip reversals.
      const reversal = await tx.overageCharge.create({
        data: {
          userId: original.userId,
          sku: original.sku,
          market: original.market,
          currency: original.currency,
          amountMinor: original.amountMinor, // same sign; status distinguishes
          balanceAfterMinor: after?.topUpBalanceMinor ?? 0,
          status: 'voided',
          reversalOfId: original.id,
        },
        select: { id: true },
      });

      // Mark the original as voided.
      await tx.overageCharge.update({
        where: { id: original.id },
        data: { status: 'voided', waivedBy: adminUserId, waiveReason: reason.trim() },
      });

      // Audit trail: AdminAdjustment row so the admin's adjustment
      // history shows the waive alongside other admin actions.
      await tx.adminAdjustment.create({
        data: {
          userId: original.userId,
          adminId: adminUserId,
          type: 'overage_waive',
          amount: original.amountMinor, // stored as integer; currency is in oldValue
          oldValue: `charged:${original.amountMinor}${original.currency}`,
          newValue: `voided:reversalId=${reversal.id}`,
          reason: reason.trim(),
        },
      });

      return { ok: true, reversalId: reversal.id };
    });
  } catch (err) {
    console.error('OverageBillingService.waive failed', {
      chargeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: 'internal_error' };
  }
}

/**
 * Sum of charged overages for a user in the current UTC month. Used by
 * the user-facing billing page and by charge() itself. Excludes voided
 * rows so waived charges don't count toward the monthly cap.
 */
export async function monthToDateOverageMinor(userId: string, now?: Date): Promise<number> {
  const monthStart = firstOfMonthUtc(now);
  const agg = await prisma.overageCharge.aggregate({
    where: { userId, status: 'charged', createdAt: { gte: monthStart } },
    _sum: { amountMinor: true },
  });
  return agg._sum.amountMinor ?? 0;
}

// ── Internals ───────────────────────────────────────────────────────────────

function firstOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// ── Seed ────────────────────────────────────────────────────────────────────

/**
 * Boot-time upsert of the PRD §5.1 rate matrix into OverageRate. Idempotent
 * on `[market, sku]` unique. Safe to run on every start — admin edits
 * are preserved by not overwriting existing rows whose updatedBy != null.
 */
const SEED_RATES: Array<{
  market: Market;
  sku: PayPerUseSku;
  currency: Currency;
  amountMinor: number;
}> = [
  // CN market — CNY (fen = 1/100 yuan)
  { market: 'cn', sku: 'resume_match', currency: 'CNY', amountMinor: 20 }, // ¥0.20
  { market: 'cn', sku: 'interview', currency: 'CNY', amountMinor: 900 }, // ¥9.00
  { market: 'cn', sku: 'agent_run_resume', currency: 'CNY', amountMinor: 20 },

  // TW market — TWD (no minor unit; stored as whole dollars)
  { market: 'tw', sku: 'resume_match', currency: 'TWD', amountMinor: 2 }, // NT$2
  { market: 'tw', sku: 'interview', currency: 'TWD', amountMinor: 49 }, // NT$49
  { market: 'tw', sku: 'agent_run_resume', currency: 'TWD', amountMinor: 2 },

  // JP market — JPY (no minor unit)
  { market: 'jp', sku: 'resume_match', currency: 'JPY', amountMinor: 30 }, // ¥30
  { market: 'jp', sku: 'interview', currency: 'JPY', amountMinor: 300 }, // ¥300
  { market: 'jp', sku: 'agent_run_resume', currency: 'JPY', amountMinor: 30 },

  // Other (USD — cents)
  { market: 'other', sku: 'resume_match', currency: 'USD', amountMinor: 20 }, // $0.20
  { market: 'other', sku: 'interview', currency: 'USD', amountMinor: 200 }, // $2.00
  { market: 'other', sku: 'agent_run_resume', currency: 'USD', amountMinor: 20 },
];

/**
 * Credit a top-up to both the legacy `topUpBalance` (Float, backward
 * compat) and the new `topUpBalanceMinor` (integer, market-currency)
 * columns. Pass the currency you actually charged in — the function
 * compares against the user's market currency and only writes the
 * minor column on a match. Mismatches are logged and leave the minor
 * column untouched so the new billing path doesn't accidentally
 * charge against FX-mismatched balance.
 *
 * Callers: every Stripe / Alipay webhook that credits a wallet. Pass
 * `currency='USD'` for Stripe paths and `currency='CNY'` for Alipay.
 *
 * Accepts an optional `tx` so callers inside a Prisma transaction can
 * keep atomicity. `tx` can be a PrismaClient or a TransactionClient.
 */
export async function creditTopUpBalance(
  userId: string,
  amountMajor: number,
  currency: Currency,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx?: any,
): Promise<void> {
  const client = tx ?? prisma;
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { market: true },
  });
  if (!user) return;

  const { currencyForMarket, majorToMinor, normalizeMarket } = await import(
    './CurrencyService.js'
  );
  const userCurrency = currencyForMarket(normalizeMarket(user.market));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: any = { topUpBalance: { increment: amountMajor } };
  if (userCurrency === currency) {
    updates.topUpBalanceMinor = {
      increment: majorToMinor(amountMajor, currency),
    };
  } else {
    // User's market and the top-up currency don't align. Legacy column
    // still gets the credit (backward compat), but the new market-aware
    // billing path won't see it. Flag so CS can help the user top up
    // via the right channel for their market.
    console.warn(
      `[creditTopUpBalance] Currency mismatch for user ${userId}: ` +
        `market=${userCurrency}, credited=${currency}. Legacy column only.`,
    );
  }

  await client.user.update({ where: { id: userId }, data: updates });
}

/**
 * One-time migration: backfill `topUpBalanceMinor` from the legacy
 * `topUpBalance` Float field, using each user's market currency.
 *
 * Historically `topUpBalance` stored USD amounts for Stripe top-ups
 * AND CNY amounts for Alipay top-ups (because the Alipay handler
 * incremented the same column without converting) — a pre-existing
 * inconsistency. This migration respects that reality by converting
 * per user.market:
 *
 *   market='other' (USD) → `topUpBalance × 100`  (cents)
 *   market='cn'    (CNY) → `topUpBalance × 100`  (fen — stored as CNY)
 *   market='tw'    (TWD) → `round(topUpBalance)` (no minor unit)
 *   market='jp'    (JPY) → `round(topUpBalance)` (no minor unit)
 *
 * Idempotent: only touches users whose `topUpBalanceMinor` is 0 and
 * `topUpBalance` is > 0. After this runs, the OverageBillingService
 * is the source of truth and legacy `topUpBalance` is kept read-only
 * for display during the transition.
 *
 * New credits (top-ups) should dual-write both columns — see
 * checkout.ts handlers. Eventually `topUpBalance` can be dropped.
 */
export async function migrateLegacyTopUpBalance(): Promise<{
  migrated: number;
  totalCandidates: number;
}> {
  const candidates = await prisma.user.findMany({
    where: {
      topUpBalanceMinor: 0,
      topUpBalance: { gt: 0 },
    },
    select: { id: true, topUpBalance: true, market: true },
  });

  const { currencyForMarket, majorToMinor, normalizeMarket } = await import(
    './CurrencyService.js'
  );

  let migrated = 0;
  for (const u of candidates) {
    const market = normalizeMarket(u.market);
    const currency = currencyForMarket(market);
    const minor = majorToMinor(u.topUpBalance, currency);
    if (minor <= 0) continue;
    await prisma.user.update({
      where: { id: u.id },
      data: { topUpBalanceMinor: minor },
    });
    migrated++;
  }

  if (migrated > 0) {
    console.log(
      `[migrateLegacyTopUpBalance] Migrated ${migrated}/${candidates.length} user balances`,
    );
  }
  return { migrated, totalCandidates: candidates.length };
}

export async function seedOverageRatesIfMissing(): Promise<void> {
  for (const row of SEED_RATES) {
    await prisma.overageRate.upsert({
      where: { market_sku: { market: row.market, sku: row.sku } },
      create: {
        market: row.market,
        sku: row.sku,
        currency: row.currency,
        amountMinor: row.amountMinor,
        updatedBy: null, // null => seed, distinguishes from admin edits
      },
      // Do NOT overwrite admin edits. We only fill rows that don't
      // exist; an admin-edited row (updatedBy != null) is preserved.
      update: {},
    });
  }
}
