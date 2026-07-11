/**
 * matchBilling — single source of truth for full / deep resume-match quota.
 *
 * Rule (see docs/prd-resume-match-quota-rule.md):
 *   - One full match = one (resume, jd) pair = exactly one credit.
 *   - The user is charged AFTER `ResumeMatchAgent.match()` returns a
 *     successfully parsed MatchResult. Failures (LLM error, parse error,
 *     timeout, abort, gate refusal) cost the user zero.
 *   - All match-quota mutations go through `commitMatchUsage`. No other
 *     code mutates `User.resumeMatchesUsed` for the `match` SKU.
 *
 * Three primitives:
 *   - gateMatchUsage(ctx, count?) — pre-flight refusal (no debit)
 *   - commitMatchUsage(ctx)       — atomic post-success debit
 *   - runMatchWithQuota(input,ctx) — gate → run → commit-on-success
 *
 * Out of scope: reverse match (JobFitAgent), screening (BatchScreenSkill),
 * agent-sourcing (services/sources/llmMatcher.ts) — those have their own
 * billing or are intentionally free.
 */

import prisma from './prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import { resumeMatchAgent, ResumeMatchParseError } from '../agents/ResumeMatchAgent.js';
import * as OverageBilling from '../services/OverageBillingService.js';
import { peekBatchUsage, getPlanLimits } from '../middleware/usageMeter.js';
import { logger } from '../services/LoggerService.js';
import { wasByokInRequest } from './requestContext.js';
import { evaluateSubscriptionGate } from './subscriptionGate.js';
import { resolveGraceDaysForUser } from './subscriptionGraceConfig.js';
import { reconcileMatchResult } from './matchScoreReconcile.js';
import type { MatchResult, MatchResumeRequest } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MatchBillingContext = {
  userId: string;
  /**
   * Optional API key id (rh_...) that authenticated the request which
   * triggered this match. Threaded onto the UsageDeductionLog row so
   * finance can bill match credits per API key, not just per user. Null
   * for cookie/JWT (UI) flows and internal contexts (cron, sourcing).
   */
  apiKeyId?: string | null;
  /**
   * Optional request-level id used for idempotency on the overage path.
   * Two commits with the same requestId for the same user/sku will only
   * debit once (OverageBillingService.charge is idempotent on this key).
   */
  requestId?: string | null;
  /**
   * Optional related entity for the audit log (UsageDeductionLog row).
   * E.g. ('resume', '<resumeId>') or ('job', '<jobId>'). Combined with
   * `metadata` to give finance ops everything they need to answer
   * "what did this credit pay for?".
   */
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  /**
   * Free-form metadata persisted on the UsageDeductionLog row.
   * Use sparingly — promote to a typed column if a field is queried often.
   */
  metadata?: Record<string, unknown> | null;
  /**
   * User-selected UI locale (e.g. 'zh', 'zh-TW', 'ja'). Not a billing
   * field — `runMatchWithQuota` threads it into `resumeMatchAgent.match`
   * so every section of the MatchResult is written in the user's selected
   * language instead of the resume/JD's dominant language. Omit for
   * cron/internal contexts (output falls back to JD auto-detection).
   */
  locale?: string | null;
};

export type GateResult =
  | { ok: true; planRemaining: number; pricePerUnit: number }
  | {
      ok: false;
      code: 'USER_NOT_FOUND' | 'SUBSCRIPTION_INACTIVE' | 'USAGE_LIMIT_EXCEEDED' | 'INSUFFICIENT_BALANCE';
      error: string;
      details?: Record<string, unknown>;
    };

export type CommitOutcome =
  | { ok: true; source: 'plan'; planUnits: 1; topUpUnits: 0; topUpCost: 0 }
  | {
      ok: true;
      source: 'overage';
      planUnits: 0;
      topUpUnits: 1;
      topUpCost: number; // in minor units (cents/fen) for the user's market
      currency: string;
      chargeId: string;
    }
  | {
      // BYOK — the user routed this match through their own LLM key, so
      // the platform pays nothing and the user's plan/wallet is not
      // touched. We still write a UsageDeductionLog row with source='byok'
      // for forensic visibility.
      ok: true;
      source: 'byok';
      planUnits: 0;
      topUpUnits: 0;
      topUpCost: 0;
    }
  | {
      ok: false;
      code:
        | 'USER_NOT_FOUND'
        | 'SUBSCRIPTION_INACTIVE'
        | 'OVERAGE_DISABLED'
        | 'OVERAGE_INSUFFICIENT_BALANCE'
        | 'OVERAGE_MONTHLY_CAP'
        | 'OVERAGE_RATE_MISSING'
        | 'OVERAGE_TX_FAILED';
      error: string;
      details?: Record<string, unknown>;
    };

export class MatchQuotaExhaustedError extends Error {
  readonly code: GateResult extends { ok: false; code: infer C } ? C : never;
  readonly details?: Record<string, unknown>;
  constructor(gate: Extract<GateResult, { ok: false }>) {
    super(gate.error);
    this.name = 'MatchQuotaExhaustedError';
    // @ts-expect-error narrowed at runtime
    this.code = gate.code;
    this.details = gate.details;
  }
}

// ---------------------------------------------------------------------------
// gateMatchUsage — pre-flight refusal. Never debits.
// ---------------------------------------------------------------------------

/**
 * Refuses a request that has zero plan quota AND zero usable wallet
 * balance to cover at least `count` matches. Safe to call N times — it
 * is a pure read.
 *
 * Use case: short-circuit a doomed batch BEFORE paying the LLM cost.
 * For batches, pass the full batch size; the gate will say "you have
 * room for 30 of 100 — ok to start". Per-resume gates inside the loop
 * are not necessary because `commitMatchUsage` itself is the safe
 * stopping point.
 */
export async function gateMatchUsage(
  ctx: MatchBillingContext,
  count: number = 1,
): Promise<GateResult> {
  // BYOK fast-path: if the user has ANY active BYOK key, pass the gate
  // unconditionally. The actual decision (was THIS match BYOK or not?)
  // is deferred to commitMatchUsage, which reads requestContext after
  // the LLM call. Risk: a user with BYOK Anthropic but a call that
  // routes to platform OpenAI gets a free pass at the gate; commit
  // will then debit normally. Acceptable — the gate is an upper-bound
  // refusal, not a precise bill. See docs/prd-byok.md §6.
  const hasByok = await prisma.userLLMKey.findFirst({
    where: { userId: ctx.userId, isActive: true },
    select: { id: true },
  });
  if (hasByok) {
    return { ok: true, planRemaining: Number.POSITIVE_INFINITY, pricePerUnit: 0 };
  }

  const peek = await peekBatchUsage(ctx.userId, 'match', count);
  if (!peek.ok) {
    return { ok: false, code: peek.code, error: peek.error, details: peek.details };
  }
  return {
    ok: true,
    planRemaining: peek.snapshot.remainingQuota,
    pricePerUnit: peek.snapshot.pricePerUnit,
  };
}

// ---------------------------------------------------------------------------
// commitMatchUsage — atomic post-success debit. Idempotent on requestId.
// ---------------------------------------------------------------------------

/**
 * Debit ONE successful match. Increments `resumeMatchesUsed` by 1; if
 * the user is over plan quota, also charges one unit from the wallet
 * via `OverageBillingService.charge` (which writes the immutable
 * ledger row and respects per-user overage prefs).
 *
 * Idempotent on `ctx.requestId` for the overage path. The plan-quota
 * counter increment is NOT idempotent — but the canonical caller
 * (`runMatchWithQuota`) only commits once per LLM run, so this is safe
 * in practice. If you need stricter idempotency, route the commit
 * through OverageBillingService unconditionally (rate=0 admin override)
 * and rely on its requestId-keyed dedup.
 *
 * Throws nothing; returns a discriminated result. Hard wallet failures
 * (ran out of balance after gate, monthly cap reached mid-stream) are
 * surfaced in the result so the caller can log + still return the LLM
 * output. We do NOT rollback the LLM work on a billing miss — the
 * inverse (delete a successful match because billing failed) is worse
 * than a logged unbilled match.
 */
export async function commitMatchUsage(
  ctx: MatchBillingContext,
): Promise<CommitOutcome> {
  // BYOK short-circuit: when the LLM call that produced this match was
  // routed through the user's own key (LLMService set the request flag
  // after a successful BYOK provider call), the platform paid nothing
  // and the user's plan / wallet must not be touched. We still write a
  // forensic UsageDeductionLog row so admin can see how many BYOK
  // matches happened. See docs/prd-byok.md.
  if (wasByokInRequest()) {
    await writeDeductionLog({
      userId: ctx.userId,
      apiKeyId: ctx.apiKeyId ?? null,
      sku: 'resume_match',
      source: 'byok',
      tierAtCommit: null,
      usedBefore: null,
      usedAfter: null,
      limitAtCommit: null,
      costMinor: 0,
      currency: null,
      requestId: ctx.requestId ?? null,
      relatedEntityType: ctx.relatedEntityType ?? null,
      relatedEntityId: ctx.relatedEntityId ?? null,
      metadata: { ...(ctx.metadata ?? {}), byok: true },
    });
    return { ok: true, source: 'byok', planUnits: 0, topUpUnits: 0, topUpCost: 0 };
  }

  const fresh = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: {
      subscriptionTier: true,
      subscriptionStatus: true,
      resumeMatchesUsed: true,
      customMaxMatches: true,
      topUpBalance: true,
      currentPeriodEnd: true,
      subscriptionGraceDays: true,
      role: true,
    },
  });
  if (!fresh) {
    return { ok: false, code: 'USER_NOT_FOUND', error: 'User not found' };
  }

  const tier = (fresh.subscriptionTier || 'free').toLowerCase();
  const status = fresh.subscriptionStatus;
  // Grace-aware subscription block: a lapsed/past-due paid user keeps
  // consuming (usage counts) until the grace window closes; only THEN are
  // they blocked unless they still have top-up balance. In-grace ⇒ not
  // locked ⇒ falls through to the plan-quota path below. See subscriptionGate.ts.
  const gate = evaluateSubscriptionGate({
    subscriptionTier: tier,
    subscriptionStatus: status,
    currentPeriodEnd: fresh.currentPeriodEnd,
    isActive: true,
    role: fresh.role,
    graceDays: await resolveGraceDaysForUser(fresh.subscriptionGraceDays),
  });
  if (gate.locked && fresh.topUpBalance <= 0) {
    return {
      ok: false,
      code: 'SUBSCRIPTION_INACTIVE',
      error: 'Your subscription is inactive.',
    };
  }

  const planLimits = await getPlanLimits();
  const limits = planLimits[tier] || planLimits.free;
  const limit = fresh.customMaxMatches ?? limits.matches;
  const used = fresh.resumeMatchesUsed;

  // ── Plan-quota path: cheapest, most common.
  if (used < limit) {
    await prisma.user.update({
      where: { id: ctx.userId },
      data: { resumeMatchesUsed: { increment: 1 } },
    });
    await writeDeductionLog({
      userId: ctx.userId,
      apiKeyId: ctx.apiKeyId ?? null,
      sku: 'resume_match',
      source: 'plan',
      tierAtCommit: tier,
      usedBefore: used,
      usedAfter: used + 1,
      limitAtCommit: Number.isFinite(limit) ? limit : null,
      requestId: ctx.requestId ?? null,
      metadata: ctx.metadata ?? null,
      relatedEntityType: ctx.relatedEntityType ?? null,
      relatedEntityId: ctx.relatedEntityId ?? null,
    });
    return { ok: true, source: 'plan', planUnits: 1, topUpUnits: 0, topUpCost: 0 };
  }

  // ── Overage path: delegate to the multi-currency ledger service. The
  // counter still increments so admin analytics keep working — same
  // convention as the legacy `checkUsageLimit` middleware.
  const result = await OverageBilling.charge({
    userId: ctx.userId,
    sku: 'resume_match',
    requestId: ctx.requestId ?? null,
  });

  if (result.charged) {
    await prisma.user.update({
      where: { id: ctx.userId },
      data: { resumeMatchesUsed: { increment: 1 } },
    });
    await writeDeductionLog({
      userId: ctx.userId,
      apiKeyId: ctx.apiKeyId ?? null,
      sku: 'resume_match',
      source: 'overage',
      tierAtCommit: tier,
      usedBefore: used,
      usedAfter: used + 1,
      limitAtCommit: Number.isFinite(limit) ? limit : null,
      costMinor: result.amountMinor ?? null,
      currency: (result.currency ?? null) as string | null,
      overageChargeId: result.chargeId ?? null,
      requestId: ctx.requestId ?? null,
      metadata: ctx.metadata ?? null,
      relatedEntityType: ctx.relatedEntityType ?? null,
      relatedEntityId: ctx.relatedEntityId ?? null,
    });
    return {
      ok: true,
      source: 'overage',
      planUnits: 0,
      topUpUnits: 1,
      topUpCost: result.amountMinor ?? 0,
      currency: (result.currency ?? 'USD') as string,
      chargeId: result.chargeId ?? '',
    };
  }

  // ── Overage was refused by the wallet (insufficient / disabled / cap).
  // We do NOT rollback the LLM work — the result has already been
  // computed by the caller. We surface the failure so the caller can
  // log + alert; user gets the result anyway.
  const code = mapBlockedReasonToCode(result.blockedReason);
  return {
    ok: false,
    code,
    error: humanizeBlockedReason(result.blockedReason),
    details: {
      blockedReason: result.blockedReason,
      tier,
      used,
      limit,
    },
  };
}

function mapBlockedReasonToCode(
  reason: OverageBilling.ChargeResult['blockedReason'],
): Extract<CommitOutcome, { ok: false }>['code'] {
  switch (reason) {
    case 'insufficient_balance': return 'OVERAGE_INSUFFICIENT_BALANCE';
    case 'monthly_cap_reached':  return 'OVERAGE_MONTHLY_CAP';
    case 'overage_disabled':
    case 'free_tier_no_overage': return 'OVERAGE_DISABLED';
    case 'rate_not_configured':  return 'OVERAGE_RATE_MISSING';
    case 'user_not_found':       return 'USER_NOT_FOUND';
    default:                     return 'OVERAGE_TX_FAILED';
  }
}

function humanizeBlockedReason(
  reason: OverageBilling.ChargeResult['blockedReason'],
): string {
  switch (reason) {
    case 'insufficient_balance': return 'Wallet balance ran out before this match could be billed.';
    case 'monthly_cap_reached':  return 'Monthly overage cap reached.';
    case 'overage_disabled':     return 'Overage is disabled on this account.';
    case 'free_tier_no_overage': return 'Free tier accounts cannot accrue overage.';
    case 'rate_not_configured':  return 'No overage rate is configured for this account.';
    case 'user_not_found':       return 'User not found.';
    default:                     return 'Overage transaction failed.';
  }
}

// ---------------------------------------------------------------------------
// commitInterviewUsage — atomic post-success debit for the interview SKU.
// ---------------------------------------------------------------------------
//
// Mirror of commitMatchUsage for `interview`. Use it from SUCCESS-ONLY invite
// paths — i.e. where the GoHire send + Interview row already succeeded and we
// must record exactly one interview unit (counter + ledger). The HTTP request
// invite paths (/invite-candidate, /batch-invite, batch-invite-from-library,
// apply-invite) keep using the debit-before-send middleware
// (checkUsageLimit('interview') / checkBatchUsage) — that is the established
// convention. AutoPilot auto-invite is the canonical caller here: it runs in a
// cron/background context (no req/res, apiKeyId=null) and must not over-charge
// on a GoHire send that fails AFTER a debit, so it gates with a pre-send peek
// and commits here only once the send + persist succeed.
//
// Like commitMatchUsage, this NEVER throws — it returns a discriminated
// outcome. A post-gate wallet race (caller already sent the invite) surfaces
// as { ok:false } so the caller can log + reconcile without discarding the
// already-delivered invite.
export type InterviewBillingContext = {
  userId: string;
  apiKeyId?: string | null;
  requestId?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export async function commitInterviewUsage(
  ctx: InterviewBillingContext,
): Promise<CommitOutcome> {
  const fresh = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: {
      subscriptionTier: true,
      subscriptionStatus: true,
      interviewsUsed: true,
      customMaxInterviews: true,
      topUpBalance: true,
      currentPeriodEnd: true,
      subscriptionGraceDays: true,
      role: true,
    },
  });
  if (!fresh) {
    return { ok: false, code: 'USER_NOT_FOUND', error: 'User not found' };
  }

  const tier = (fresh.subscriptionTier || 'free').toLowerCase();
  // Grace-aware subscription block: identical semantics to commitMatchUsage —
  // an in-grace lapsed/past-due paid user keeps consuming until grace closes.
  const gate = evaluateSubscriptionGate({
    subscriptionTier: tier,
    subscriptionStatus: fresh.subscriptionStatus,
    currentPeriodEnd: fresh.currentPeriodEnd,
    isActive: true,
    role: fresh.role,
    graceDays: await resolveGraceDaysForUser(fresh.subscriptionGraceDays),
  });
  if (gate.locked && fresh.topUpBalance <= 0) {
    return {
      ok: false,
      code: 'SUBSCRIPTION_INACTIVE',
      error: 'Your subscription is inactive.',
    };
  }

  const planLimits = await getPlanLimits();
  const limits = planLimits[tier] || planLimits.free;
  const limit = fresh.customMaxInterviews ?? limits.interviews;
  const used = fresh.interviewsUsed;

  // ── Plan-quota path.
  if (used < limit) {
    await prisma.user.update({
      where: { id: ctx.userId },
      data: { interviewsUsed: { increment: 1 } },
    });
    await writeDeductionLog({
      userId: ctx.userId,
      apiKeyId: ctx.apiKeyId ?? null,
      sku: 'interview',
      source: 'plan',
      tierAtCommit: tier,
      usedBefore: used,
      usedAfter: used + 1,
      limitAtCommit: Number.isFinite(limit) ? limit : null,
      requestId: ctx.requestId ?? null,
      relatedEntityType: ctx.relatedEntityType ?? null,
      relatedEntityId: ctx.relatedEntityId ?? null,
      metadata: ctx.metadata ?? null,
    });
    return { ok: true, source: 'plan', planUnits: 1, topUpUnits: 0, topUpCost: 0 };
  }

  // ── Overage path — delegate to the multi-currency ledger service.
  const result = await OverageBilling.charge({
    userId: ctx.userId,
    sku: 'interview',
    requestId: ctx.requestId ?? null,
  });

  if (result.charged) {
    await prisma.user.update({
      where: { id: ctx.userId },
      data: { interviewsUsed: { increment: 1 } },
    });
    await writeDeductionLog({
      userId: ctx.userId,
      apiKeyId: ctx.apiKeyId ?? null,
      sku: 'interview',
      source: 'overage',
      tierAtCommit: tier,
      usedBefore: used,
      usedAfter: used + 1,
      limitAtCommit: Number.isFinite(limit) ? limit : null,
      costMinor: result.amountMinor ?? null,
      currency: (result.currency ?? null) as string | null,
      overageChargeId: result.chargeId ?? null,
      requestId: ctx.requestId ?? null,
      relatedEntityType: ctx.relatedEntityType ?? null,
      relatedEntityId: ctx.relatedEntityId ?? null,
      metadata: ctx.metadata ?? null,
    });
    return {
      ok: true,
      source: 'overage',
      planUnits: 0,
      topUpUnits: 1,
      topUpCost: result.amountMinor ?? 0,
      currency: (result.currency ?? 'USD') as string,
      chargeId: result.chargeId ?? '',
    };
  }

  // Overage refused (insufficient / disabled / cap). Do NOT discard the
  // already-sent invite — surface the failure for ops to reconcile.
  const code = mapBlockedReasonToCode(result.blockedReason);
  return {
    ok: false,
    code,
    error: humanizeBlockedReason(result.blockedReason),
    details: { blockedReason: result.blockedReason, tier, used, limit },
  };
}

// ---------------------------------------------------------------------------
// runMatchWithQuota — gate → run → commit-on-success
// ---------------------------------------------------------------------------

/**
 * The canonical full-match entry point. Preferred over calling
 * `resumeMatchAgent.match()` directly when a per-user credit applies.
 *
 *   1. Gate (pre-flight, no debit). Throws MatchQuotaExhaustedError if
 *      the user has no plan room AND no wallet balance.
 *   2. Run the agent.
 *   3. On success → commitMatchUsage. On failure → no commit.
 *
 * Errors propagate so callers can distinguish "quota exhausted" (no
 * charge, soft refusal) from "match failed after run" (no charge,
 * retry-eligible) from generic failures.
 *
 * If you have a multi-step orchestration (e.g. skill decomposition),
 * call `gateMatchUsage` once up front, do the multi-step work yourself,
 * and call `commitMatchUsage` exactly once at the end after the merged
 * result is ready.
 */
export async function runMatchWithQuota(
  input: MatchResumeRequest,
  ctx: MatchBillingContext,
): Promise<MatchResult> {
  const gate = await gateMatchUsage(ctx, 1);
  if (!gate.ok) {
    throw new MatchQuotaExhaustedError(gate);
  }

  // Run the agent. Any throw here (LLM error, parse error, timeout,
  // abort) skips the commit — user pays nothing.
  const result = await resumeMatchAgent.match(
    input,
    ctx.requestId ?? undefined,
    undefined,
    ctx.locale ?? undefined,
  );

  // Deterministic backstop (design-spec-match-pass-standard-v3 §5):
  // disqualification clamp + frozen-band grade consistency + rubricVersion
  // stamp. Runs BEFORE the commit so billing semantics are unchanged.
  reconcileMatchResult(result, { requestId: ctx.requestId, source: 'runMatchWithQuota', strictness: input.strictness });

  // Success path. Commit exactly once.
  const commit = await commitMatchUsage(ctx);
  if (!commit.ok) {
    // The match succeeded but billing missed (race / cap / disabled
    // mid-stream). Log loudly so ops can reconcile. We still return
    // the result — it's already computed and the user expects it.
    logger.error('MATCH_BILLING', 'commit_after_gate_failed', {
      userId: ctx.userId,
      requestId: ctx.requestId,
      code: commit.code,
      details: commit.details,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Re-export ResumeMatchParseError so call sites can branch on parse
// failures without importing the agent module directly. Keeps the
// "go through matchBilling" discipline visible.
// ---------------------------------------------------------------------------
export { ResumeMatchParseError };

// ---------------------------------------------------------------------------
// writeDeductionLog — shared helper used by every SKU's commit path.
// ---------------------------------------------------------------------------
//
// Append-only insert into UsageDeductionLog. Failures are logged but
// non-fatal: the actual quota counter has already been mutated, and
// losing one audit row (e.g. transient DB hiccup) is preferable to
// rolling back a successful match / interview / Alex turn.
//
// Exported so the interview SKU (middleware/usageMeter.ts) and Agent
// Alex paths (middleware/requestAudit.ts, index.ts WS) can write rows
// using the same shape. Keep the field set in sync with the
// `UsageDeductionLog` Prisma model (backend/prisma/schema.prisma).
//
// See docs/prd-resume-match-quota-rule.md.

export type DeductionSku =
  | 'resume_match'
  | 'interview'
  // Real-time AI mock interview (Interview Engine — /mock-interview, LiveKit
  // voice/video). Cost-metered per session: LLM tokens (blueprint + live worker
  // + report evaluation) + STT/TTS audio + wall-clock minutes, summed to a USD
  // cost. Written by interview-engine/billing/sessionCost.ts. The cost→credit /
  // monthly-limit deduction is applied later when the pricing plan is set; this
  // row is the forensic cost record in the meantime (metadata.pricingPending).
  | 'mock_interview'
  | 'evaluation_share'
  | 'agent_alex_text'
  | 'agent_alex_voice'
  // Bulk Hiring ("Alan") chat turn (/api/v1/alan/chat/stream). One row per turn
  // capturing real LLM cost (chat stream + market-intel/feasibility subagents +
  // suggestion gen, all on Opus 4.8). The prepaid-credit charge itself (1 credit
  // = 5 sessions, 0.2/session) is debited once per NEW session and audited in
  // AlanCreditLedger; this row's metadata.creditsCharged mirrors that on the
  // session-creating turn. Written by routes/alan.ts via AlanCreditService.
  | 'alan_chat'
  | 'storage_upload'
  // Seeker SKUs (job-seeker app, /api/v1/seeker/*) — see
  // backend/src/seeker/lib/seekerBilling.ts.
  | 'seeker_profile_video'
  | 'seeker_application'
  | 'seeker_resume_refinement'
  | 'seeker_mock_interview'
  // V1 seeker SKUs added per CTO decision P1 (docs/job-seeker/06-cto-decisions.md).
  // Some of these alias the older `seeker_application` / `seeker_resume_refinement`
  // / `seeker_mock_interview` names — quota gating still reads the canonical
  // SKU for back-compat, but commit-on-success writers MAY use the new SKU
  // name. `seeker_match` is purely an audit row (no quota; matching is free).
  | 'seeker_tailor'
  | 'seeker_apply'
  | 'seeker_match'
  | 'seeker_mock'
  | 'seeker_coach_text'
  | 'seeker_negotiation'
  | 'seeker_interview_planner'
  // RoboApply SKUs — see backend/src/roboapply/. All are audit-only debits
  // (no quota gate at this SKU level — the underlying `resume_match` and
  // `seeker_apply` SKUs gate, and RoboApply itself caps by tier-daily-cap on
  // the mission row). docs/roboapply/02-architecture.md §9.
  | 'roboapply_intent'         // Sonnet intent parse (~$0.005/call)
  | 'roboapply_cover_letter'   // Opus 4.7 cover letter author (Sonnet for Free tier)
  | 'roboapply_digest'         // Sonnet morning-digest narrator
  // RoboApply V2 SKUs — candidate-facing companion product. All are
  // audit-only debits (V2 agents call `writeDeductionLog` directly; the
  // route layer enforces tier caps + rate limits where applicable).
  // See docs/roboapply/v2/04-backend-spec.md §7.
  | 'ra_match_score'           // RAJobMatchScorerAgent — Sonnet, ~$0.02/call
  | 'ra_keyword_extract'       // RAKeywordExtractorAgent — Haiku, ~$0.001/call
  | 'ra_resume_tailor'         // RAResumeTailorAgent — Sonnet/Opus, $0.03/$0.18
  | 'ra_cover_letter'          // RACoverLetterAgent — Opus/Sonnet, $0.15/$0.03
  | 'ra_insight'               // RACareerInsightAgent — Sonnet, ~$0.015/call
  | 'ra_jd_parse'              // RAJDParseAgent — Sonnet, ~$0.01/call (V2.1)
  | 'ra_onboarding_turn'       // Onboarding-chat turn (Haiku extract + Sonnet stream) — success-only, ~$0.015/turn
  | 'ra_crossbank_score'       // Cross-bank search — RAJobMatchScorerAgent per (resume,bank-job) pair — Sonnet, ~$0.018/call (audit-only, free_tier)
  | 'ra_crossbank_insight';    // Cross-bank search — RACrossBankInsightAgent portfolio narrative — Sonnet, ~$0.01/call (audit-only, free_tier)

export type DeductionSource = 'plan' | 'overage' | 'free_tier' | 'byok';

export interface DeductionLogInput {
  userId: string;
  /**
   * API key (rh_...) that drove the billed operation, when the request was
   * API-key authenticated. Null for UI (cookie/JWT) and non-HTTP contexts.
   * Persisted to UsageDeductionLog.apiKeyId for per-API-key billing.
   */
  apiKeyId?: string | null;
  sku: DeductionSku;
  source: DeductionSource;
  units?: number;
  tierAtCommit?: string | null;
  usedBefore?: number | null;
  usedAfter?: number | null;
  limitAtCommit?: number | null;
  costMinor?: number | null;
  currency?: string | null;
  overageChargeId?: string | null;
  /**
   * Canonical PLATFORM cost-to-serve in USD for this unit (our spend, not the
   * user charge). Persisted to UsageDeductionLog.platformCostUsd — the single
   * SUM()-able cost column for profitability analytics. Derive it from real
   * token usage via `costPatchFromTally` (lib/deductionCost.ts) at the call
   * site; null is acceptable (analytics treats it as 0). BYOK → 0.
   */
  platformCostUsd?: number | null;
  requestId?: string | null;
  apiRequestLogId?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function writeDeductionLog(input: DeductionLogInput): Promise<void> {
  try {
    await prisma.usageDeductionLog.create({
      data: {
        userId: input.userId,
        apiKeyId: input.apiKeyId ?? null,
        sku: input.sku,
        source: input.source,
        units: input.units ?? 1,
        tierAtCommit: input.tierAtCommit ?? null,
        usedBefore: input.usedBefore ?? null,
        usedAfter: input.usedAfter ?? null,
        limitAtCommit: input.limitAtCommit ?? null,
        costMinor: input.costMinor ?? null,
        currency: input.currency ?? null,
        overageChargeId: input.overageChargeId ?? null,
        platformCostUsd: input.platformCostUsd ?? null,
        requestId: input.requestId ?? null,
        apiRequestLogId: input.apiRequestLogId ?? null,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        metadata: input.metadata != null
          ? (input.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
  } catch (err) {
    logger.error('USAGE_DEDUCTION_LOG', 'failed to write deduction log row', {
      userId: input.userId,
      sku: input.sku,
      source: input.source,
      requestId: input.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
