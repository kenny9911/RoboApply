// backend/src/interview-engine/billing/sessionCost.ts
//
// Per-session cost + usage metering for the Interview Engine (the /mock-interview
// real-time voice/video product). A single mock-interview session spends money
// across FOUR stages:
//
//   1. blueprint   — prompt-generation agent (backend LLM, token-billed)
//   2. live        — the worker's real-time pipeline: LLM (token-billed) +
//                    STT (audio-minute-billed) + TTS (character/minute-billed),
//                    reported back by the worker via the /usage callback
//   3. evaluation  — the multi-agent report pipeline (backend LLM, token-billed)
//   4. coach       — the live whisper hint/nudge agent (backend LLM,
//                    token-billed, ACCUMULATED — a session can coach many times)
//
// We record, per session:
//   • aggregate LLM tokens (prompt / completion / total)
//   • audio minutes (STT) and characters/minutes (TTS)
//   • wall-clock seconds of the interview (the billable "minutes used")
//   • a total USD cost (sum of all model costs)
//
// This is persisted on the InterviewSession row (costUsd / promptTokens /
// completionTokens / totalTokens / durationSec / costBreakdown) and mirrored to
// the unified UsageDeductionLog ledger as the `mock_interview` SKU.
//
// PRICING: USD cost-to-serve is RECORDED here for admin profitability. The
// user-facing charge is the MOCK-INTERVIEW CREDIT (1 credit = 20 min, pro-rated)
// debited at finalize for the RoboApply candidate flow (source==='roboapply')
// via lib/mockCreditService.debitForFinishedSession — see
// docs/roboapply-billing-credits/spec.md. Recruiter / external-API sources are
// record-only (ledger metadata.enforced=false). The STT/TTS audio rates below
// are public-list-price estimates, env-overridable via the rate card.
//
// Every function here is best-effort and NEVER THROWS: a metering failure must
// not break a real interview, its report, or its lifecycle.

import prisma from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import { calculateModelCost } from '../../lib/modelPricing.js';
import { getRateCard } from '../../lib/rateCard.js';
import { writeDeductionLog } from '../../lib/matchBilling.js';
import { debitForFinishedSession } from '../../lib/mockCreditService.js';
import { getDefaultModel } from '../../lib/llm/llmModels.js';
import {
  getWorkerLlmModel,
  getWorkerSttModel,
  getWorkerSttFallbackModels,
} from '../config.js';
import type { ResolvedVoice } from '../types.js';

// ─── Cost shapes (stored in InterviewSession.costBreakdown) ───────────────────

export interface TokenStageCost {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usd: number;
}

export interface LiveCost {
  llm?: TokenStageCost;
  stt?: { model: string; minutes: number; usd: number };
  tts?: { model: string; characters: number; minutes: number; usd: number };
  /** Candidate barge-ins reported by the worker (interruption_usage items).
   *  Zero cost — counted so the signal isn't silently dropped from the breakdown. */
  interruptions?: number;
  usd: number;
}

/** Accumulated coach (live whisper) LLM spend. Unlike the other token stages
 *  this SUMS across calls — one session can ask for many hints/nudges. */
export interface CoachStageCost {
  model?: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  usd: number;
}

/** Recording egress + artifact storage cost (R2 / LiveKit egress). Computed
 *  from the egress-ended webhook's reported bytes × the rate card. $0 until a
 *  non-zero rate is configured (egress.usdPerGb / storage.usdPerGbMonth), so
 *  historical totals don't silently change. */
export interface RecordingCost {
  bytes: number;
  durationSec: number;
  egressUsd: number;
  storageUsd: number;
  usd: number;
}

export interface CostBreakdown {
  blueprint?: TokenStageCost;
  live?: LiveCost;
  evaluation?: TokenStageCost;
  coach?: CoachStageCost;
  recording?: RecordingCost;
  /** Billable participation seconds (mirror of the column, for self-contained JSON). */
  durationSec?: number | null;
  currency: 'usd';
  computedAt: string;
}

/** The worker's reported model-usage items (LiveKit AgentSessionUsage.modelUsage,
 *  a `Partial<ModelUsage>[]`). Kept loose — the worker forwards it verbatim. */
export interface LiveModelUsageItem {
  type?: string; // 'llm_usage' | 'stt_usage' | 'tts_usage' | 'interruption_usage'
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  charactersCount?: number;
  audioDurationMs?: number;
  sessionDurationMs?: number;
}

// ─── Placeholder audio rates (USD) — FINALIZE WITH THE PRICING PLAN ───────────
//
// STT/TTS are not token-billed by their providers, so they are not in
// lib/modelPricing.ts. These are conservative public list-price estimates,
// overridable from env without a redeploy so the pricing plan can tune them.

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** USD per minute of STT audio. Default ≈ Deepgram Nova streaming list price. */
function sttUsdPerMinute(model: string): number {
  const override = envNum('INTERVIEW_STT_USD_PER_MIN', NaN);
  if (Number.isFinite(override)) return override;
  const m = (model || '').toLowerCase();
  if (m.includes('nova-3')) return 0.0077;
  if (m.includes('nova-2')) return 0.0058;
  return 0.0077;
}

/** USD per 1M characters of TTS. Default ≈ ElevenLabs/Cartesia mid-tier. */
function ttsUsdPer1MChars(_model: string): number {
  return envNum('INTERVIEW_TTS_USD_PER_1M_CHARS', 30);
}

/** Fallback USD per minute of TTS audio when a provider reports only duration. */
function ttsUsdPerMinute(_model: string): number {
  return envNum('INTERVIEW_TTS_USD_PER_MIN', 0.18);
}

// ─── Stage cost builders ──────────────────────────────────────────────────────

/** Build a token-stage cost from a LoggerService request snapshot. Returns null
 *  when the request made no LLM calls (nothing to bill). `totalCost` is already
 *  computed by LoggerService via calculateModelCost, so we reuse it. */
export function tokenCostFromSnapshot(
  snapshot:
    | {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        totalCost: number;
        lastModel: string | null;
        llmCallsCount?: number;
      }
    | null
    | undefined,
  fallbackModel?: string,
): TokenStageCost | null {
  if (!snapshot) return null;
  const total = snapshot.totalTokens || snapshot.promptTokens + snapshot.completionTokens;
  if (total <= 0 && snapshot.totalCost <= 0) return null;
  return {
    model: snapshot.lastModel || fallbackModel || 'default',
    promptTokens: snapshot.promptTokens,
    completionTokens: snapshot.completionTokens,
    totalTokens: total,
    usd: round6(snapshot.totalCost),
  };
}

/** Price the worker's live-session usage (LLM tokens + STT/TTS audio).
 *  A session can legitimately emit MULTIPLE items per type when a model fails
 *  over to a fallback (STT nova-3 → nova-2, TTS gateway → ElevenLabs). LiveKit
 *  reports one item per provider/model, so we ACCUMULATE per type — overwriting
 *  would silently drop every model but the last (under-counting cost on failover). */
export function priceLiveUsage(items: LiveModelUsageItem[]): LiveCost {
  let llm: TokenStageCost | undefined;
  let stt: LiveCost['stt'];
  let tts: LiveCost['tts'];
  let interruptions = 0;

  // Record every distinct model that contributed, joined for display.
  const mergeModel = (prev: string | undefined, next: string): string => {
    if (!prev) return next || '';
    if (!next || prev === next) return prev;
    return prev.split('+').includes(next) ? prev : `${prev}+${next}`;
  };

  for (const it of items ?? []) {
    const provider = (it.provider || '').trim();
    const model = (it.model || '').trim();
    // Prefer a 'provider/model' id (matches our pricing tables); fall back to model.
    const id = model.includes('/') ? model : provider && model ? `${provider}/${model}` : model || provider;

    if (it.type === 'llm_usage') {
      const promptTokens = num(it.inputTokens);
      const completionTokens = num(it.outputTokens);
      const usd = calculateModelCost(id || getWorkerLlmModel(), promptTokens, completionTokens);
      llm = llm ?? { model: id || getWorkerLlmModel(), promptTokens: 0, completionTokens: 0, totalTokens: 0, usd: 0 };
      llm.model = mergeModel(llm.model, id || getWorkerLlmModel());
      llm.promptTokens += promptTokens;
      llm.completionTokens += completionTokens;
      llm.totalTokens = llm.promptTokens + llm.completionTokens;
      llm.usd = round6(llm.usd + usd);
    } else if (it.type === 'stt_usage') {
      const minutes = num(it.audioDurationMs) / 60_000;
      stt = stt ?? { model: id, minutes: 0, usd: 0 };
      stt.model = mergeModel(stt.model, id);
      stt.minutes = round4(stt.minutes + minutes);
      stt.usd = round6(stt.usd + minutes * sttUsdPerMinute(id));
    } else if (it.type === 'tts_usage') {
      const chars = num(it.charactersCount);
      const minutes = num(it.audioDurationMs) / 60_000;
      // Character-based billing when chars are reported; else fall back to audio minutes.
      const itUsd = chars > 0
        ? (chars / 1_000_000) * ttsUsdPer1MChars(id)
        : minutes * ttsUsdPerMinute(id);
      tts = tts ?? { model: id, characters: 0, minutes: 0, usd: 0 };
      tts.model = mergeModel(tts.model, id);
      tts.characters += chars;
      tts.minutes = round4(tts.minutes + minutes);
      tts.usd = round6(tts.usd + itUsd);
    } else if (it.type === 'interruption_usage') {
      // Zero-cost but counted — barge-in frequency is a real quality signal
      // and silently dropping the items would hide it from the breakdown.
      interruptions += 1;
    }
  }

  const usd = round6((llm?.usd ?? 0) + (stt?.usd ?? 0) + (tts?.usd ?? 0));
  return { llm, stt, tts, interruptions, usd };
}

// ─── Persisting (read-modify-write of costBreakdown + recompute of totals) ────

interface CostPatch {
  blueprint?: TokenStageCost;
  live?: LiveCost;
  evaluation?: TokenStageCost;
  /** One coach call's DELTA — accumulated into the stored coach stage. */
  coach?: CoachStageCost;
  recording?: RecordingCost;
  durationSec?: number | null;
}

/** Merge a stage's usage into the session's costBreakdown and recompute the
 *  flat totals (tokens + USD). Best-effort; never throws. The lifecycle stages
 *  fire at distinct moments (create → live callback → finalize/eval) so these
 *  read-modify-writes are effectively sequential per session; coach deltas CAN
 *  interleave mid-interview, but losing one to a rare concurrent write costs
 *  forensic precision, never quota (pricing is deferred). */
async function applyCost(sessionId: string, patch: CostPatch): Promise<void> {
  try {
    const row = await prisma.interviewSession.findUnique({
      where: { id: sessionId },
      select: { costBreakdown: true, durationSec: true },
    });
    const existing = (row?.costBreakdown as unknown as CostBreakdown | null) ?? null;

    const merged: CostBreakdown = {
      ...(existing ?? {}),
      ...(patch.blueprint ? { blueprint: patch.blueprint } : {}),
      ...(patch.live ? { live: patch.live } : {}),
      ...(patch.evaluation ? { evaluation: patch.evaluation } : {}),
      ...(patch.coach ? { coach: accumulateCoachStage(existing?.coach, patch.coach) } : {}),
      ...(patch.recording ? { recording: patch.recording } : {}),
      ...(patch.durationSec !== undefined ? { durationSec: patch.durationSec } : {}),
      currency: 'usd',
      computedAt: new Date().toISOString(),
    };

    const promptTokens =
      (merged.blueprint?.promptTokens ?? 0) +
      (merged.live?.llm?.promptTokens ?? 0) +
      (merged.evaluation?.promptTokens ?? 0) +
      (merged.coach?.promptTokens ?? 0);
    const completionTokens =
      (merged.blueprint?.completionTokens ?? 0) +
      (merged.live?.llm?.completionTokens ?? 0) +
      (merged.evaluation?.completionTokens ?? 0) +
      (merged.coach?.completionTokens ?? 0);
    const costUsd = round6(
      (merged.blueprint?.usd ?? 0) +
        (merged.live?.usd ?? 0) +
        (merged.evaluation?.usd ?? 0) +
        (merged.coach?.usd ?? 0) +
        (merged.recording?.usd ?? 0),
    );

    await prisma.interviewSession.update({
      where: { id: sessionId },
      data: {
        costBreakdown: merged as unknown as object,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        costUsd,
        ...(patch.durationSec !== undefined ? { durationSec: patch.durationSec } : {}),
      },
    });
  } catch (err) {
    logger.warn('INTERVIEW_COST', 'applyCost failed', {
      sessionId,
      stages: Object.keys(patch),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function recordBlueprintCost(sessionId: string, cost: TokenStageCost | null): Promise<void> {
  if (!cost) return Promise.resolve();
  return applyCost(sessionId, { blueprint: cost });
}

export function recordEvaluationCost(sessionId: string, cost: TokenStageCost | null): Promise<void> {
  if (!cost) return Promise.resolve();
  return applyCost(sessionId, { evaluation: cost });
}

export function recordLiveUsage(sessionId: string, items: LiveModelUsageItem[]): Promise<void> {
  return applyCost(sessionId, { live: priceLiveUsage(items) });
}

/** Sum a coach call's delta into the stored stage (latest model id wins). */
function accumulateCoachStage(prev: CoachStageCost | undefined, delta: CoachStageCost): CoachStageCost {
  if (!prev) return delta;
  return {
    model: delta.model ?? prev.model,
    calls: prev.calls + delta.calls,
    promptTokens: prev.promptTokens + delta.promptTokens,
    completionTokens: prev.completionTokens + delta.completionTokens,
    usd: round6(prev.usd + delta.usd),
  };
}

/** Meter one coach (live whisper) call's LLM spend onto the session. Mirrors
 *  recordBlueprintCost / recordEvaluationCost: the coach is the only LLM caller
 *  on its HTTP request, so the request snapshot's tokens/cost are exactly this
 *  call. Accumulated (not replaced) — a session can coach many times. A request
 *  that made no LLM call (validation/ownership bail) is a no-op. Never throws. */
export async function recordCoachCost(sessionId: string, requestId: string): Promise<void> {
  try {
    const snap = logger.getRequestSnapshot(requestId);
    const cost = tokenCostFromSnapshot(snap, getDefaultModel());
    if (!cost) return;
    await applyCost(sessionId, {
      coach: {
        model: cost.model,
        calls: Math.max(1, snap?.llmCallsCount ?? 1),
        promptTokens: cost.promptTokens,
        completionTokens: cost.completionTokens,
        usd: cost.usd,
      },
    });
  } catch (err) {
    logger.warn('INTERVIEW_COST', 'recordCoachCost failed', {
      sessionId,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function recordSessionDuration(sessionId: string, durationSec: number | null): Promise<void> {
  return applyCost(sessionId, { durationSec });
}

/** Meter the recording's egress + one-month storage cost from the bytes the
 *  LiveKit egress-ended webhook reports. Resolves rates from the rate card
 *  (egress.usdPerGb / storage.usdPerGbMonth, both default 0 ⇒ no-op until
 *  configured, so historical totals don't change). Best-effort; never throws. */
export async function recordRecordingCost(
  sessionId: string,
  bytes: number,
  durationSec: number,
): Promise<void> {
  try {
    if (!bytes || bytes <= 0) return;
    const card = await getRateCard();
    const egressUsdPerGb = card.egress.usdPerGb;
    const storageUsdPerGbMonth = card.storage.usdPerGbMonth;
    if (egressUsdPerGb <= 0 && storageUsdPerGbMonth <= 0) return; // not configured → $0
    const gb = bytes / 1_000_000_000;
    const egressUsd = round6(gb * egressUsdPerGb);
    const storageUsd = round6(gb * storageUsdPerGbMonth); // ~one month of retention
    await applyCost(sessionId, {
      recording: {
        bytes,
        durationSec: durationSec || 0,
        egressUsd,
        storageUsd,
        usd: round6(egressUsd + storageUsd),
      },
    });
  } catch (err) {
    logger.warn('INTERVIEW_COST', 'recordRecordingCost failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Ledger ───────────────────────────────────────────────────────────────────

/** Recompute one last time and write the forensic cost row to UsageDeductionLog.
 *  Called once per session at the true end (after the evaluation stage). Records
 *  the cost only — no User counter is mutated until the pricing plan is set
 *  (metadata.pricingPending). Best-effort; never throws. */
export async function writeMockInterviewLedger(sessionId: string): Promise<void> {
  try {
    const ledgerSelect = {
      userId: true,
      // Set when the session was created via the external API (X-API-Key).
      // Threaded onto the mock_interview ledger row for per-API-key billing.
      apiKeyId: true,
      source: true,
      costUsd: true,
      promptTokens: true,
      completionTokens: true,
      totalTokens: true,
      durationSec: true,
      plannedDurationMinutes: true,
      endedAt: true,
      costBreakdown: true,
      user: { select: { subscriptionTier: true } },
    } as const;

    let row = await prisma.interviewSession.findUnique({
      where: { id: sessionId },
      select: ledgerSelect,
    });
    if (!row) return;

    // ORDERING RACE: this runs from _enrichReport's finally, which can finish
    // BEFORE the worker's /usage callback lands (the worker only flushes its
    // live usage at shutdown, after room deletion). Writing now would freeze a
    // ledger row WITHOUT the live-stage cost — and the idempotency guard below
    // would then block the corrected total forever. When the live stage is
    // missing and the session only just ended, give the callback one ~10s
    // grace and re-read once. The caller is a void background chain, so the
    // delay blocks nobody.
    const breakdown = row.costBreakdown as unknown as CostBreakdown | null;
    if (!breakdown?.live && row.endedAt && Date.now() - row.endedAt.getTime() < 30_000) {
      await sleep(10_000);
      const reread = await prisma.interviewSession.findUnique({
        where: { id: sessionId },
        select: ledgerSelect,
      });
      if (reread) row = reread;
    }

    // Idempotency guard (defense-in-depth on top of finalize()'s atomic claim):
    // if a mock_interview cost row already exists for this session, don't append
    // a duplicate — a re-finalize / retried worker callback must not double-write
    // the forensic (and, once enforced, billable) ledger.
    const existing = await prisma.usageDeductionLog.findFirst({
      where: { sku: 'mock_interview', relatedEntityType: 'interview_session', relatedEntityId: sessionId },
      select: { id: true },
    });
    if (existing) {
      logger.info('INTERVIEW_COST', 'mock interview cost already recorded; skipping duplicate', { sessionId });
      return;
    }

    const costUsd = row.costUsd ?? 0;
    const durationSec = row.durationSec ?? 0;
    const costMinor = Math.round(costUsd * 100); // USD cents

    // CREDIT DEBIT — RoboApply candidate flow only. Pro-rated by duration
    // (1 credit = 20 min), idempotent per session, clamps balance ≥ 0. Recruiter
    // / external-API sources are exempt (billed separately). Best-effort: a
    // failure here never blocks the cost ledger or the interview. Runs after the
    // idempotency guard above, so it fires exactly once per session.
    let creditDebit: { debited: number; balanceAfter: number } | null = null;
    if (row.source === 'roboapply') {
      creditDebit = await debitForFinishedSession({
        userId: row.userId,
        sessionId,
        durationSec,
        plannedDurationMinutes: row.plannedDurationMinutes,
      });
    }
    const enforced = row.source === 'roboapply';

    await writeDeductionLog({
      userId: row.userId,
      apiKeyId: row.apiKeyId ?? null,
      sku: 'mock_interview',
      source: 'plan',
      units: 1,
      tierAtCommit: row.user?.subscriptionTier ?? null,
      costMinor,
      currency: 'usd',
      // Canonical platform cost-to-serve (LLM + STT/TTS + recording) so the
      // RoboApply admin profitability query can SUM a single column across ALL
      // SKUs. Interviews are the only SKU that also sets costMinor; analytics
      // reads platformCostUsd uniformly and never double-adds InterviewSession.
      platformCostUsd: round6(costUsd),
      relatedEntityType: 'interview_session',
      relatedEntityId: sessionId,
      metadata: {
        sessionSource: row.source,
        costUsd: round6(costUsd),
        durationSec,
        minutes: round4(durationSec / 60),
        promptTokens: row.promptTokens ?? 0,
        completionTokens: row.completionTokens ?? 0,
        totalTokens: row.totalTokens ?? 0,
        breakdown: row.costBreakdown ?? null,
        // Mock-interview CREDIT deduction (RoboApply candidate flow). For
        // recruiter/external sources credits are not enforced (separate billing).
        creditsDebited: creditDebit?.debited ?? 0,
        creditBalanceAfter: creditDebit?.balanceAfter ?? null,
        // Now ENFORCED for the candidate flow (pricing plan is live). Recruiter /
        // external sources remain record-only.
        pricingPending: !enforced,
        enforced,
      },
    });

    logger.info('INTERVIEW_COST', 'mock interview cost recorded', {
      sessionId,
      userId: row.userId,
      source: row.source,
      costUsd: round6(costUsd),
      costMinorUsd: costMinor,
      durationSec,
      minutes: round4(durationSec / 60),
      promptTokens: row.promptTokens ?? 0,
      completionTokens: row.completionTokens ?? 0,
      totalTokens: row.totalTokens ?? 0,
    });
  } catch (err) {
    logger.warn('INTERVIEW_COST', 'writeMockInterviewLedger failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Model summary (the "all models used" INFO log at session start) ──────────

/** Every model a mock-interview session touches, for the start-of-interview log. */
export function describeSessionModels(voice: ResolvedVoice): Record<string, unknown> {
  return {
    // Real-time worker pipeline (LiveKit) — drives the live conversation.
    liveLlm: getWorkerLlmModel(),
    stt: getWorkerSttModel(),
    sttFallbacks: getWorkerSttFallbackModels(),
    tts: {
      provider: voice.provider,
      model: voice.model,
      voiceId: voice.voiceId,
      languageCode: voice.languageCode,
      label: voice.label,
    },
    // Backend agents — share the default model (DB override ?? env LLM_MODEL).
    backendAgents: {
      model: getDefaultModel() ?? '(env LLM_MODEL default)',
      uses: ['blueprint', 'holisticScorecard', 'questionDeepDive', 'recommendations', 'coach'],
    },
  };
}

// ─── tiny helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
