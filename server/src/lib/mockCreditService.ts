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
//
// Jobright clone (TASK_PLAN.md WP-21a; PRODUCT_PLAN.md §6.3):
//   • tier 'pro' is paid: its credits come from the plan (`grantForPlan` with
//     the plan catalog's practice allowance), never from the free monthly
//     grant. Quarterly plans ("3 per month, granted monthly") re-grant lazily
//     here on a new UTC month while the plan is live.
//   • A paid tier whose period has ended (an expired pass) is treated as free.
//   • Practice packs ADD credits that stay valid 12 months. Each pack is an
//     RACreditGrant row (bucket 'practice', reason 'pack'); plan credits are
//     spent before pack credits, so a plan grant (which SETS the balance, no
//     rollover) keeps the unspent pack credits on top, and an expired pack
//     removes only what is left of it.

import prisma from './prisma.js';
import { logger } from '../services/LoggerService.js';
import {
  getMockPlanCatalog,
  roundCreditsUp,
  creditsForMinutes,
  creditsForSeconds,
  type MockPlanKey,
} from './mockInterviewPlans.js';
import { PLAN_DEFINITIONS, isPlanKey, type PracticeAllowance } from '../platform/billing/planCatalog.js';
import { parseBrandId } from '../platform/brand/registry.js';

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
  planKey: string | null;
  status: string | null;
  brand: string | null;
  autoRenewing: boolean;
}

/** Paid practice tiers (legacy starter/growth and the clone's single paid tier). */
export function isPaidTier(tier: string | null | undefined): boolean {
  return tier === 'starter' || tier === 'growth' || tier === 'pro';
}

/** Statuses during which a paid plan still counts (past_due = Stripe is retrying). */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
/** An auto-renewing Stripe plan keeps counting this long past its period end while the renewal webhook lands. */
const RENEWAL_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/** Is the seeker's paid plan live at `now`? Legacy rows without a period end stay paid (old behaviour). */
export function paidPlanLive(
  sub: { tier: string; status: string | null; currentPeriodEnd: Date | null; autoRenewing: boolean },
  now: Date,
): boolean {
  if (!isPaidTier(sub.tier)) return false;
  if (sub.status && !LIVE_STATUSES.has(sub.status)) return false;
  if (!sub.currentPeriodEnd) return true;
  const grace = sub.autoRenewing ? RENEWAL_GRACE_MS : 0;
  return sub.currentPeriodEnd.getTime() + grace > now.getTime();
}

/** The practice allowance of an R-08 plan key (null for legacy keys and free). */
export function planPracticeAllowance(planKey: string | null | undefined, brand?: string | null): PracticeAllowance | null {
  if (!isPlanKey(planKey)) return null;
  const b = parseBrandId(brand) ?? 'roboapply';
  const def = PLAN_DEFINITIONS[b].find((d) => d.key === planKey) ?? PLAN_DEFINITIONS.roboapply.find((d) => d.key === planKey);
  return def?.practice ?? null;
}

// ─── Practice packs (RACreditGrant rows, bucket 'practice') ───────────────────

export const PRACTICE_PACK_BUCKET = 'practice';

export interface PackRow {
  id: string;
  remaining: number;
  expiresAt: Date | null;
}

/**
 * How much of each pack is still unspent, given the balance. Plan credits are
 * spent first and, among packs, the soonest-expiring first; so the unspent
 * pack total is min(sum of packs, balance), allocated to the latest-expiring
 * packs first.
 */
export function allocatePackRemaining(packs: readonly PackRow[], balance: number): Map<string, number> {
  const total = packs.reduce((n, p) => n + Math.max(0, p.remaining), 0);
  let left = Math.max(0, Math.min(total, balance));
  const order = [...packs].sort((a, b) => (b.expiresAt?.getTime() ?? Infinity) - (a.expiresAt?.getTime() ?? Infinity));
  const out = new Map<string, number>();
  for (const p of order) {
    const take = Math.min(Math.max(0, p.remaining), left);
    out.set(p.id, take);
    left -= take;
  }
  return out;
}

async function loadPacks(userId: string): Promise<PackRow[]> {
  try {
    return await prisma.rACreditGrant.findMany({
      where: { userId, bucket: PRACTICE_PACK_BUCKET, remaining: { gt: 0 } },
      select: { id: true, remaining: true, expiresAt: true },
    });
  } catch (err) {
    logger.warn('MOCK_CREDIT', 'pack lookup failed', { userId, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * Before a plan grant SETS the balance: the unspent credits of live packs,
 * which are carried on top. Rows are trimmed to what is really left.
 */
async function packCarryForGrant(userId: string, previousBalance: number, now: Date): Promise<number> {
  const packs = (await loadPacks(userId)).filter((p) => !p.expiresAt || p.expiresAt.getTime() > now.getTime());
  if (!packs.length) return 0;
  const alloc = allocatePackRemaining(packs, previousBalance);
  let carry = 0;
  for (const p of packs) {
    const eff = alloc.get(p.id) ?? 0;
    carry += eff;
    if (eff < p.remaining) {
      await prisma.rACreditGrant.updateMany({ where: { id: p.id, remaining: p.remaining }, data: { remaining: eff } }).catch(() => {});
    }
  }
  return carry;
}

/** Lazily remove what is left of expired packs from the balance. */
async function expirePacks(seeker: ResolvedSeeker, userId: string, now: Date): Promise<number> {
  const packs = await loadPacks(userId);
  const expired = packs.filter((p) => p.expiresAt && p.expiresAt.getTime() <= now.getTime());
  if (!expired.length) return seeker.mockCredits;
  const alloc = allocatePackRemaining(packs, seeker.mockCredits);
  let balance = seeker.mockCredits;
  for (const p of expired) {
    const claim = await prisma.rACreditGrant.updateMany({ where: { id: p.id, remaining: p.remaining }, data: { remaining: 0 } });
    if (claim.count !== 1) continue;
    const eff = alloc.get(p.id) ?? 0;
    if (eff > 0) {
      const res = await adjustCredits({ userId, delta: -eff, reason: 'expire', source: 'system', metadata: { packGrantId: p.id } });
      if (res) balance = res.balanceAfter;
    }
  }
  return balance;
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
      planKey: true,
      status: true,
      brand: true,
      stripeSubscriptionId: true,
      cancelAtPeriodEnd: true,
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
    planKey: sub.planKey ?? null,
    status: sub.status ?? null,
    brand: sub.brand ?? null,
    autoRenewing: Boolean(sub.stripeSubscriptionId) && !sub.cancelAtPeriodEnd,
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

  const now = new Date();
  // Expired practice packs leave the balance first (what is left of them).
  const balanceNow = await expirePacks(seeker, userId, now);
  if (balanceNow !== seeker.mockCredits) seeker.mockCredits = balanceNow;
  const live = paidPlanLive(seeker, now);

  // Lazy free-tier monthly re-grant: only when there is no live paid plan,
  // and only when the last grant was in a previous UTC month (or never). Paid
  // plans are granted by the payment/renewal path (and the quarterly monthly
  // re-grant below), never here.
  if (!live) {
    if (!sameUtcMonth(seeker.mockCreditsRenewedAt, now)) {
      const carry = await packCarryForGrant(userId, seeker.mockCredits, now);
      const target = freeCredits + carry;
      // CONDITIONAL claim: only the writer whose read still matches the stored
      // renewedAt wins (guards against two concurrent getBalance() calls both
      // granting + writing duplicate ledger rows at a month boundary). The
      // loser sees count===0 and falls through to read the granted balance.
      const claim = await prisma.seekerSubscription.updateMany({
        where: { id: seeker.subscriptionId, mockCreditsRenewedAt: seeker.mockCreditsRenewedAt },
        data: { mockCredits: target, mockCreditsRenewedAt: now, mockCreditsPeriodAllotment: freeCredits },
      });
      if (claim.count === 1) {
        await appendLedger({
          seekerProfileId: seeker.seekerProfileId,
          userId,
          delta: roundCreditsUp(target - seeker.mockCredits) || target - seeker.mockCredits,
          balanceAfter: target,
          reason: seeker.mockCreditsRenewedAt ? 'grant_free_monthly' : 'signup_bonus',
          tier: 'free',
          source: 'system',
          metadata: { previousBalance: seeker.mockCredits, packCarry: carry },
        });
      }
      // Whether we won or lost the race, the balance is now the free allotment.
      return {
        credits: target,
        tier: 'free',
        periodAllotment: freeCredits,
        renewedAt: now,
        currentPeriodEnd: seeker.currentPeriodEnd,
        ephemeral: false,
      };
    }
    return {
      credits: seeker.mockCredits,
      tier: 'free',
      periodAllotment: seeker.mockCreditsPeriodAllotment,
      renewedAt: seeker.mockCreditsRenewedAt,
      currentPeriodEnd: seeker.currentPeriodEnd,
      ephemeral: false,
    };
  }

  // Quarterly Pro ("3 per month, granted monthly"): re-grant on a new UTC month.
  const allowance = seeker.tier === 'pro' ? planPracticeAllowance(seeker.planKey, seeker.brand) : null;
  if (allowance?.per === 'month' && seeker.mockCreditsRenewedAt && !sameUtcMonth(seeker.mockCreditsRenewedAt, now)) {
    const carry = await packCarryForGrant(userId, seeker.mockCredits, now);
    const target = allowance.credits + carry;
    const claim = await prisma.seekerSubscription.updateMany({
      where: { id: seeker.subscriptionId, mockCreditsRenewedAt: seeker.mockCreditsRenewedAt },
      data: { mockCredits: target, mockCreditsRenewedAt: now, mockCreditsPeriodAllotment: allowance.credits },
    });
    if (claim.count === 1) {
      await appendLedger({
        seekerProfileId: seeker.seekerProfileId,
        userId,
        delta: target - seeker.mockCredits,
        balanceAfter: target,
        reason: 'grant_renewal',
        tier: seeker.tier,
        source: 'system',
        metadata: { previousBalance: seeker.mockCredits, planKey: seeker.planKey, monthly: true, packCarry: carry },
      });
    }
    return {
      credits: target,
      tier: seeker.tier,
      periodAllotment: allowance.credits,
      renewedAt: now,
      currentPeriodEnd: seeker.currentPeriodEnd,
      ephemeral: false,
    };
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

/** Paid tiers grantForPlan accepts: legacy practice plans and the clone's Pro tier. */
export type GrantTier = MockPlanKey | 'pro';

export async function grantForPlan(params: {
  userId: string;
  tier: GrantTier;
  /** Allotment override (Pro plans: the plan catalog's practice allowance). Legacy tiers read the mock-plan catalog. */
  credits?: number;
  reason: Extract<CreditLedgerReason, 'grant_purchase' | 'grant_renewal'>;
  source: string; // 'stripe' | 'alipay' | 'wechatpay'
  currentPeriodEnd?: Date | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    const catalog = await getMockPlanCatalog();
    const allotment =
      typeof params.credits === 'number' && params.credits >= 0
        ? params.credits
        : params.tier === 'pro'
          ? 0
          : (catalog.plans[params.tier]?.credits ?? 0);
    const seeker = await resolveSeeker(params.userId);
    if (!seeker) {
      logger.warn('MOCK_CREDIT', 'grantForPlan skipped — no seeker profile', { userId: params.userId, tier: params.tier });
      return;
    }
    const now = new Date();
    // Unspent practice-pack credits ride on top of the plan allotment.
    const carry = await packCarryForGrant(params.userId, seeker.mockCredits, now);
    const balanceAfter = allotment + carry;
    await prisma.seekerSubscription.update({
      where: { id: seeker.subscriptionId },
      data: {
        mockCredits: balanceAfter,
        mockCreditsRenewedAt: now,
        mockCreditsPeriodAllotment: allotment,
        ...(params.currentPeriodEnd !== undefined ? { currentPeriodEnd: params.currentPeriodEnd } : {}),
      },
    });
    await appendLedger({
      seekerProfileId: seeker.seekerProfileId,
      userId: params.userId,
      delta: balanceAfter - seeker.mockCredits,
      balanceAfter,
      reason: params.reason,
      tier: params.tier,
      source: params.source,
      metadata: { previousBalance: seeker.mockCredits, allotment, packCarry: carry, ...(params.metadata ?? {}) },
    });
    logger.info('MOCK_CREDIT', 'credits granted', {
      userId: params.userId,
      tier: params.tier,
      reason: params.reason,
      allotment,
      packCarry: carry,
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
  tier: GrantTier;
  /** Allotment override (Pro plans). */
  credits?: number;
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
    credits: params.credits,
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
