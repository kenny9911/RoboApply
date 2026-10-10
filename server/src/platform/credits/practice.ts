// server/src/platform/credits/practice.ts
//
// The `practice` bucket (TASK_PLAN.md §4.1.f, R-07): practice interview
// credits stay in `mockCreditService` (SeekerSubscription.mockCredits +
// MockInterviewCreditLedger; 1 credit = RA_MOCK_CREDIT_MINUTES minutes). This
// module wraps it without editing it and adds what it lacks: an idempotency
// key per grant, so "1 credit after email verification" or "1 for finishing
// the checklist" can be called from any retrying code path and still grant
// once.
//
// Idempotency uses the RACreditLedger unique key ('<userId>:practice:<key>'):
//   claim (insert reserved) → mockCreditService.adjustCredits(+n) → settle
//   committed (granted) or released (failed; a retry may grant again).
// A crash between the adjust and the settle leaves the row `reserved`; it is
// never auto-released (CreditService.releaseStale skips practice rows), so a
// grant happens at most once per key.

import { logger } from '../../services/LoggerService.js';
import type { CreditStore } from './store.js';
import { SETTLE_BUDGET_MS, SETTLE_TX_LIMITS, createPrismaCreditStore, retryWhenBusy } from './store.js';

export type PracticeGrantReason =
  | 'email_verified'
  | 'phone_verified'
  | 'checklist_complete'
  | 'referral'
  | 'compensation'
  | 'admin'
  /** A purchased practice pack (platform/billing/packs.ts; key = the order / checkout session). */
  | 'pack_purchase';

export type PracticeGrantStatus = 'granted' | 'already_granted' | 'in_progress' | 'no_profile' | 'failed';

export interface PracticeGrantResult {
  status: PracticeGrantStatus;
  ledgerId: string | null;
  balanceAfter: number | null;
}

export interface PracticeBalance {
  credits: number;
  tier: string;
  periodAllotment: number | null;
  renewedAt: Date | null;
}

export interface PracticeDeps {
  store?: CreditStore;
  /** mockCreditService.adjustCredits (+delta). Null result = no seeker profile or failure. */
  adjust?: (input: { userId: string; delta: number; metadata: Record<string, unknown> }) => Promise<{ balanceAfter: number } | null>;
  hasSeekerProfile?: (userId: string) => Promise<boolean>;
  getBalance?: (userId: string) => Promise<PracticeBalance>;
  now?: () => Date;
}

const defaultAdjust: NonNullable<PracticeDeps['adjust']> = async (input) => {
  const mock = await import('../../lib/mockCreditService.js');
  // adjustCredits accepts 'refund' | 'admin_adjust' | 'expire'; grants made here
  // are system grants, recorded as admin_adjust with source 'system' and the
  // real reason in metadata.
  const res = await mock.adjustCredits({ userId: input.userId, delta: input.delta, reason: 'admin_adjust', source: 'system', metadata: input.metadata });
  return res ? { balanceAfter: res.balanceAfter } : null;
};

const defaultHasSeekerProfile: NonNullable<PracticeDeps['hasSeekerProfile']> = async (userId) => {
  const { default: prisma } = await import('../../lib/prisma.js');
  const row = await prisma.seekerProfile.findUnique({ where: { userId }, select: { id: true } });
  return !!row;
};

const defaultGetBalance: NonNullable<PracticeDeps['getBalance']> = async (userId) => {
  const mock = await import('../../lib/mockCreditService.js');
  const b = await mock.getBalance(userId);
  return { credits: b.credits, tier: b.tier, periodAllotment: b.periodAllotment, renewedAt: b.renewedAt };
};

export interface PracticeCredits {
  grantPracticeCredit(
    userId: string,
    reason: PracticeGrantReason,
    idempotencyKey: string,
    options?: { credits?: number },
  ): Promise<PracticeGrantResult>;
  getPracticeBalance(userId: string): Promise<PracticeBalance>;
}

export function createPracticeCredits(deps: PracticeDeps = {}): PracticeCredits {
  const store = deps.store ?? createPrismaCreditStore(async () => (await import('../../lib/prisma.js')).default);
  const adjust = deps.adjust ?? defaultAdjust;
  const hasSeekerProfile = deps.hasSeekerProfile ?? defaultHasSeekerProfile;
  const getBalance = deps.getBalance ?? defaultGetBalance;
  const now = deps.now ?? (() => new Date());

  return {
    async grantPracticeCredit(userId, reason, idempotencyKey, options = {}) {
      const key = idempotencyKey.trim();
      if (!key) throw new Error('grantPracticeCredit needs an idempotency key');
      const credits = Math.max(1, Math.floor(options.credits ?? 1));
      if (!(await hasSeekerProfile(userId))) return { status: 'no_profile', ledgerId: null, balanceAfter: null };
      const fullKey = `${userId}:practice:${key}`;

      const claim = await store.transaction(async (tx) => {
        const id = await tx.insertLedger({
          userId,
          bucket: 'practice',
          amount: credits,
          status: 'reserved',
          fromSource: 'mock_credit',
          windowKey: null,
          idempotencyKey: fullKey,
          refType: 'practice_grant',
          refId: reason,
          sku: null,
          now: now(),
        });
        if (id) return { id, state: 'claimed' as const };
        const existing = await tx.findLedgerByKey(fullKey);
        if (!existing) throw new Error('practice ledger conflict without a row');
        if (existing.status === 'committed') return { id: existing.id, state: 'committed' as const };
        if (existing.status === 'reserved') return { id: existing.id, state: 'reserved' as const };
        const rearmed = await tx.rearmLedger(existing.id, { amount: credits, windowKey: null });
        return { id: existing.id, state: rearmed ? ('claimed' as const) : ('reserved' as const) };
      });
      if (claim.state === 'committed') return { status: 'already_granted', ledgerId: claim.id, balanceAfter: null };
      if (claim.state === 'reserved') return { status: 'in_progress', ledgerId: claim.id, balanceAfter: null };

      let result: { balanceAfter: number } | null = null;
      try {
        result = await adjust({ userId, delta: credits, metadata: { grantReason: reason, idempotencyKey: key, ledgerId: claim.id } });
      } catch (err) {
        logger.warn('CREDITS', 'practice grant failed', { userId, reason, error: err instanceof Error ? err.message : String(err) });
        result = null;
      }
      try {
        // Safe to repeat: only a `reserved` row is settled. The grant itself
        // is already decided, so this gets short limits and a time budget.
        await retryWhenBusy(
          () => store.transaction((tx) => tx.settleLedger(claim.id, result ? 'committed' : 'released', now()), SETTLE_TX_LIMITS),
          undefined,
          { budgetMs: SETTLE_BUDGET_MS },
        );
      } catch (err) {
        // The claim row stays `reserved` (never auto-released), so the key
        // cannot grant twice. A credit that was added is still reported as
        // granted; a failed grant is reported as failed.
        logger.error('CREDITS', 'practice grant: could not settle the claim', {
          userId,
          reason,
          ledgerId: claim.id,
          granted: !!result,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!result) return { status: 'failed', ledgerId: claim.id, balanceAfter: null };
      logger.info('CREDITS', 'practice credit granted', { userId, reason, credits });
      return { status: 'granted', ledgerId: claim.id, balanceAfter: result.balanceAfter };
    },
    getPracticeBalance: (userId) => getBalance(userId),
  };
}

const practice = createPracticeCredits();

/** Grant practice interview credits once per idempotency key (WP-10 email verify, WP-11 phone verify, WP-23 checklist). */
export const grantPracticeCredit = practice.grantPracticeCredit;
/** Current practice credit balance (mockCreditService; lazily applies the free monthly grant). */
export const getPracticeBalance = practice.getPracticeBalance;
