// backend/src/lib/mockCreditService.ts
//
// The mock-interview CREDIT ledger + balance authority for RoboApply.
// Lives in lib/ (alongside matchBilling.ts) so BOTH the Interview Engine
// (interview-engine/*) and the RoboApply billing routes can import it without a
// backward interview-engine → roboapply dependency.
//
//   • Balance lives on SeekerSubscription.mockCredits (running total).
//   • Every movement appends an immutable MockInterviewCreditLedger row.
//   • 1 credit = 20 min (see mockInterviewPlans.ts). Other durations pro-rated.
//
// Reads:  getBalance()   — lazily grants the free monthly allotment on a new
//                          calendar month (no cron needed for free tier).
// Grants: grantForPlan()  — on purchase/renewal, SET balance to the plan
//                          allotment (no rollover). Mid-period upgrade re-sets.
// Debits: debitForSession()— at interview end, subtract pro-rated credits.
//                          Idempotent per sessionId; clamps balance ≥ 0.
//
// Contract: debit + grant are best-effort and MUST NOT throw into the interview
// lifecycle (mirrors sessionCost.ts). The gate (checkAffordable) is allowed to
// surface an error to the route so the user gets a clean 402.

import prisma from './prisma.js';
import { logger } from '../services/LoggerService.js';
import {
  getMockPlanCatalog,
  isPaidMockPlan,
  roundCreditsUp,
  creditsForMinutes,
  creditsForSeconds,
  type MockPlanKey,
} from './mockInterviewPlans.js';

export type CreditLedgerReason =
  | 'grant_purchase'
  | 'grant_renewal'
  | 'grant_free_monthly'
  | 'signup_bonus'
  | 'debit_interview'
  | 'refund'
  | 'admin_adjust'
  | 'expire';

export interface CreditBalance {
  credits: number;
  tier: string;
  periodAllotment: number | null;
  renewedAt: Date | null;
  currentPeriodEnd: Date | null;
  /** True when no SeekerProfile exists (virtual free balance; debits no-op). */
  ephemeral: boolean;
}

interface ResolvedSeeker {
  seekerProfileId: string;
  subscriptionId: string;
  tier: string;
  mockCredits: number;
  mockCreditsRenewedAt: Date | null;
  mockCreditsPeriodAllotment: number | null;
  currentPeriodEnd: Date | null;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sameUtcMonth(a: Date | null | undefined, b: Date): boolean {
  if (!a) return false;
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

/**
 * Resolve (and lazily create) the SeekerSubscription row for a user. Returns
 * null when the user has no SeekerProfile (admins, profile-less accounts).
 */
async function resolveSeeker(userId: string): Promise<ResolvedSeeker | null> {
  const profile = await prisma.seekerProfile.findUnique({
    where: { userId },
    select: { id: true, subscription: { select: { id: true } } },
  });
  if (!profile) return null;

  let subId = profile.subscription?.id ?? null;
  if (!subId) {
    // Create the free subscription row lazily so credits have a home.
    const created = await prisma.seekerSubscription.upsert({
      where: { seekerProfileId: profile.id },
      update: {},
      create: { seekerProfileId: profile.id, tier: 'free', status: 'active' },
      select: { id: true },
    });
    subId = created.id;
  }

  const sub = await prisma.seekerSubscription.findUnique({
    where: { id: subId },
    select: {
      id: true,
      tier: true,
      mockCredits: true,
      mockCreditsRenewedAt: true,
      mockCreditsPeriodAllotment: true,
      currentPeriodEnd: true,
    },
  });
  if (!sub) return null;
  return {
    seekerProfileId: profile.id,
    subscriptionId: sub.id,
    tier: String(sub.tier),
    mockCredits: num(sub.mockCredits),
    mockCreditsRenewedAt: sub.mockCreditsRenewedAt ?? null,
    mockCreditsPeriodAllotment: sub.mockCreditsPeriodAllotment ?? null,
    currentPeriodEnd: sub.currentPeriodEnd ?? null,
  };
}

async function appendLedger(input: {
  seekerProfileId: string;
  userId: string;
  delta: number;
  balanceAfter: number;
  reason: CreditLedgerReason;
  tier?: string | null;
  relatedSessionId?: string | null;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await prisma.mockInterviewCreditLedger.create({
      data: {
        seekerProfileId: input.seekerProfileId,
        userId: input.userId,
        delta: input.delta,
        balanceAfter: input.balanceAfter,
        reason: input.reason,
        tier: input.tier ?? null,
        relatedSessionId: input.relatedSessionId ?? null,
        source: input.source ?? null,
        ...(input.metadata ? { metadata: input.metadata as object } : {}),
      },
    });
  } catch (err) {
    logger.warn('MOCK_CREDIT', 'ledger append failed', {
      userId: input.userId,
      reason: input.reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Read balance (with lazy free monthly grant) ──────────────────────────────

export async function getBalance(userId: string): Promise<CreditBalance> {
  const catalog = await getMockPlanCatalog();
  const freeCredits = catalog.plans.free.credits;
  const seeker = await resolveSeeker(userId);

  if (!seeker) {
    // No profile → virtual free balance so we never hard-block; debits no-op.
    return {
      credits: freeCredits,
      tier: 'free',
      periodAllotment: freeCredits,
      renewedAt: null,
      currentPeriodEnd: null,
      ephemeral: true,
    };
  }

  // Lazy free-tier monthly re-grant: only for the free tier, only when the last
  // grant was in a previous UTC month (or never). Paid tiers are granted by the
  // payment/renewal path, never here.
  if (!isPaidMockPlan(seeker.tier)) {
    const now = new Date();
    if (!sameUtcMonth(seeker.mockCreditsRenewedAt, now)) {
      // CONDITIONAL claim: only the writer whose read still matches the stored
      // renewedAt wins (guards against two concurrent getBalance() calls both
      // granting + writing duplicate ledger rows at a month boundary). The
      // loser sees count===0 and falls through to read the granted balance.
      const claim = await prisma.seekerSubscription.updateMany({
        where: { id: seeker.subscriptionId, mockCreditsRenewedAt: seeker.mockCreditsRenewedAt },
        data: { mockCredits: freeCredits, mockCreditsRenewedAt: now, mockCreditsPeriodAllotment: freeCredits },
      });
      if (claim.count === 1) {
        await appendLedger({
          seekerProfileId: seeker.seekerProfileId,
          userId,
          delta: roundCreditsUp(freeCredits - seeker.mockCredits) || freeCredits - seeker.mockCredits,
          balanceAfter: freeCredits,
          reason: seeker.mockCreditsRenewedAt ? 'grant_free_monthly' : 'signup_bonus',
          tier: 'free',
          source: 'system',
          metadata: { previousBalance: seeker.mockCredits },
        });
      }
      // Whether we won or lost the race, the balance is now the free allotment.
      return {
        credits: freeCredits,
        tier: 'free',
        periodAllotment: freeCredits,
        renewedAt: now,
        currentPeriodEnd: seeker.currentPeriodEnd,
        ephemeral: false,
      };
    }
  }

  return {
    credits: seeker.mockCredits,
    tier: seeker.tier,
    periodAllotment: seeker.mockCreditsPeriodAllotment,
    renewedAt: seeker.mockCreditsRenewedAt,
    currentPeriodEnd: seeker.currentPeriodEnd,
    ephemeral: false,
  };
}

// ─── Affordability gate (read-only) ───────────────────────────────────────────

export interface AffordResult {
  ok: boolean;
  balance: number;
  required: number;
  tier: string;
}

export async function checkAffordable(userId: string, requiredCredits: number): Promise<AffordResult> {
  const required = roundCreditsUp(requiredCredits);
  const bal = await getBalance(userId);
  // Small epsilon so 1.00 vs 1.0000001 float dust never wrongly blocks.
  return { ok: bal.credits + 1e-9 >= required, balance: bal.credits, required, tier: bal.tier };
}

/** Credits a planned-duration interview will cost (honors catalog creditMinutes). */
export async function requiredCreditsForMinutes(minutes: number): Promise<number> {
  const cat = await getMockPlanCatalog();
  return creditsForMinutes(minutes, cat.creditMinutes);
}

/** Gate a mock interview before it starts: is the planned duration affordable? */
export async function gateMockInterview(userId: string, plannedMinutes: number): Promise<AffordResult> {
  const required = await requiredCreditsForMinutes(plannedMinutes);
  return checkAffordable(userId, required);
}

/** Debit the actual (pro-rated) cost of a finished interview. Honors catalog
 *  creditMinutes; idempotent per sessionId; clamps balance ≥ 0. The debit is
 *  CAPPED at the credits the user was gated for at create time
 *  (creditsForMinutes(plannedDurationMinutes)) so the charge can never exceed
 *  what was authorized — gate and debit stay symmetric even if the live session
 *  ran past its planned length. */
export async function debitForFinishedSession(params: {
  userId: string;
  sessionId: string;
  durationSec: number;
  plannedDurationMinutes?: number | null;
  metadata?: Record<string, unknown> | null;
}): Promise<DebitResult | null> {
  const cat = await getMockPlanCatalog();
  const actual = creditsForSeconds(params.durationSec, cat.creditMinutes);
  const gated =
    params.plannedDurationMinutes && params.plannedDurationMinutes > 0
      ? creditsForMinutes(params.plannedDurationMinutes, cat.creditMinutes)
      : Infinity;
  const credits = Math.min(actual, gated);
  return debitForSession({
    userId: params.userId,
    sessionId: params.sessionId,
    credits,
    metadata: {
      durationSec: params.durationSec,
      creditMinutes: cat.creditMinutes,
      actualCredits: actual,
      gatedCredits: Number.isFinite(gated) ? gated : null,
      ...(params.metadata ?? {}),
    },
  });
}

// ─── Grant (purchase / renewal) — SET to plan allotment, no rollover ──────────

export async function grantForPlan(params: {
  userId: string;
  tier: MockPlanKey;
  reason: Extract<CreditLedgerReason, 'grant_purchase' | 'grant_renewal'>;
  source: string; // 'stripe' | 'alipay'
  currentPeriodEnd?: Date | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    const catalog = await getMockPlanCatalog();
    const allotment = catalog.plans[params.tier]?.credits ?? 0;
    const seeker = await resolveSeeker(params.userId);
    if (!seeker) {
      logger.warn('MOCK_CREDIT', 'grantForPlan skipped — no seeker profile', { userId: params.userId, tier: params.tier });
      return;
    }
    const now = new Date();
    await prisma.seekerSubscription.update({
      where: { id: seeker.subscriptionId },
      data: {
        mockCredits: allotment,
        mockCreditsRenewedAt: now,
        mockCreditsPeriodAllotment: allotment,
        ...(params.currentPeriodEnd !== undefined ? { currentPeriodEnd: params.currentPeriodEnd } : {}),
      },
    });
    await appendLedger({
      seekerProfileId: seeker.seekerProfileId,
      userId: params.userId,
      delta: allotment - seeker.mockCredits,
      balanceAfter: allotment,
      reason: params.reason,
      tier: params.tier,
      source: params.source,
      metadata: { previousBalance: seeker.mockCredits, allotment, ...(params.metadata ?? {}) },
    });
    logger.info('MOCK_CREDIT', 'credits granted', {
      userId: params.userId,
      tier: params.tier,
      reason: params.reason,
      allotment,
      previousBalance: seeker.mockCredits,
    });
  } catch (err) {
    logger.error('MOCK_CREDIT', 'grantForPlan failed', {
      userId: params.userId,
      tier: params.tier,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Grant the plan allotment, but only once per billing period (idempotent for
 * Stripe webhooks that can fire many times). Grants when: the period changed
 * (last grant predates `periodStart`), nothing was ever granted, or `force` is
 * set (a deliberate purchase / plan change). Otherwise keeps `currentPeriodEnd`
 * fresh for display without touching the balance.
 */
export async function grantForPlanIfNewPeriod(params: {
  userId: string;
  tier: MockPlanKey;
  periodStart: Date | null;
  currentPeriodEnd?: Date | null;
  source: string;
  force?: boolean;
  metadata?: Record<string, unknown> | null;
}): Promise<'granted' | 'skipped' | 'no_profile'> {
  const seeker = await resolveSeeker(params.userId);
  if (!seeker) return 'no_profile';

  const alreadyThisPeriod =
    !params.force &&
    seeker.mockCreditsRenewedAt != null &&
    (params.periodStart == null || seeker.mockCreditsRenewedAt >= params.periodStart);

  if (alreadyThisPeriod) {
    if (params.currentPeriodEnd !== undefined) {
      await prisma.seekerSubscription
        .update({ where: { id: seeker.subscriptionId }, data: { currentPeriodEnd: params.currentPeriodEnd } })
        .catch(() => {});
    }
    return 'skipped';
  }

  const reason: Extract<CreditLedgerReason, 'grant_purchase' | 'grant_renewal'> =
    params.force || !seeker.mockCreditsRenewedAt ? 'grant_purchase' : 'grant_renewal';
  await grantForPlan({
    userId: params.userId,
    tier: params.tier,
    reason,
    source: params.source,
    currentPeriodEnd: params.currentPeriodEnd ?? null,
    metadata: params.metadata,
  });
  return 'granted';
}

// ─── Debit (interview finished) — idempotent per session, clamp ≥ 0 ───────────

export interface DebitResult {
  debited: number;
  balanceAfter: number;
}

export async function debitForSession(params: {
  userId: string;
  sessionId: string;
  credits: number; // pro-rated requested debit (already rounded by caller, but we re-round)
  metadata?: Record<string, unknown> | null;
}): Promise<DebitResult | null> {
  const want = roundCreditsUp(params.credits);
  try {
    // Idempotency: a debit row for this session already settled → no-op.
    const existing = await prisma.mockInterviewCreditLedger.findFirst({
      where: { relatedSessionId: params.sessionId, reason: 'debit_interview' },
      select: { id: true, delta: true, balanceAfter: true },
    });
    if (existing) {
      logger.info('MOCK_CREDIT', 'debit already recorded; skipping', { userId: params.userId, sessionId: params.sessionId });
      return { debited: Math.abs(num(existing.delta)), balanceAfter: num(existing.balanceAfter) };
    }

    const seeker = await resolveSeeker(params.userId);
    if (!seeker) {
      logger.warn('MOCK_CREDIT', 'debit skipped — no seeker profile', { userId: params.userId, sessionId: params.sessionId });
      return null;
    }
    if (want <= 0) return { debited: 0, balanceAfter: seeker.mockCredits };

    // ATOMIC debit: the balance decrement AND the ledger row are written in ONE
    // transaction, so a ledger-write failure can never leave the balance debited
    // without an audit row (which would let a retry double-charge). The
    // conditional updateMany(where mockCredits=before) handles cross-session
    // contention; losing it throws RETRY to roll back + re-read. The idempotency
    // re-check inside the tx guards a same-session double-fire.
    const RETRY = '__mock_credit_retry__';
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          const dup = await tx.mockInterviewCreditLedger.findFirst({
            where: { relatedSessionId: params.sessionId, reason: 'debit_interview' },
            select: { delta: true, balanceAfter: true },
          });
          if (dup) return { debited: Math.abs(num(dup.delta)), balanceAfter: num(dup.balanceAfter) };

          const fresh = await tx.seekerSubscription.findUnique({
            where: { id: seeker.subscriptionId },
            select: { mockCredits: true },
          });
          const before = num(fresh?.mockCredits);
          const debit = Math.min(want, Math.max(0, before));
          const balanceAfter = roundCreditsUp(before - debit);
          const claim = await tx.seekerSubscription.updateMany({
            where: { id: seeker.subscriptionId, mockCredits: before },
            data: { mockCredits: balanceAfter },
          });
          if (claim.count !== 1) throw new Error(RETRY); // lost the race → rollback + retry
          await tx.mockInterviewCreditLedger.create({
            data: {
              seekerProfileId: seeker.seekerProfileId,
              userId: params.userId,
              delta: -debit,
              balanceAfter,
              reason: 'debit_interview',
              tier: seeker.tier,
              relatedSessionId: params.sessionId,
              source: 'system',
              metadata: { requested: want, before, ...(params.metadata ?? {}) } as object,
            },
          });
          return { debited: debit, balanceAfter };
        });
        logger.info('MOCK_CREDIT', 'credits debited', {
          userId: params.userId,
          sessionId: params.sessionId,
          requested: want,
          debited: result.debited,
          balanceAfter: result.balanceAfter,
        });
        return result;
      } catch (e) {
        if (e instanceof Error && e.message === RETRY) continue; // contention → retry
        throw e;
      }
    }
    logger.warn('MOCK_CREDIT', 'debit contention — gave up after retries', { userId: params.userId, sessionId: params.sessionId });
    return null;
  } catch (err) {
    logger.warn('MOCK_CREDIT', 'debitForSession failed', {
      userId: params.userId,
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Admin / refund adjustment (immutable sibling row) ────────────────────────

export async function adjustCredits(params: {
  userId: string;
  delta: number; // signed
  reason: Extract<CreditLedgerReason, 'refund' | 'admin_adjust' | 'expire'>;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<DebitResult | null> {
  const RETRY = '__mock_credit_retry__';
  try {
    const seeker = await resolveSeeker(params.userId);
    if (!seeker) return null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          const fresh = await tx.seekerSubscription.findUnique({
            where: { id: seeker.subscriptionId },
            select: { mockCredits: true },
          });
          const before = num(fresh?.mockCredits);
          const balanceAfter = Math.max(0, roundCreditsUp(before + params.delta));
          const claim = await tx.seekerSubscription.updateMany({
            where: { id: seeker.subscriptionId, mockCredits: before },
            data: { mockCredits: balanceAfter },
          });
          if (claim.count !== 1) throw new Error(RETRY);
          await tx.mockInterviewCreditLedger.create({
            data: {
              seekerProfileId: seeker.seekerProfileId,
              userId: params.userId,
              delta: balanceAfter - before,
              balanceAfter,
              reason: params.reason,
              tier: seeker.tier,
              source: params.source ?? 'admin',
              metadata: { requestedDelta: params.delta, before, ...(params.metadata ?? {}) } as object,
            },
          });
          return { debited: before - balanceAfter, balanceAfter };
        });
        return result;
      } catch (e) {
        if (e instanceof Error && e.message === RETRY) continue;
        throw e;
      }
    }
    return null;
  } catch (err) {
    logger.warn('MOCK_CREDIT', 'adjustCredits failed', {
      userId: params.userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
