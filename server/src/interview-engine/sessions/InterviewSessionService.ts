// backend/src/interview-engine/sessions/InterviewSessionService.ts
//
// The Interview Engine's lifecycle orchestrator — the single brain wiring the
// prompt pipeline, LiveKit room + agent dispatch + egress, R2 transcript
// persistence, and scoring around the InterviewSession DB row.
//
// Lifecycle:
//   createSession()  → row (status 'preparing'), credits gated; returns fast
//   prepareSession() → blueprint + prompt + voice (status → 'created', or
//                      'failed' with error llm_unavailable | prepare_failed)
//   getConnection()  → create room + dispatch agent + start egress + mint token
//                      (status → 'live')
//   ingestTranscript() (worker callback, secret-gated) → append turns
//   handleEgressEnded() / handleRoomFinished() (LiveKit webhook) → record file +
//                      finalize
//   endByOwner()     → 'finalizing' + {type:'end'} to the worker, wait for its
//                      drain, then finalize()
//   finalize()       → upload transcript to R2 + score → report (status
//                      → 'completed'; zero candidate turns → 'failed'/no_answer,
//                      never charged)
//
// Per brand (WP-63a): every media-plane call goes through the session's
// VoiceSessionProvider (../providers/), fixed at create from the request's
// brand and stored on the row (`InterviewSession.brand` / `voiceProvider`,
// SCHEMA-4). Readers go through `resolveSessionSeam(row)`: the columns, else
// `liveMetrics.voiceSeam`, else the owner's `User.brand` — a null column is
// never read as RoboApply. Session work that can arrive from anywhere (webhooks,
// callbacks, crons) runs inside the session's brand, so S3, LLM routing and
// content safety resolve for that brand: GoApply uses CN_LIVEKIT_*, the
// 'GoApply-Interview' worker, CN_S3_* (audio only) and domestic models.
//
// Ownership: every read/mutation is scoped to the owning user (the human user
// OR the API-key owner for external sessions); cross-tenant access 404s.

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { InterviewSession } from '../../generated/prisma/client.js';
import prisma from '../../lib/prisma.js';
import { logger, generateRequestId } from '../../services/LoggerService.js';
import {
  getAgentCallbackSecrets,
  getAgentCallbackSecret,
  getCallbackBaseUrl,
  getInterviewMediaPolicy,
  getSessionExpiryMinutes,
  getInterviewLlmRouting,
  getWorkerLlmModel,
  getBlueprintModel,
  getPrepareTimeoutMs,
  isRecordingEnabled,
  InterviewEngineConfigError,
  type InterviewLlmRouting,
} from '../config.js';
import {
  assertBrandSpeech,
  inBrand,
  isDefaultSeam,
  resolveBrandSessionVoice,
  resolveBrandStt,
  resolveBrandVoice,
  resolveSessionSeam,
  voiceProviderFor,
  voiceSeamColumns,
  voiceSeamForBrand,
  voiceSeamMetrics,
  type VoiceSeam,
  type VoiceSessionProvider,
} from '../providers/index.js';
import { getBrand, type BrandId } from '../../platform/brand/registry.js';
import { interviewR2Storage } from '../storage/r2Storage.js';
import { normalizeLocale } from '../voice/voiceCatalog.js';
import { findPersona, findSessionType, findType, DEFAULT_PERSONA, DEFAULT_TYPE } from '../catalog/interviewCatalog.js';
import { CN_AI_INTERVIEW_FORMAT_ID, clampCnMinutes, usesCnFormat, type CnPracticeReport } from '../../features/cn/interview/index.js';
import { normalizeCharacteristics } from '../prompt/characteristics.js';
import { interviewPromptService } from '../prompt/interviewPromptService.js';
import { classifyPrepareError, describePrepareError, type PrepareFailureCode } from '../prompt/llmFailure.js';
import { inferRoleFromJd } from '../prompt/InterviewBlueprintAgent.js';
import { scoreTranscript } from '../scoring/interviewScorer.js';
import type { InterviewScore } from '../scoring/interviewScorer.js';
import { runInterviewEvaluation } from '../scoring/interviewEvaluationService.js';
import {
  describeSessionModels,
  tokenCostFromSnapshot,
  recordBlueprintCost,
  recordEvaluationCost,
  recordLiveUsage,
  recordRecordingCost,
  writeMockInterviewLedger,
  type LiveModelUsageItem,
} from '../billing/sessionCost.js';
import { getTaskModel } from '../../lib/llm/llmTaskSettings.js';
import { gateMockInterview } from '../../lib/mockCreditService.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type {
  InterviewMode,
  InterviewSource,
  InterviewRoomMetadata,
  TranscriptTurn,
  ResolvedVoice,
} from '../types.js';
import {
  sortTurnsByTs,
  computeParticipationDurationSec,
  asLiveMetrics,
  capTail,
  decideReconcileAction,
  recordingMimeForMode,
  sanitizeClientEvents,
  sanitizeMetricEvents,
  summarizeMetricEvents,
  MAX_STORED_CLIENT_EVENTS,
  MAX_STORED_WORKER_METRIC_EVENTS,
  countCandidateTurns,
  dedupeTurnsByKey,
  isRetryablePrepareFailure,
  readSessionControl,
  sanitizeWorkerReason,
  PREPARE_FAILURE_CODES,
  type SessionControl,
} from './lifecycleHelpers.js';
import {
  drainParleySession,
  getParleyConnection,
  isParleySession,
  pullParleyTranscript,
  stopParleySession,
  type ParleyJoin,
} from '../parley/parleySessions.js';

export class InterviewValidationError extends Error {
  constructor(msg: string) { super(msg); this.name = 'InterviewValidationError'; }
}
export class InterviewNotFoundError extends Error {
  constructor() { super('Interview session not found'); this.name = 'InterviewNotFoundError'; }
}
export class InterviewAuthError extends Error {
  constructor(msg = 'Unauthorized') { super(msg); this.name = 'InterviewAuthError'; }
}
/** Thrown when a RoboApply candidate lacks the mock-interview credits to start a
 *  session of the requested duration. Mapped to HTTP 402 by handleEngineError. */
export class InterviewInsufficientCreditsError extends Error {
  balance: number;
  required: number;
  tier: string;
  constructor(info: { balance: number; required: number; tier: string }) {
    super('Insufficient mock-interview credits');
    this.name = 'InterviewInsufficientCreditsError';
    this.balance = info.balance;
    this.required = info.required;
    this.tier = info.tier;
  }
}

/** POST /prepare called before the session is ready to go live (409 not_ready). */
export class InterviewNotReadyError extends Error {
  readonly code = 'not_ready' as const;
  constructor() { super('Interview session is still being prepared'); this.name = 'InterviewNotReadyError'; }
}
/** The session failed (preparation or the live worker); `reason` is session.error. */
export class InterviewSessionFailedError extends Error {
  readonly code = 'session_failed' as const;
  reason: string;
  constructor(reason: string) {
    super('Interview session failed');
    this.name = 'InterviewSessionFailedError';
    this.reason = reason;
  }
}
/** The session already ended (finalizing / completed / expired). */
export class InterviewSessionEndedError extends Error {
  readonly code = 'session_ended' as const;
  status: string;
  constructor(status: string) {
    super(`Interview session is ${status}; start a new session.`);
    this.name = 'InterviewSessionEndedError';
    this.status = status;
  }
}
/** Preparation failed: 'llm_unavailable' → 503, 'prepare_failed' → 500. The
 *  failed session rides along so the client can render it without a re-read. */
export class InterviewPrepareFailedError extends Error {
  readonly code: PrepareFailureCode;
  session: InterviewSession;
  constructor(code: PrepareFailureCode, session: InterviewSession) {
    super(code === 'llm_unavailable'
      ? 'The interview AI is temporarily unavailable.'
      : 'The interview could not be prepared.');
    this.name = 'InterviewPrepareFailedError';
    this.code = code;
    this.session = session;
  }
}

// Sized for the 120-minute max session at a brisk voice cadence (~20 turns a
// minute across both speakers) so the head-trim never eats a real interview.
const MAX_TRANSCRIPT_TURNS = 2400;
// Grace window between room deletion (= worker shutdown) and the finalize
// transcript re-read, so the worker's fire-and-forget final flush can land.
// The worker's shutdown drain retries for up to ~12s (8 × 1.5s); 4s covers
// the common first-attempt delivery without stalling the webhook-triggered
// finalize paths, and the post-score recheck in finalize() catches slower
// stragglers.
const TRANSCRIPT_FLUSH_GRACE_MS = 4000;
// getReport: recordingKey means egress STARTED; the R2 object only exists once
// egress finishes writing. Past this window after session end with no object,
// the recording is treated as permanently absent (stop advertising it).
const RECORDING_LANDING_GRACE_MS = 10 * 60_000;
// Lazy re-enrichment on report reads: a 'completed' session whose report is
// still version 'deterministic' after this long has lost its fire-and-forget
// _enrichReport (deploy/restart in the window). Re-fired on read, at most
// REENRICH_MAX_ATTEMPTS times — the counter lives INSIDE the report JSON
// (report.enrichAttempts), so no schema change.
const REENRICH_MIN_AGE_MS = 2 * 60_000;
const REENRICH_MAX_ATTEMPTS = 3;
// Reconciliation sweep: a stranded row must be quiet this long (no transcript
// ingest / lifecycle write bumping updatedAt) before the sweep touches it — an
// ACTIVE long interview can legitimately outlive expiresAt, but its ~4s
// transcript flushes keep updatedAt fresh.
const RECONCILE_QUIET_MS = 10 * 60_000;
// Bound each reconcile sweep; finalize's flush grace makes each finalization
// cost seconds, and the cron re-runs soon anyway.
const RECONCILE_BATCH_SIZE = 25;
// A 'preparing' row untouched this long lost its prepare request (tab closed,
// function killed) — the cleanup sweep expires it (C3).
const STALE_PREPARING_MS = 30 * 60_000;
// C8: after the {type:'end'} data message, how long endByOwner waits for the
// worker's 'ended' lifecycle (its transcript drain) before tearing down.
const END_SIGNAL_WAIT_MS = 8000;
const END_SIGNAL_POLL_MS = 400;
// Statuses finalize() never claims: already terminal or mid-finalize.
const NON_FINALIZABLE = ['completed', 'finalizing', 'failed', 'expired'];

export interface CreateSessionInput {
  userId: string;
  source?: InterviewSource;
  apiKeyId?: string | null;
  externalRef?: string | null;
  role: string;
  interviewType?: string;
  personaId?: string;
  mode?: InterviewMode;
  language?: string;
  durationMinutes?: number;
  characteristics?: unknown;
  candidateName?: string;
  resumeContext?: string;
  /** Optional pasted job description — AUTHORITATIVE for requirements. */
  jdText?: string;
  requestId?: string;
  /** Skip the mock-interview credit gate + debit (admins). Recorded on the row. */
  creditExempt?: boolean;
  /** Per-session worker callback origin (C13); null/undefined = call-time default. */
  callbackBaseUrl?: string | null;
  /** 'parley' runs this session on the Parley pilot transport (see
   *  parley/parleyConfig.ts); omitted = LiveKit. Fixed for the session's life. */
  transport?: 'parley';
  /**
   * WP-43: practise for one of our jobs. The job is loaded server-side and
   * must belong to `market` (a job from the other market, or someone else's
   * private import, answers 404 — PracticeJobNotFoundError). Its title and
   * posting fill `role` / `jdText` when the caller left them empty.
   */
  jobId?: string | null;
  /** The requesting brand's market; defaults to the current brand context. */
  market?: PracticeMarket;
  /**
   * WP-43 / H8: what the user asked to record for THIS session. Recording is
   * off unless asked AND backed by a live `interview_recording` consent
   * (`interview_video` as well for the camera). External API sessions take
   * the tenant's flag as their attestation. Omitted = no recording.
   */
  recording?: { audio?: boolean; video?: boolean };
}

export interface PrepareSessionParams {
  sessionId: string;
  userId: string;
  apiKeyId?: string | null;
  /** Re-run a session that failed with llm_unavailable / prepare_failed. */
  retry?: boolean;
  requestId?: string;
  /** false = never fail on the LLM (heuristic blueprint fallback). Default true. */
  strictLlm?: boolean;
}

export interface ConnectionDetails {
  sessionId: string;
  url: string;
  token: string;
  roomName: string;
  identity: string;
  mode: InterviewMode;
  language: string;
  voice: ResolvedVoice;
  expiresAt: string;
  agentDispatched: boolean;
  recording: boolean;
  /**
   * WP-63a: false when the brand keeps the camera as a local preview only
   * (GoApply, CN L-11) — the token cannot publish a camera track, and the
   * live room shows the camera to the candidate alone. Absent on Parley.
   */
  cameraPublish?: boolean;
  /** Present only for Parley sessions: url/token are then empty and the
   *  browser joins Parley with `parley` instead of a LiveKit room. */
  transport?: 'parley';
  parley?: ParleyJoin;
}

function liveLlmSnapshot(routing: InterviewLlmRouting): Record<string, unknown> {
  return {
    model: routing.workerModel,
    backendModel: routing.backendModel,
    ...(routing.reasoningEffort ? { reasoningEffort: routing.reasoningEffort } : {}),
  };
}

function withLiveLlmSnapshot(
  blueprint: unknown,
  routing: InterviewLlmRouting,
): Record<string, unknown> {
  const base = blueprint && typeof blueprint === 'object' && !Array.isArray(blueprint)
    ? blueprint as Record<string, unknown>
    : {};
  return { ...base, liveLlm: liveLlmSnapshot(routing) };
}

function storedWorkerModel(blueprint: unknown): string | undefined {
  if (!blueprint || typeof blueprint !== 'object' || Array.isArray(blueprint)) return undefined;
  const liveLlm = (blueprint as Record<string, unknown>).liveLlm;
  if (!liveLlm || typeof liveLlm !== 'object' || Array.isArray(liveLlm)) return undefined;
  const model = (liveLlm as Record<string, unknown>).model;
  return typeof model === 'string' && model.trim() ? model.trim() : undefined;
}

export class InterviewSessionService {
  // ─── Create ─────────────────────────────────────────────────────────────

  async createSession(input: CreateSessionInput): Promise<InterviewSession> {
    const source: InterviewSource = input.source ?? 'roboapply';
    // WP-43: a job-based practice loads the job first, so a job from another
    // market (or another user's private import) is a 404 before any credit
    // check or write.
    const jobId = typeof input.jobId === 'string' ? input.jobId.trim() : '';
    const job = jobId ? await loadPracticeJobOrThrow(input.userId, jobId, input.market) : null;

    const jdText = ((input.jdText ?? '').trim() || job?.jdText || '').slice(0, 8000) || undefined;
    // When the candidate pasted a JD without picking a role, seed the role from
    // the JD so the session/report/recents never show an empty title.
    const role = (input.role ?? '').trim() || job?.title || (jdText ? inferRoleFromJd(jdText) : '');
    const persona = (input.personaId && findPersona(input.personaId)) || DEFAULT_PERSONA;
    // A market's own formats (GoApply's AI-interview practice) are offered to
    // the first-party flow only; recruiter and external API sessions keep the
    // international list.
    const typeMarket: PracticeMarket = source === 'roboapply' ? (input.market ?? practiceDeps.currentMarket()) : 'intl';
    let type = (input.interviewType && findType(input.interviewType, typeMarket)) || DEFAULT_TYPE;
    const mode: InterviewMode = input.mode === 'video' ? 'video' : 'voice';
    const language = normalizeLocale(input.language);
    let durationMinutes = clampDuration(input.durationMinutes) ?? type.minutes;
    // WP-66: on GoApply a general practice (screening / behavioral / culture)
    // of 20–30 minutes runs the AI-interview format, and so does the format
    // picked by name. The row says so (`interviewType`), which is what the
    // blueprint directive, the grading lens and the report's `cn` block read.
    // A general practice of another length keeps its own type and length.
    if (source === 'roboapply' && usesCnFormat({ market: typeMarket, typeId: type.id, minutes: durationMinutes })) {
      type = findSessionType(CN_AI_INTERVIEW_FORMAT_ID) ?? type;
      // The format is 20–30 minutes; the credit gate below sees the same length.
      if (type.id === CN_AI_INTERVIEW_FORMAT_ID) durationMinutes = clampCnMinutes(durationMinutes);
    }

    // CREDIT GATE (RoboApply candidate flow only). Recruiter + external-API
    // sources bill separately and are exempt; admins are exempt explicitly.
    // Runs BEFORE anything is persisted so a credit-less user never gets a
    // session (or blueprint spend). Throws InterviewInsufficientCreditsError →
    // 402 with an upsell payload.
    if (source === 'roboapply' && !input.creditExempt) {
      const afford = await gateMockInterview(input.userId, durationMinutes);
      if (!afford.ok) {
        logger.info('INTERVIEW_ENGINE_SESSION', 'mock interview blocked — insufficient credits', {
          userId: input.userId,
          plannedDurationMinutes: durationMinutes,
          balance: afford.balance,
          required: afford.required,
          tier: afford.tier,
        });
        throw new InterviewInsufficientCreditsError(afford);
      }
    }

    // WP-63a: the session runs on the requesting brand's media plane for its
    // whole life. Resolving the provider here also refuses a reserved one
    // (volcano / trtc → 503) before anything is persisted.
    const brand = getCurrentBrandOrDefault();
    const seam = voiceSeamForBrand(brand.id);
    // The Parley pilot is an international service: a GoApply session never
    // runs on it (it stays on the brand's own media plane instead).
    const transport = brand.market === 'cn' ? undefined : input.transport;
    if (transport !== 'parley') voiceProviderFor(seam);

    // A session created here is destined for the LiveKit worker. Validate the
    // interview model selectors before persisting a session that can never
    // connect (InterviewEngineConfigError → 503).
    getInterviewLlmRouting(brand);

    const characteristics = normalizeCharacteristics(input.characteristics, persona.difficulty);
    const candidateName = (input.candidateName ?? '').trim() || undefined;
    const resumeContext = (input.resumeContext ?? '').trim() || undefined;

    // GoApply: domestic STT/TTS only — unconfigured → 503 before anything is
    // persisted (never the international voice catalog).
    const voice = resolveBrandVoice(brand.id, language, persona.voiceGender);
    if (transport !== 'parley') resolveBrandStt(brand.id, language);
    const roomName = `ie-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + getSessionExpiryMinutes() * 60_000);
    const control: SessionControl = {
      ...(input.callbackBaseUrl ? { callbackBaseUrl: input.callbackBaseUrl } : {}),
      ...(input.creditExempt ? { creditExempt: true } : {}),
      ...(transport === 'parley' ? { transport: 'parley' as const } : {}),
    };
    // H8: decide recording now, from the consent ledger — never from the env
    // default alone. getConnection starts egress only when this says so.
    const recording = await resolvePracticeRecording({
      userId: input.userId,
      source,
      mode,
      requested: input.recording,
      // CN L-11: GoApply records audio only, whatever was asked.
      allowVideo: getInterviewMediaPolicy(brand).recordVideo,
    });
    const practice: PracticeMeta | null =
      job || recording.audio
        ? {
            v: 1,
            jobId: job?.id ?? null,
            jobTitle: job?.title ?? null,
            companyName: job?.companyName ?? null,
            recording,
          }
        : null;
    const liveMetrics: Record<string, unknown> = {
      ...(Object.keys(control).length > 0 ? { control } : {}),
      ...(practice ? { practice } : {}),
      ...voiceSeamMetrics(seam),
    };

    // C1: persist immediately as 'preparing'. Blueprint + prompt generation
    // (Tavily + one LLM call, often a minute or more) runs in prepareSession().
    const created = await prisma.interviewSession.create({
      data: {
        userId: input.userId,
        source,
        apiKeyId: input.apiKeyId ?? null,
        externalRef: input.externalRef ?? null,
        role,
        interviewType: type.id,
        personaId: persona.id,
        mode,
        language,
        plannedDurationMinutes: durationMinutes,
        characteristics: characteristics as unknown as object,
        voice: voice as unknown as object,
        candidateName: candidateName ?? null,
        resumeContext: resumeContext ?? null,
        jdText: jdText ?? null,
        roomName,
        status: 'preparing',
        expiresAt,
        // WP-43-S1 columns (SCHEMA-3), written alongside liveMetrics.practice
        // during the transition; readers take the column first.
        jobId: job?.id ?? null,
        // WP-63a-S1 columns (SCHEMA-4): every new row says which brand and
        // provider it runs on. liveMetrics.voiceSeam stays for non-default
        // seams during the transition (see providers/sessionSeam.ts).
        ...voiceSeamColumns(seam),
        ...(source === 'roboapply' ? { recordingConsent: { audio: recording.audio, video: recording.video } } : {}),
        ...(Object.keys(liveMetrics).length > 0
          ? { liveMetrics: liveMetrics as unknown as object }
          : {}),
      },
    });

    logger.info('INTERVIEW_ENGINE_SESSION', 'session created (preparing)', {
      sessionId: created.id,
      userId: input.userId,
      source: created.source,
      role,
      type: type.id,
      mode,
      language,
      durationMinutes,
      creditExempt: input.creditExempt === true ? true : undefined,
      callbackOrigin: input.callbackBaseUrl ?? undefined,
      apiKeyId: input.apiKeyId ?? undefined,
      transport,
      jobId: job?.id,
      recording: recording.audio ? (recording.video ? 'audio+video' : 'audio') : 'off',
      ...(isDefaultSeam(seam) ? {} : { brand: seam.brand, voiceProvider: seam.provider }),
      requestId: input.requestId,
    });
    return created;
  }

  // ─── Prepare (blueprint + prompt) ─────────────────────────────────────────

  /** In-process dedupe of concurrent prepare calls for one session (C2). A
   *  duplicate run on another instance is harmless: every write is
   *  conditional on status='preparing'. */
  private readonly inflightPrepares = new Map<string, Promise<InterviewSession>>();

  /**
   * C2: generate the blueprint, interviewer prompt and voice for a 'preparing'
   * session, synchronously. Any other status returns the row unchanged; a
   * 'failed' session (llm_unavailable / prepare_failed) re-runs only with
   * `retry`. Failures persist status 'failed' + error code and throw
   * InterviewPrepareFailedError. Nothing here charges credits.
   */
  async prepareSession(params: PrepareSessionParams): Promise<InterviewSession> {
    let session = await this.loadOwned(params.userId, params.sessionId, params.apiKeyId);

    if (session.status === 'failed') {
      const code = session.error ?? '';
      if (!isRetryablePrepareFailure(code)) throw new InterviewSessionFailedError(code || 'failed');
      if (!params.retry) throw new InterviewPrepareFailedError(code as PrepareFailureCode, session);
      await prisma.interviewSession.updateMany({
        where: { id: session.id, status: 'failed', error: { in: [...PREPARE_FAILURE_CODES] } },
        data: { status: 'preparing', error: null, endedAt: null },
      });
      const fresh = await prisma.interviewSession.findUnique({ where: { id: session.id } });
      if (!fresh) throw new InterviewNotFoundError();
      session = fresh;
      logger.info('INTERVIEW_ENGINE_SESSION', 'prepare retry requested', {
        sessionId: session.id, previousError: code, status: session.status, requestId: params.requestId,
      });
      if (session.status === 'failed') {
        const again = session.error ?? '';
        if (isRetryablePrepareFailure(again)) throw new InterviewPrepareFailedError(again as PrepareFailureCode, session);
        throw new InterviewSessionFailedError(again || 'failed');
      }
    }

    if (session.status !== 'preparing') return session;

    const inflight = this.inflightPrepares.get(session.id);
    if (inflight) return inflight;
    const prepared = session;
    const brand = (await resolveSessionSeam(prepared)).brand;
    // Another call may have started the same prepare while the brand was read.
    const raced = this.inflightPrepares.get(session.id);
    if (raced) return raced;
    const run = inBrand(brand, () => this.runPrepare(prepared, params, brand)).finally(() => {
      this.inflightPrepares.delete(session.id);
    });
    this.inflightPrepares.set(session.id, run);
    return run;
  }

  private async runPrepare(session: InterviewSession, params: PrepareSessionParams, brand: BrandId): Promise<InterviewSession> {
    const startedAt = Date.now();
    try {
      const persona = (session.personaId && findPersona(session.personaId)) || DEFAULT_PERSONA;
      // A stored row may be in a market format (GoApply: cn_ai_interview).
      const type = findSessionType(session.interviewType) || DEFAULT_TYPE;
      const characteristics = normalizeCharacteristics(session.characteristics, persona.difficulty);
      const routing = getInterviewLlmRouting(brand);

      const gen = await interviewPromptService.generate({
        role: session.role,
        personaName: persona.name,
        personaRole: persona.role,
        personaStyle: persona.style,
        personaDifficulty: persona.difficulty,
        archetype: persona.archetype,
        typeLabel: type.label,
        typeSub: type.sub,
        typeId: type.id,
        language: session.language,
        durationMinutes: session.plannedDurationMinutes,
        characteristics,
        candidateName: session.candidateName ?? undefined,
        resumeContext: session.resumeContext ?? undefined,
        jdText: session.jdText ?? undefined,
        requestId: params.requestId,
        signal: AbortSignal.timeout(getPrepareTimeoutMs()),
        strictLlm: params.strictLlm !== false,
      });

      const voice = resolveBrandVoice(brand, session.language, persona.voiceGender);
      // Conditional on 'preparing': a concurrent run elsewhere, a delete or an
      // end-by-owner must win over this (late) result.
      const persisted = await prisma.interviewSession.updateMany({
        where: { id: session.id, status: 'preparing' },
        data: {
          status: 'created',
          error: null,
          interviewPrompt: gen.systemPrompt,
          blueprint: withLiveLlmSnapshot(
            {
              ...gen.blueprint,
              interviewerBrief: gen.masterBrief,
              openingInstruction: gen.openingInstruction,
              openingLine: gen.openingLine,
            },
            routing,
          ) as unknown as object,
          questions: gen.seedQuestions as unknown as object,
          webSources: gen.webSources as unknown as object,
          voice: voice as unknown as object,
          // The connect window starts when the session is actually ready.
          expiresAt: new Date(Date.now() + getSessionExpiryMinutes() * 60_000),
        },
      });

      const current = await prisma.interviewSession.findUnique({ where: { id: session.id } });
      if (!current) throw new InterviewNotFoundError();
      if (persisted.count !== 1) {
        logger.info('INTERVIEW_ENGINE_SESSION', 'prepare result discarded (session moved on)', {
          sessionId: session.id, status: current.status, requestId: params.requestId,
        });
        if (current.status === 'failed' && isRetryablePrepareFailure(current.error ?? '')) {
          throw new InterviewPrepareFailedError(current.error as PrepareFailureCode, current);
        }
        return current;
      }

      logger.info('INTERVIEW_ENGINE_SESSION', 'session prepared', {
        sessionId: session.id,
        durationMs: Date.now() - startedAt,
        questionCount: Array.isArray(gen.seedQuestions) ? gen.seedQuestions.length : 0,
        blueprintFallback: gen.blueprint.isFallback === true ? true : undefined,
        requestId: params.requestId,
      });

      // Meter the prompt-generation (blueprint) LLM cost: the blueprint agent
      // is the only LLM call on the prepare request. Best-effort.
      if (params.requestId) {
        const snap = logger.getRequestSnapshot(params.requestId);
        void recordBlueprintCost(session.id, tokenCostFromSnapshot(snap, getBlueprintModel(brand)));
      }
      return current;
    } catch (err) {
      if (err instanceof InterviewPrepareFailedError || err instanceof InterviewNotFoundError) throw err;
      const code = classifyPrepareError(err);
      logger.error('INTERVIEW_ENGINE_SESSION', 'session prepare failed', {
        sessionId: session.id,
        code,
        error: describePrepareError(err),
        durationMs: Date.now() - startedAt,
        requestId: params.requestId,
      });
      await prisma.interviewSession.updateMany({
        where: { id: session.id, status: 'preparing' },
        data: { status: 'failed', error: code },
      }).catch((persistErr) => {
        logger.error('INTERVIEW_ENGINE_SESSION', 'prepare failure could not be persisted', {
          sessionId: session.id, error: persistErr instanceof Error ? persistErr.message : String(persistErr),
        });
      });
      const current = await prisma.interviewSession.findUnique({ where: { id: session.id } }).catch(() => null);
      if (!current) throw new InterviewNotFoundError();
      if (current.status !== 'failed') {
        // Another run already succeeded (or the session moved on) — not a failure.
        if (current.status !== 'preparing') return current;
      }
      throw new InterviewPrepareFailedError(code, { ...current, status: 'failed', error: current.error ?? code });
    }
  }

  // ─── Connect (go live) ────────────────────────────────────────────────────

  async getConnection(params: {
    sessionId: string;
    userId: string;
    apiKeyId?: string | null;
    requestId?: string;
  }): Promise<ConnectionDetails> {
    const session = await this.loadOwned(params.userId, params.sessionId, params.apiKeyId);
    const seam = await resolveSessionSeam(session);
    return inBrand(seam.brand, () => this.connectLoaded(session, params, seam));
  }

  private async connectLoaded(session: InterviewSession, params: { requestId?: string }, seam: VoiceSeam): Promise<ConnectionDetails> {

    // C4: a session that is still preparing, failed or already over can never
    // go (back) live — answer with a typed 409 the client can act on.
    if (session.status === 'preparing') throw new InterviewNotReadyError();
    if (session.status === 'failed') throw new InterviewSessionFailedError(session.error ?? 'failed');
    if (session.status === 'completed' || session.status === 'expired' || session.status === 'finalizing') {
      throw new InterviewSessionEndedError(session.status);
    }

    const mode = session.mode as InterviewMode;
    const voice = resolveBrandSessionVoice(
      seam.brand,
      session.voice as unknown as ResolvedVoice | null,
      session.language,
      session.personaId ? findPersona(session.personaId)?.voiceGender : undefined,
    );
    // Parley pilot: no room, dispatch or worker — the browser joins Parley.
    if (isParleySession(session)) return getParleyConnection(session, voice);
    const provider = voiceProviderFor(seam);
    if (!provider.isConfigured()) {
      throw new InterviewEngineConfigError('LiveKit is not configured; cannot start a live interview.');
    }
    const identity = `candidate-${session.id}`;
    const ttlSeconds = Math.max(900, session.plannedDurationMinutes * 60 + 600); // duration + 10 min slack

    let resolvedRouting: InterviewLlmRouting | undefined;
    let resolvedMetadata: InterviewRoomMetadata | undefined;
    let resolvedMetadataStr: string | undefined;
    const resolveRoomConfig = () => {
      const routing = resolvedRouting ?? getInterviewLlmRouting(seam.brand);
      const metadata = resolvedMetadata ?? this.buildRoomMetadata(session, voice, routing, seam.brand);
      const metadataStr = resolvedMetadataStr ?? JSON.stringify(metadata);
      resolvedRouting = routing;
      resolvedMetadata = metadata;
      resolvedMetadataStr = metadataStr;
      return { routing, metadata, metadataStr };
    };

    // Resolve and validate every worker setting before claiming created→live.
    // A bad model/effort must leave the session retryable instead of producing
    // a live database row with no worker dispatched into its room. Healthy live
    // reconnects do not need new worker metadata and remain usable if an admin
    // is in the middle of changing model configuration.
    const preparedRoom = session.status === 'created' ? resolveRoomConfig() : undefined;

    let agentDispatched = !!session.agentDispatchId;
    let recording = !!session.egressId || !!session.recordingKey;

    // Atomically CLAIM the created→live transition so EXACTLY ONE concurrent
    // connect call dispatches the agent. Two near-simultaneous calls — React
    // StrictMode double-invoking the effect in dev, a double-click, a retry, or
    // two tabs — would otherwise both see status='created' and both dispatch the
    // agent, putting TWO interviewers in one room (overlapping voices + doubled
    // transcript). updateMany is atomic: only the winner gets count===1.
    const claim = await prisma.interviewSession.updateMany({
      where: { id: session.id, status: 'created' },
      data: {
        status: 'live',
        startedAt: session.startedAt ?? new Date(),
        participantIdentity: identity,
        voice: voice as unknown as object,
        ...(preparedRoom
          ? {
              // Persist the exact worker namespace dispatched for this session.
              // Usage callbacks can then price missing model metadata correctly
              // even if an admin hot-changes LLM_INTERVIEW_MODEL mid-interview.
              blueprint: withLiveLlmSnapshot(
                session.blueprint,
                preparedRoom.routing,
              ) as unknown as object,
            }
          : {}),
      },
    });

    if (claim.count === 1) {
      // We are the SOLE dispatcher for this session.
      const { routing, metadata, metadataStr } = resolveRoomConfig();
      // Surface EVERY model this mock interview will use, in the INFO log /
      // terminal console, at the moment the interview starts. Covers the live
      // worker pipeline (LLM · STT + fallbacks · TTS voice) and the backend
      // agents (blueprint · evaluation · coach, all on the interview model).
      logger.info('INTERVIEW_ENGINE_MODELS', `mock interview models · session ${session.id}`, {
        sessionId: session.id,
        role: session.role,
        interviewType: session.interviewType,
        mode,
        language: session.language,
        ...describeSessionModels(voice, metadata.llm, routing.backendModel),
        requestId: params.requestId,
      });

      // Room create + agent dispatch are on the critical path, but a slow or
      // unavailable LiveKit must NEVER hang the connect request — wrap each in a
      // timeout. The candidate's join token is what actually matters.
      const { sid } = await withTimeout(
        provider.createRoom({ roomName: session.roomName, metadata: metadataStr }),
        8000,
        { sid: null as string | null },
      );

      // Race the dispatch for the response (a slow LiveKit must not hang the
      // connect), but do NOT discard a slow-but-successful dispatch id: persist
      // it whenever it lands so the reconnect path can tell "dispatched late"
      // apart from "never dispatched" (and won't double-dispatch).
      const dispatchPromise = provider.dispatchAgent({ roomName: session.roomName, metadata: metadataStr });
      dispatchPromise
        .then((id) => (id ? this.persistDispatchIdIfUnset(session.id, id) : undefined))
        .catch((err) => {
          logger.warn('INTERVIEW_ENGINE_SESSION', 'agent dispatch promise rejected', {
            sessionId: session.id, error: err instanceof Error ? err.message : String(err),
          });
        });
      const agentDispatchId = await withTimeout(dispatchPromise, 8000, null as string | null);
      agentDispatched = !!agentDispatchId;

      // Plan the recording key now, but START egress in the BACKGROUND so a slow
      // or unconfigured Egress service never blocks the candidate from joining.
      // recordingKey is deliberately NOT persisted here: the row would advertise
      // a recording (serialize's recordingAvailable, getReport's presign) that a
      // failed egress start never writes. startRecordingInBackground persists
      // key + mime only once egress actually starts; the egress_ended webhook
      // (handleEgressEnded) stays the completion source of truth.
      //
      // H8 (WP-43): the env switch and storage are necessary, never
      // sufficient. Egress starts only for a session whose create-time
      // consent check said so; video frames only with the second opt-in.
      const consented = readPracticeRecording(session);
      if (consented.audio && isRecordingEnabled(seam.brand) && interviewR2Storage.isConfigured()) {
        recording = true;
        void this.startRecordingInBackground(
          provider,
          session.id,
          session.roomName,
          interviewR2Storage.recordingKey(session.id, 'mp4'),
          consented.video && mode === 'video' && provider.media.recordVideo ? 'video' : 'voice',
        );
      }

      await prisma.interviewSession.update({
        where: { id: session.id },
        data: {
          livekitRoomSid: sid ?? session.livekitRoomSid,
          // undefined (not null) when the race timed out — a late-resolving
          // dispatch id persisted by the hook above must not be wiped here.
          agentDispatchId: agentDispatchId ?? undefined,
        },
      });
    } else {
      // Lost the claim (a concurrent call dispatched) OR this is a reconnect to
      // an already-live session — normally reflect current state and DO NOT
      // dispatch again.
      const fresh = await prisma.interviewSession.findUnique({
        where: { id: session.id },
        select: { status: true, agentDispatchId: true, egressId: true, recordingKey: true },
      });
      agentDispatched = !!fresh?.agentDispatchId;
      recording = !!fresh?.egressId || !!fresh?.recordingKey;

      // EXCEPTION: a live session with NO recorded dispatch id means the
      // original dispatch failed or timed out — the room has no interviewer
      // and would otherwise stay silent forever. The frontend retries connect
      // on a silent room, so re-dispatching here makes that mode self-heal.
      // persistDispatchIdIfUnset is only-if-unset, so concurrent retries that
      // both dispatch converge on one recorded id.
      if (fresh && fresh.status === 'live' && !fresh.agentDispatchId) {
        const { metadataStr } = resolveRoomConfig();
        const redispatchPromise = provider.dispatchAgent({
          roomName: session.roomName,
          metadata: metadataStr,
        });
        redispatchPromise
          .then((id) => (id ? this.persistDispatchIdIfUnset(session.id, id) : undefined))
          .catch((err) => {
            logger.warn('INTERVIEW_ENGINE_SESSION', 'agent re-dispatch promise rejected', {
              sessionId: session.id, error: err instanceof Error ? err.message : String(err),
            });
          });
        const redispatchId = await withTimeout(redispatchPromise, 8000, null as string | null);
        if (redispatchId) {
          agentDispatched = true;
          logger.info('INTERVIEW_ENGINE_SESSION', 'agent re-dispatched into live session without interviewer', {
            sessionId: session.id, dispatchId: redispatchId, requestId: params.requestId,
          });
        }
      }
    }

    // Mint (or re-mint) the join token.
    const joinMeta = JSON.stringify({ role: 'candidate', sessionId: session.id, name: session.candidateName ?? undefined });
    const tok = await provider.mintClientToken({
      roomName: session.roomName,
      identity,
      name: session.candidateName ?? 'Candidate',
      allowVideo: mode === 'video',
      ttlSeconds,
      metadata: joinMeta,
    });

    logger.info('INTERVIEW_ENGINE_SESSION', 'connection issued', {
      sessionId: session.id, roomName: session.roomName, mode, agentDispatched, recording, requestId: params.requestId,
    });

    return {
      sessionId: session.id,
      url: tok.url,
      token: tok.token,
      roomName: session.roomName,
      identity,
      mode,
      language: session.language,
      voice,
      expiresAt: tok.expiresAt.toISOString(),
      agentDispatched,
      recording,
      cameraPublish: mode === 'video' && provider.media.cameraPublish,
    };
  }

  /** Record a dispatch id ONLY if none is set yet. Both the late-resolving
   *  dispatch hook and the reconnect re-dispatch can race the primary connect
   *  write (and each other) — only-if-unset makes every order converge on one
   *  recorded id. Best-effort; never throws. */
  private async persistDispatchIdIfUnset(sessionId: string, dispatchId: string): Promise<void> {
    try {
      const res = await prisma.interviewSession.updateMany({
        where: { id: sessionId, agentDispatchId: null },
        data: { agentDispatchId: dispatchId },
      });
      if (res.count === 1) {
        logger.info('INTERVIEW_ENGINE_SESSION', 'agent dispatch id persisted', { sessionId, dispatchId });
      }
    } catch (err) {
      logger.warn('INTERVIEW_ENGINE_SESSION', 'dispatch id persist failed', {
        sessionId, dispatchId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Start Egress recording out-of-band. recordingKey/mime are persisted HERE,
   *  only once egress has actually started — a failed start leaves them unset
   *  so the session never advertises a recording that was never written. */
  private async startRecordingInBackground(
    provider: VoiceSessionProvider,
    sessionId: string,
    roomName: string,
    filepath: string,
    mode: InterviewMode,
  ): Promise<void> {
    try {
      const rec = await provider.startRecording({ roomName, filepath, audioOnly: mode === 'voice' });
      if (rec) {
        await prisma.interviewSession.update({
          where: { id: sessionId },
          data: {
            egressId: rec.egressId,
            recordingKey: rec.filepath,
            recordingMimeType: recordingMimeForMode(mode),
          },
        });
      }
    } catch (err) {
      logger.warn('INTERVIEW_ENGINE_SESSION', 'background recording start failed', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private buildRoomMetadata(
    session: InterviewSession,
    voice: ResolvedVoice,
    llmRouting: InterviewLlmRouting,
    brand: BrandId,
  ): InterviewRoomMetadata {
    const stt = resolveBrandStt(brand, session.language);
    // GoApply: every speech model in the worker metadata must be domestic.
    assertBrandSpeech(brand, voice, stt);
    const blueprint = (session.blueprint ?? {}) as Record<string, unknown>;
    const openingInstruction = typeof blueprint.openingInstruction === 'string' ? blueprint.openingInstruction : `Greet the candidate and begin the ${session.interviewType} interview.`;
    const openingLine = typeof blueprint.openingLine === 'string' ? blueprint.openingLine : '';
    // A blank openingLine (legacy rows generated before openingLine was persisted)
    // makes the worker greet via the LLM path instead of the deterministic line.
    // That path is resilient now (client-side TTS FallbackAdapter + greeting
    // watchdog), so it's no longer a silence risk — but recomputing the
    // deterministic line here would need the persona name (not available at this
    // call site) and could speak a placeholder, so we log it instead of guessing.
    if (!openingLine) {
      logger.warn('INTERVIEW_ENGINE_SESSION', 'session has no deterministic openingLine — worker will greet via LLM', {
        sessionId: session.id,
        language: session.language,
      });
    }
    return {
      kind: 'interview-engine',
      sessionId: session.id,
      mode: session.mode as InterviewMode,
      language: session.language,
      durationMinutes: session.plannedDurationMinutes,
      systemPrompt: session.interviewPrompt ?? 'You are a professional interviewer. Conduct a thoughtful interview.',
      openingInstruction,
      openingLine,
      voice,
      stt,
      llm: {
        model: llmRouting.workerModel,
        ...(llmRouting.reasoningEffort
          ? { reasoningEffort: llmRouting.reasoningEffort }
          : {}),
      },
      // C13: the origin captured from the create request (production, when
      // INTERVIEW_ENGINE_CALLBACK_BASE_URL is unset); env still wins.
      callbackBaseUrl: getCallbackBaseUrl(
        readSessionControl(session.liveMetrics).callbackBaseUrl,
        brand,
      ),
    };
  }

  // ─── Transcript ingest (worker callback) ──────────────────────────────────

  async ingestTranscript(params: {
    sessionId: string;
    secret: string | undefined;
    turns: TranscriptTurn[];
  }): Promise<{ ok: true; total: number }> {
    await this.assertCallbackSecret(params.sessionId, params.secret);
    // C11: the worker retries failed batches, so a turn can arrive twice —
    // dedupe on (role, ts) within the batch here and against the stored
    // transcript in the statement below.
    const incoming = dedupeTurnsByKey(sanitizeTurns(params.turns));

    // Single-statement jsonb append: atomic under concurrent worker flushes
    // (a read-modify-write here loses interleaved batches) AND status-guarded
    // in the same statement (turns arriving after 'completed' are dropped, not
    // resurrected onto an already-scored session). The NOT EXISTS filter drops
    // turns already stored with the same (role, ts); under concurrent updates
    // Postgres re-evaluates it against the row version it finally locks.
    // RETURNING gives the post-append length without a second round-trip.
    const rows = await prisma.$queryRawUnsafe<Array<{ total: number }>>(
      `UPDATE "InterviewSession" AS s
          SET transcript = COALESCE(s.transcript, '[]'::jsonb) || COALESCE((
                SELECT jsonb_agg(n.elem ORDER BY n.idx)
                  FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS n(elem, idx)
                 WHERE NOT EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(COALESCE(s.transcript, '[]'::jsonb)) AS o(elem)
                    WHERE o.elem->>'role' = n.elem->>'role'
                      AND o.elem->'ts' = n.elem->'ts'
                 )
              ), '[]'::jsonb),
              "updatedAt" = now()
        WHERE s.id = $2 AND s.status IN ('created', 'live', 'finalizing')
        RETURNING jsonb_array_length(s.transcript) AS total`,
      JSON.stringify(incoming),
      params.sessionId,
    );
    if (rows.length === 0) {
      logger.warn('INTERVIEW_ENGINE_SESSION', 'transcript turns dropped (unknown session or already completed)', {
        sessionId: params.sessionId, dropped: incoming.length,
      });
      return { ok: true, total: 0 };
    }

    let total = Number(rows[0]?.total ?? 0);
    if (total > MAX_TRANSCRIPT_TURNS) {
      // The cap is a memory guard, not an invariant — trim the head (keep the
      // newest turns) best-effort; a failed trim must not fail the ingest.
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE "InterviewSession"
              SET transcript = (
                SELECT COALESCE(jsonb_agg(elem ORDER BY idx), '[]'::jsonb)
                  FROM jsonb_array_elements(transcript) WITH ORDINALITY AS t(elem, idx)
                 WHERE idx > jsonb_array_length(transcript) - $1::int
              )
            WHERE id = $2 AND jsonb_array_length(COALESCE(transcript, '[]'::jsonb)) > $1::int`,
          MAX_TRANSCRIPT_TURNS,
          params.sessionId,
        );
        total = MAX_TRANSCRIPT_TURNS;
      } catch (err) {
        logger.warn('INTERVIEW_ENGINE_SESSION', 'transcript tail trim failed', {
          sessionId: params.sessionId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { ok: true, total };
  }

  /** Worker lifecycle callback: 'started' | 'ended' | 'error'. 'started'
   *  records join telemetry into liveMetrics.worker; 'error' records the
   *  failure (C9); 'ended' marks the worker drained and triggers finalize. */
  async workerLifecycle(params: {
    sessionId: string;
    secret: string | undefined;
    event: string;
    joinMs?: number;
    greeting?: string;
    greetingMs?: number;
    clientReady?: unknown;
    reason?: string;
    message?: string;
  }): Promise<void> {
    await this.assertCallbackSecret(params.sessionId, params.secret);
    if (params.event === 'started') {
      logger.info('INTERVIEW_ENGINE_SESSION', 'worker started', {
        sessionId: params.sessionId, joinMs: params.joinMs, greeting: params.greeting,
        greetingMs: params.greetingMs, clientReady: params.clientReady,
      });
      // Telemetry merge is best-effort — a metrics write must never fail the
      // worker's lifecycle ping (the worker treats a non-2xx as a real error).
      try {
        const row = await prisma.interviewSession.findUnique({
          where: { id: params.sessionId },
          select: { liveMetrics: true },
        });
        if (row) {
          const metrics = asLiveMetrics(row.liveMetrics);
          metrics.worker = {
            ...(metrics.worker ?? {}),
            startedAt: new Date().toISOString(),
            ...(typeof params.joinMs === 'number' && Number.isFinite(params.joinMs) ? { joinMs: params.joinMs } : {}),
            ...(typeof params.greeting === 'string' && params.greeting ? { greeting: params.greeting.slice(0, 500) } : {}),
            ...(typeof params.greetingMs === 'number' && Number.isFinite(params.greetingMs) ? { greetingMs: params.greetingMs } : {}),
            ...(params.clientReady !== undefined ? { clientReady: compactTelemetryValue(params.clientReady) } : {}),
          };
          await prisma.interviewSession.update({
            where: { id: params.sessionId },
            data: { liveMetrics: metrics as unknown as object },
          });
        }
      } catch (err) {
        logger.warn('INTERVIEW_ENGINE_SESSION', 'worker started telemetry merge failed', {
          sessionId: params.sessionId, error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (params.event === 'error') {
      await this.handleWorkerError(params.sessionId, params.reason, params.message);
      return;
    }
    if (params.event === 'ended') {
      await this.markWorkerEnded(params.sessionId);
      // The worker posts 'ended' after its own transcript/metrics/usage drain,
      // so finalize can skip the flush grace (the late-turn recheck remains).
      await this.finalize(params.sessionId, { workerDrained: true }).catch((err) => {
        logger.error('INTERVIEW_ENGINE_SESSION', 'finalize from worker lifecycle failed', {
          sessionId: params.sessionId, error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /** Atomically stamp liveMetrics.workerEndedAt (epoch ms). endByOwner polls
   *  it to know the worker's drain finished. Best-effort. */
  private async markWorkerEnded(sessionId: string): Promise<void> {
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "InterviewSession"
            SET "liveMetrics" = COALESCE("liveMetrics", '{}'::jsonb) || jsonb_build_object('workerEndedAt', $2::bigint)
          WHERE id = $1`,
        sessionId,
        Date.now(),
      );
    } catch (err) {
      logger.warn('INTERVIEW_ENGINE_SESSION', 'worker ended stamp failed', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * C9: the worker reports a pipeline failure ({event:'error', reason,
   * message}). Recorded in session.error + liveMetrics.worker.errors and
   * logged at error level. With zero candidate turns the interview never
   * happened: the session is marked 'failed' (never charged) and its room is
   * torn down; otherwise it is recorded and the interview finalizes normally.
   */
  private async handleWorkerError(sessionId: string, reason?: string, message?: string): Promise<void> {
    const code = sanitizeWorkerReason(reason) || 'worker_error';
    const detail = typeof message === 'string' ? message.slice(0, 500) : undefined;
    logger.error('INTERVIEW_ENGINE_SESSION', 'worker reported an error', { sessionId, reason: code, message: detail });

    const row = await prisma.interviewSession.findUnique({
      where: { id: sessionId },
      select: {
        status: true, error: true, transcript: true, liveMetrics: true, roomName: true, egressId: true, endedAt: true,
        userId: true, brand: true, voiceProvider: true,
      },
    });
    if (!row) return;

    const metrics = asLiveMetrics(row.liveMetrics);
    const worker = { ...(metrics.worker ?? {}) } as Record<string, unknown>;
    worker.errors = capTail(worker.errors, [{ reason: code, ...(detail ? { message: detail } : {}), ts: Date.now() }], 20);
    metrics.worker = worker;

    const active = row.status === 'created' || row.status === 'live' || row.status === 'finalizing';
    if (active && countCandidateTurns(row.transcript) === 0) {
      const res = await prisma.interviewSession.updateMany({
        where: { id: sessionId, status: row.status },
        data: {
          status: 'failed',
          error: code,
          endedAt: row.endedAt ?? new Date(),
          durationSec: 0,
          liveMetrics: metrics as unknown as object,
        },
      });
      if (res.count === 1) {
        logger.error('INTERVIEW_ENGINE_SESSION', 'session failed by worker error before any answer (not charged)', {
          sessionId, reason: code, fromStatus: row.status,
        });
        const provider = safeProvider(await resolveSessionSeam(row));
        if (provider) {
          if (row.egressId) void provider.stopRecording(row.egressId).catch(() => { /* best-effort */ });
          void provider.deleteRoom(row.roomName).catch(() => { /* best-effort */ });
        }
        return;
      }
    }
    await prisma.interviewSession.update({
      where: { id: sessionId },
      data: {
        // Keep a terminal row's existing code (e.g. no_answer) — the UI keys on it.
        ...(row.error ? {} : { error: code }),
        liveMetrics: metrics as unknown as object,
      },
    }).catch((err) => {
      logger.warn('INTERVIEW_ENGINE_SESSION', 'worker error record failed', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** Worker callback: per-turn latency metrics + worker telemetry, batched.
   *  Secret-gated like the transcript callback. Appends into
   *  liveMetrics.events (tail-capped) and emits ONE aggregate log line —
   *  worker callbacks have no requestId, so that line IS the observability
   *  for this path. */
  async ingestMetrics(params: {
    sessionId: string;
    secret: string | undefined;
    events: unknown;
  }): Promise<{ ok: true; stored: number }> {
    await this.assertCallbackSecret(params.sessionId, params.secret);
    const events = sanitizeMetricEvents(params.events);
    const row = await prisma.interviewSession.findUnique({
      where: { id: params.sessionId },
      select: { liveMetrics: true },
    });
    if (!row) throw new InterviewNotFoundError();

    // Read-modify-write is acceptable here (unlike the transcript): metrics
    // are diagnostic, and a lost batch under a rare concurrent write costs
    // observability, never correctness.
    const metrics = asLiveMetrics(row.liveMetrics);
    metrics.events = capTail(metrics.events, events, MAX_STORED_WORKER_METRIC_EVENTS);
    await prisma.interviewSession.update({
      where: { id: params.sessionId },
      data: { liveMetrics: metrics as unknown as object },
    });

    logger.info('INTERVIEW_ENGINE_METRICS', 'worker metrics ingested', {
      sessionId: params.sessionId,
      batch: events.length,
      ...summarizeMetricEvents(events),
    });
    return { ok: true, stored: events.length };
  }

  /** First-party client telemetry (join timings, connection quality, UI
   *  events) from the live room. Ownership-scoped; the route swallows every
   *  failure so telemetry can never break an interview. */
  async ingestClientEvents(params: {
    sessionId: string;
    userId: string;
    events: unknown;
  }): Promise<{ ok: true; stored: number }> {
    const events = sanitizeClientEvents(params.events);
    if (events.length === 0) return { ok: true, stored: 0 };

    const session = await this.loadOwned(params.userId, params.sessionId);
    const metrics = asLiveMetrics(session.liveMetrics);
    metrics.clientEvents = capTail(metrics.clientEvents, events, MAX_STORED_CLIENT_EVENTS);
    await prisma.interviewSession.update({
      where: { id: session.id },
      data: { liveMetrics: metrics as unknown as object },
    });

    logger.info('INTERVIEW_ENGINE_METRICS', 'client events ingested', {
      sessionId: session.id,
      batch: events.length,
      types: Array.from(new Set(events.map((e) => e.type))),
    });
    return { ok: true, stored: events.length };
  }

  // ─── Webhook handlers (LiveKit) ───────────────────────────────────────────

  /**
   * @param params.signerBrand the brand whose LiveKit project signed the
   *   webhook (`receiveBrandWebhook`). When given, an event for a session of
   *   the other brand is ignored, so one brand's project can never touch the
   *   other brand's sessions.
   */
  async handleEgressEnded(params: { egressId?: string; roomName?: string; sizeBytes?: number; durationSec?: number; location?: string; signerBrand?: BrandId }): Promise<void> {
    const where = params.egressId ? { egressId: params.egressId } : params.roomName ? { roomName: params.roomName } : null;
    if (!where) return;
    const session = await prisma.interviewSession.findFirst({ where, select: { id: true, mode: true, recordingKey: true, liveMetrics: true, recordingConsent: true, userId: true, brand: true, voiceProvider: true } });
    if (!session) return;
    const seam = await resolveSessionSeam(session);
    if (!webhookSignerMatches(params.signerBrand, seam, session.id, 'egress_ended')) return;
    // A video session recorded without the camera opt-in is audio-only (H8);
    // GoApply records audio only, always (CN L-11).
    const recordedMode = session.mode === 'video' && readPracticeRecording(session).video && getInterviewMediaPolicy(seam.brand).recordVideo
      ? 'video'
      : 'voice';
    // This webhook is the completion source of truth: a non-empty file result
    // means the recording really exists in R2, so backfill recordingKey if the
    // background-start persist was lost (restart between egress start and the
    // DB write). Mime follows the session mode — voice egress is audioOnly.
    const producedFile = typeof params.sizeBytes === 'number' && params.sizeBytes > 0;
    await prisma.interviewSession.update({
      where: { id: session.id },
      data: {
        recordingBytes: typeof params.sizeBytes === 'number' ? params.sizeBytes : undefined,
        recordingDurationSec: typeof params.durationSec === 'number' ? params.durationSec : undefined,
        recordingKey: session.recordingKey ?? (producedFile ? interviewR2Storage.recordingKey(session.id, 'mp4') : undefined),
        recordingMimeType: session.recordingKey || producedFile ? recordingMimeForMode(recordedMode) : undefined,
      },
    });
    // Meter the recording's egress + storage cost (no-op until a rate is set).
    if (typeof params.sizeBytes === 'number' && params.sizeBytes > 0) {
      void recordRecordingCost(session.id, params.sizeBytes, params.durationSec ?? 0);
    }
    logger.info('INTERVIEW_ENGINE_SESSION', 'egress ended', { sessionId: session.id, sizeBytes: params.sizeBytes, durationSec: params.durationSec });
  }

  /** @param signerBrand see handleEgressEnded. */
  async handleRoomFinished(roomName: string, signerBrand?: BrandId): Promise<void> {
    const session = await prisma.interviewSession.findFirst({ where: { roomName }, select: { id: true, status: true, liveMetrics: true, userId: true, brand: true, voiceProvider: true } });
    if (!session) return;
    if (!webhookSignerMatches(signerBrand, await resolveSessionSeam(session), session.id, 'room_finished')) return;
    if (NON_FINALIZABLE.includes(session.status)) return;
    await this.finalize(session.id).catch((err) => {
      logger.error('INTERVIEW_ENGINE_SESSION', 'finalize from room_finished failed', {
        sessionId: session.id, error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ─── Finalize + score ─────────────────────────────────────────────────────

  /** End the session: stop egress, persist transcript to R2, score → report.
   *  Idempotent — reachable from 3 paths (candidate end, room_finished webhook,
   *  worker 'ended' lifecycle), so a no-op once we're already finalizing. */
  async finalize(sessionId: string, opts: { workerDrained?: boolean } = {}): Promise<InterviewSession> {
    const session = await prisma.interviewSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new InterviewNotFoundError();
    return inBrand((await resolveSessionSeam(session)).brand, () => this.finalizeLoaded(session, opts));
  }

  private async finalizeLoaded(session: InterviewSession, opts: { workerDrained?: boolean }): Promise<InterviewSession> {
    const sessionId = session.id;
    // Terminal rows (completed / failed / expired) and an in-flight finalize
    // are never re-claimed: a late room_finished webhook or worker 'ended'
    // must not turn a failed (uncharged) session into a completed one.
    if (NON_FINALIZABLE.includes(session.status)) return session;

    // Atomically CLAIM the terminal transition so EXACTLY ONE of the converging
    // finalize triggers proceeds. finalize() is reachable concurrently from the
    // worker 'ended' lifecycle, the LiveKit room_finished webhook, AND candidate
    // endByOwner — a normal teardown fires several within milliseconds. The old
    // read-check-then-write guard was a TOCTOU: two callers could both observe
    // 'live', both pass, and both run _enrichReport → a duplicate evaluation LLM
    // spend AND a duplicate mock_interview cost ledger row. updateMany is atomic;
    // only the winner gets count===1 (mirrors the created→live claim above).
    const claim = await prisma.interviewSession.updateMany({
      where: { id: sessionId, status: { notIn: NON_FINALIZABLE } },
      data: { status: 'finalizing', endedAt: session.endedAt ?? new Date() },
    });
    if (claim.count !== 1) {
      // Lost the race — another trigger is already finalizing/completed. Re-read
      // so we return the current row rather than our pre-claim snapshot.
      const current = await prisma.interviewSession.findUnique({ where: { id: sessionId } });
      return current ?? session;
    }
    return this.finalizeClaimed(session, opts);
  }

  /** The body of finalize() for a row this caller already moved to
   *  'finalizing' (finalize's own claim, or endByOwner's). */
  private async finalizeClaimed(
    session: InterviewSession,
    opts: { workerDrained?: boolean } = {},
  ): Promise<InterviewSession> {
    const sessionId = session.id;
    // A session that never went live has no room, egress or worker to drain.
    const wentLive = !!(session.startedAt || session.livekitRoomSid || session.agentDispatchId);
    const parley = isParleySession(session);

    if (wentLive && !parley) {
      const provider = safeProvider(await resolveSessionSeam(session));
      if (provider) {
        // Stop recording if still active (best-effort).
        if (session.egressId) await provider.stopRecording(session.egressId);
        // Tear down the room (best-effort; releases the worker).
        await provider.deleteRoom(session.roomName);
      }
    }
    if (wentLive && parley && !opts.workerDrained) {
      // Parley finalizing without a drain (lost webhook, expiry sweep): pull
      // the transcript from Parley; there is no worker flush to wait for.
      await pullParleyTranscript(this, session);
      opts = { ...opts, workerDrained: true };
    }

    const readTurns = async (): Promise<TranscriptTurn[] | null> => {
      try {
        const fresh = await prisma.interviewSession.findUnique({
          where: { id: sessionId },
          select: { transcript: true },
        });
        return fresh ? sortTurnsByTs(asTranscript(fresh.transcript)) : null;
      } catch (err) {
        logger.warn('INTERVIEW_ENGINE_SESSION', 'transcript re-read failed', {
          sessionId, error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    };

    // Persist transcript to R2 (best-effort) — JSON + plaintext sidecar.
    // Callable twice: the late-turn recheck below re-uploads so the R2
    // artifacts always match the scored transcript.
    const uploadTranscript = async (t: TranscriptTurn[]): Promise<{ key: string | null; text: string }> => {
      const text = renderTranscriptText(t, session.candidateName ?? 'Candidate');
      if (!interviewR2Storage.isConfigured() || t.length === 0) return { key: null, text };
      try {
        const jsonKey = interviewR2Storage.transcriptJsonKey(sessionId);
        const txtKey = interviewR2Storage.transcriptTextKey(sessionId);
        await interviewR2Storage.putObject({ key: jsonKey, body: JSON.stringify({ sessionId, turns: t }, null, 2), contentType: 'application/json' });
        await interviewR2Storage.putObject({ key: txtKey, body: text, contentType: 'text/plain; charset=utf-8' });
        return { key: jsonKey, text };
      } catch (err) {
        logger.warn('INTERVIEW_ENGINE_SESSION', 'transcript R2 upload failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
        return { key: null, text };
      }
    };

    // Room deletion triggers worker shutdown, whose final transcript flush is
    // a fire-and-forget POST that can land AFTER our pre-claim snapshot was
    // read — scoring that snapshot would silently drop the last answer(s).
    // Give the flush a short grace window, then re-read. Stable ts-sort:
    // batches from different flushes can arrive interleaved out of order.
    if (wentLive && !opts.workerDrained) await sleep(TRANSCRIPT_FLUSH_GRACE_MS);
    let turns = sortTurnsByTs(asTranscript(session.transcript));
    const reread = await readTurns();
    if (reread) turns = reread;

    // C10: no candidate answer was ever recorded — there is nothing to score.
    // No LLM evaluation, no cost ledger, no credit debit; the report page shows
    // a plain "no answers were recorded, you were not charged" state.
    if (countCandidateTurns(turns) === 0 && wentLive && !opts.workerDrained) {
      // An older worker's shutdown drain can outlast the grace; one more look
      // before declaring that nothing was said.
      await sleep(TRANSCRIPT_FLUSH_GRACE_MS);
      const late = await readTurns();
      if (late) turns = late;
    }
    if (countCandidateTurns(turns) === 0) {
      return this.finalizeNoAnswer(session, turns);
    }

    // Score.
    const persona = session.personaId ? findPersona(session.personaId) : undefined;
    const difficulty = (session.characteristics as any)?.difficulty ?? (persona ? persona.difficulty * 1.6 : 3);
    let score = scoreTranscript(turns, Math.round(difficulty), session.language);
    let uploaded = await uploadTranscript(turns);

    // LATE-TURN RECHECK: the worker's shutdown drain retries for up to ~12s —
    // longer than the flush grace — and ingest still accepts turns while we
    // hold 'finalizing'. One re-read before committing 'completed'; if turns
    // landed during scoring/upload, redo the (cheap, deterministic) score and
    // the R2 transcript artifacts on the fresh read. LLM enrichment gets the
    // fresh turns too.
    const recheck = await readTurns();
    if (recheck && recheck.length > turns.length) {
      logger.info('INTERVIEW_ENGINE_SESSION', 'late transcript turns landed during scoring; re-scored', {
        sessionId, turnsBefore: turns.length, turnsAfter: recheck.length,
      });
      turns = recheck;
      score = scoreTranscript(turns, Math.round(difficulty), session.language);
      const redo = await uploadTranscript(turns);
      // A failed re-upload must not discard the first upload's key.
      uploaded = { key: redo.key ?? uploaded.key, text: redo.text };
    }

    const transcriptKey: string | null = uploaded.key ?? session.transcriptKey;
    const transcriptText: string | null = uploaded.text;

    // Bill PARTICIPATION (transcript ts span), not wall-clock: a no-show who
    // connected and never spoke must not be billed the 15+ min the room's
    // emptyTimeout takes to tear down. Wall-clock stays as the ceiling so
    // clock-skewed worker timestamps can't inflate the value.
    const wallClockSec = session.startedAt
      ? Math.max(0, Math.round((Date.now() - new Date(session.startedAt).getTime()) / 1000))
      : null;
    const durationSec = computeParticipationDurationSec(turns, wallClockSec);

    // Persist the report to R2 too (best-effort).
    if (interviewR2Storage.isConfigured()) {
      try {
        await interviewR2Storage.putObject({
          key: interviewR2Storage.reportKey(sessionId),
          body: JSON.stringify({ sessionId, score, durationSec }, null, 2),
          contentType: 'application/json',
        });
      } catch { /* best-effort */ }
    }

    const updated = await prisma.interviewSession.update({
      where: { id: sessionId },
      data: {
        status: 'completed',
        endedAt: session.endedAt ?? new Date(),
        transcriptKey,
        transcriptText,
        overall: score.overall,
        breakdown: score.breakdown as unknown as object,
        strengths: score.strengths,
        gaps: score.gaps,
        summary: score.summary,
        report: { version: 'deterministic', score, durationSec } as unknown as object,
        // The billable participation duration (minutes used) — transcript ts
        // span capped by wall-clock. LLM/STT/TTS cost is metered separately
        // across the lifecycle; the ledger is written once the evaluation
        // stage completes (in _enrichReport).
        durationSec,
      },
    });

    logger.info('INTERVIEW_ENGINE_SESSION', 'session finalized', {
      sessionId, overall: score.overall, turns: turns.length, durationSec,
    });

    // WP-43: a finished candidate practice ticks "Do a practice interview" on
    // the getting-started checklist and the job's "Practiced" step. Only the
    // finalize claim winner reaches this line; the hook is idempotent anyway.
    if (updated.source === 'roboapply') {
      void this.markPracticeCompleted(updated).catch(() => undefined);
      // GoApply: the report is ready to read — say so in WeChat when the
      // person asked for it at practice start (soft; once per report).
      void notifyPracticeReportReady({
        target: 'live',
        sessionId,
        userId: updated.userId,
        // The session's own brand (column, else liveMetrics, else the owner's).
        cn: async () => getBrand((await resolveSessionSeam(updated)).brand).market === 'cn',
        title: updated.role,
        completedAt: updated.endedAt ?? new Date(),
      });
    }

    // Phase B: LLM enrichment, FIRE-AND-FORGET. The session is already
    // 'completed' with a usable deterministic report; this PATCHes the rich,
    // localized report (per-question analysis + concrete recommendations) when
    // it lands. The report page polls until report.version === '2'. We do NOT
    // await it: finalize() runs from webhook/lifecycle paths where a 15-20s wait
    // would risk LiveKit webhook timeouts/retries. _enrichReport never throws;
    // the .catch is belt-and-suspenders.
    void this._enrichReport(sessionId, session, turns, score, durationSec).catch((err) => {
      logger.error('INTERVIEW_ENGINE_SESSION', 'LLM enrichment crashed', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    });

    return updated;
  }

  /** Terminal state for a finalize with zero candidate turns (C10). */
  private async finalizeNoAnswer(session: InterviewSession, turns: TranscriptTurn[]): Promise<InterviewSession> {
    const res = await prisma.interviewSession.updateMany({
      where: { id: session.id, status: 'finalizing' },
      data: {
        status: 'failed',
        error: 'no_answer',
        endedAt: session.endedAt ?? new Date(),
        durationSec: 0,
      },
    });
    const current = await prisma.interviewSession.findUnique({ where: { id: session.id } });
    logger.info('INTERVIEW_ENGINE_SESSION', 'session ended with no candidate answer (not charged)', {
      sessionId: session.id, turns: turns.length, applied: res.count === 1,
    });
    if (!current) throw new InterviewNotFoundError();
    return current;
  }

  /**
   * Background LLM enrichment: runs the multi-agent evaluation and PATCHes the
   * flat report columns + the rich `report` JSON. NEVER THROWS — a failure
   * leaves the deterministic report in place. Not resumable across a process
   * restart, but a report stranded that way self-heals: maybeReenrichOnRead
   * re-fires this (attempt-capped) from the next report read.
   */
  private async _enrichReport(
    sessionId: string,
    session: InterviewSession,
    turns: TranscriptTurn[],
    deterministicScore: InterviewScore,
    durationSec: number | null,
  ): Promise<void> {
    const reqId = generateRequestId();
    logger.startRequest(reqId, '/interview-engine/enrich', 'INTERNAL');
    const t0 = Date.now();
    try {
      const { richReport, flat } = await runInterviewEvaluation(
        session, turns, deterministicScore, durationSec, reqId,
      );

      // Meter the report-evaluation LLM cost (holistic + deep-dive +
      // recommendations all run under reqId). Best-effort.
      await recordEvaluationCost(
        sessionId,
        tokenCostFromSnapshot(logger.getRequestSnapshot(reqId), getTaskModel('interview')),
      );

      // Refresh the R2 report sidecar with the rich version (best-effort).
      if (interviewR2Storage.isConfigured()) {
        void interviewR2Storage.putObject({
          key: interviewR2Storage.reportKey(sessionId),
          body: JSON.stringify({ sessionId, richReport }, null, 2),
          contentType: 'application/json',
        }).catch(() => { /* best-effort */ });
      }

      await prisma.interviewSession.update({
        where: { id: sessionId },
        data: {
          overall: flat.overall,
          breakdown: flat.breakdown as unknown as object,
          strengths: flat.strengths,
          gaps: flat.gaps,
          summary: flat.summary,
          report: richReport as unknown as object,
        },
      });

      logger.info('INTERVIEW_ENGINE_SESSION', 'LLM enrichment persisted', {
        sessionId,
        overall: flat.overall,
        questionCount: richReport.questionAnalysis.length,
        recommendCount: richReport.recommendations.length,
        degraded: richReport.degraded,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      logger.error('INTERVIEW_ENGINE_SESSION', 'LLM enrichment patch failed', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // The evaluation stage is the LAST cost-bearing step, so this is the true
      // end of the session's spend. Recompute totals + write the forensic cost
      // row (mock_interview SKU). Runs even when enrichment degraded, so the
      // blueprint + live + wall-clock costs are still recorded. Never throws.
      await writeMockInterviewLedger(sessionId);
      logger.endRequest(reqId, 'success', 200);
    }
  }

  /**
   * Lazy re-enrichment, fired from report reads: when a 'completed' session's
   * report is still deterministic-only well past finalize, the fire-and-forget
   * _enrichReport was lost (deploy/restart in the window) — re-fire it so a
   * stuck report self-heals on the next visit. The attempt counter lives inside
   * the report JSON (report.enrichAttempts, no schema change) and the claim is
   * a single guarded UPDATE, so concurrent reads (report-page poll + a second
   * tab) elect exactly one re-enricher: the first claim bumps updatedAt, which
   * fails the age condition for the losers. Best-effort; never throws upward.
   */
  private async maybeReenrichOnRead(session: InterviewSession): Promise<void> {
    if (session.status !== 'completed') return;
    const report = (session.report ?? {}) as Record<string, unknown>;
    if (report.version === '2') return; // enrichment already landed
    const attempts = typeof report.enrichAttempts === 'number' ? report.enrichAttempts : 0;
    if (attempts >= REENRICH_MAX_ATTEMPTS) return;
    if (Date.now() - session.updatedAt.getTime() < REENRICH_MIN_AGE_MS) return;

    const claimed = await prisma.$executeRawUnsafe(
      `UPDATE "InterviewSession"
          SET report = jsonb_set(COALESCE(report, '{}'::jsonb), '{enrichAttempts}',
                                 to_jsonb(COALESCE((report->>'enrichAttempts')::int, 0) + 1)),
              "updatedAt" = now()
        WHERE id = $1
          AND status = 'completed'
          AND COALESCE(report->>'version', '') <> '2'
          AND COALESCE((report->>'enrichAttempts')::int, 0) < $2::int
          AND "updatedAt" < now() - ($3::int * interval '1 millisecond')`,
      session.id,
      REENRICH_MAX_ATTEMPTS,
      REENRICH_MIN_AGE_MS,
    );
    if (claimed !== 1) return;

    const turns = sortTurnsByTs(asTranscript(session.transcript));
    // Reuse the deterministic score finalize stored in report.score; recompute
    // only if the blob is unusable (legacy/foreign shape).
    const stored = report.score as InterviewScore | undefined;
    const persona = session.personaId ? findPersona(session.personaId) : undefined;
    const difficulty = (session.characteristics as any)?.difficulty ?? (persona ? persona.difficulty * 1.6 : 3);
    const score = stored && typeof stored.overall === 'number'
      ? stored
      : scoreTranscript(turns, Math.round(difficulty), session.language);

    logger.info('INTERVIEW_ENGINE_SESSION', 'stuck report detected on read; re-firing enrichment', {
      sessionId: session.id, attempt: attempts + 1, turns: turns.length,
    });
    // _enrichReport never throws; its ledger write is idempotent per session.
    void this._enrichReport(session.id, session, turns, score, session.durationSec ?? null).catch((err) => {
      logger.error('INTERVIEW_ENGINE_SESSION', 'lazy re-enrich crashed', {
        sessionId: session.id, error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ─── Expiry reconciliation (cron sweep) ────────────────────────────────────

  /**
   * Finalize-or-expire sessions stranded past expiresAt. The three normal end
   * paths (candidate /end, room_finished webhook, worker 'ended' lifecycle)
   * can ALL be missed — browser died, webhook dropped, process restarted — and
   * nothing else ever transitions the row, so ingested transcript turns never
   * become a report. Sessions with turns run the normal finalize path (report,
   * R2 artifacts, credit ledger); turn-less sessions are marked 'expired'.
   * Stuck 'finalizing' rows are released back to 'live' first so finalize()'s
   * atomic claim can re-run them. The updatedAt quiet-window keeps the sweep
   * away from genuinely active sessions (their ~4s transcript flushes bump
   * updatedAt) and from an in-flight finalize. Idempotent; called from the
   * cron surface (server/src/cron/handlers.ts).
   */
  async reconcileExpiredSessions(now = new Date()): Promise<{ scanned: number; finalized: number; expired: number }> {
    // C3: a 'preparing' row nobody touched for 30 min lost its prepare request
    // (tab closed, function killed). Expire it; it was never charged.
    let staleExpired = 0;
    try {
      const stale = await prisma.interviewSession.updateMany({
        where: { status: 'preparing', updatedAt: { lt: new Date(now.getTime() - STALE_PREPARING_MS) } },
        data: { status: 'expired', endedAt: now },
      });
      staleExpired = stale.count;
      if (staleExpired > 0) {
        logger.info('INTERVIEW_ENGINE_SESSION', 'reconciler expired stale preparing sessions', { count: staleExpired });
      }
    } catch (err) {
      logger.error('INTERVIEW_ENGINE_SESSION', 'stale preparing sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const quietBefore = new Date(now.getTime() - RECONCILE_QUIET_MS);
    const rows = await prisma.interviewSession.findMany({
      where: {
        status: { in: ['created', 'live', 'finalizing'] },
        expiresAt: { lt: now },
        updatedAt: { lt: quietBefore },
      },
      select: { id: true, status: true, transcript: true, endedAt: true, liveMetrics: true },
      orderBy: { expiresAt: 'asc' },
      take: RECONCILE_BATCH_SIZE,
    });

    let finalized = 0;
    let expired = staleExpired;
    for (const row of rows) {
      const turnCount = Array.isArray(row.transcript) ? row.transcript.length : 0;
      // A Parley session's transcript stays on Parley until the interview
      // ends, so zero turns here proves nothing: finalize (which pulls it)
      // instead of expiring a conversation that may have happened.
      const action = row.status !== 'created' && isParleySession(row)
        ? 'finalize'
        : decideReconcileAction(row.status, turnCount);
      try {
        if (action === 'finalize') {
          // finalize() refuses to claim 'finalizing' rows (its idempotency
          // guard) — a quiet-for-10-min 'finalizing' means the process died
          // mid-finalize, so release the claim first. Guarded on status AND
          // the quiet window so a live finalize is never yanked back.
          if (row.status === 'finalizing') {
            const released = await prisma.interviewSession.updateMany({
              where: { id: row.id, status: 'finalizing', updatedAt: { lt: quietBefore } },
              data: { status: 'live' },
            });
            if (released.count !== 1) continue;
          }
          await this.finalize(row.id);
          finalized += 1;
          logger.info('INTERVIEW_ENGINE_SESSION', 'reconciler finalized stranded session', {
            sessionId: row.id, fromStatus: row.status, turns: turnCount,
          });
        } else if (action === 'expire') {
          // Status-guarded so a concurrent legitimate transition wins.
          const res = await prisma.interviewSession.updateMany({
            where: { id: row.id, status: row.status },
            data: { status: 'expired', endedAt: row.endedAt ?? now },
          });
          if (res.count === 1) {
            expired += 1;
            logger.info('INTERVIEW_ENGINE_SESSION', 'reconciler expired stranded session', {
              sessionId: row.id, fromStatus: row.status,
            });
          }
        }
      } catch (err) {
        logger.error('INTERVIEW_ENGINE_SESSION', 'reconcile failed for session', {
          sessionId: row.id, fromStatus: row.status, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (rows.length > 0 || staleExpired > 0) {
      logger.info('INTERVIEW_ENGINE_SESSION', 'reconcile sweep complete', {
        scanned: rows.length + staleExpired, finalized, expired,
      });
    }
    return { scanned: rows.length + staleExpired, finalized, expired };
  }

  // ─── Live usage ingest (worker callback) ──────────────────────────────────

  /** Worker callback: the LiveKit session's aggregated model usage (LLM tokens +
   *  STT/TTS audio), posted at worker shutdown. Prices it and folds it into the
   *  session's cost. Secret-gated; best-effort. */
  async ingestUsage(params: {
    sessionId: string;
    secret: string | undefined;
    modelUsage: LiveModelUsageItem[];
  }): Promise<{ ok: true }> {
    await this.assertCallbackSecret(params.sessionId, params.secret);
    const items = Array.isArray(params.modelUsage) ? params.modelUsage : [];
    const stored = await prisma.interviewSession.findUnique({
      where: { id: params.sessionId },
      select: { blueprint: true },
    }).catch(() => null);
    let fallbackWorkerModel = storedWorkerModel(stored?.blueprint);
    if (!fallbackWorkerModel) {
      try {
        // Legacy session rows predate the persisted liveLlm snapshot.
        fallbackWorkerModel = getWorkerLlmModel();
        // (Legacy rows are RoboApply rows: GoApply sessions always carry the snapshot.)
      } catch {
        // Usage is still recorded as `unreported`; metering must remain best-effort.
      }
    }
    await recordLiveUsage(params.sessionId, items, fallbackWorkerModel);
    logger.info('INTERVIEW_ENGINE_SESSION', 'live usage ingested', {
      sessionId: params.sessionId,
      items: items.length,
    });
    return { ok: true };
  }

  /**
   * Candidate explicitly ends the interview from the UI (C8). A live session
   * is claimed 'finalizing' first (so the report page sees it end at once),
   * the worker is told to wrap up with {type:'end'} on topic 'ie', and we wait
   * up to ~8 s for its 'ended' callback — i.e. its final transcript flush —
   * before deleting the room and scoring. Older workers ignore the message;
   * room deletion plus the flush grace remains their fallback.
   */
  async endByOwner(params: { sessionId: string; userId: string; apiKeyId?: string | null }): Promise<InterviewSession> {
    const session = await this.loadOwned(params.userId, params.sessionId, params.apiKeyId);
    return inBrand((await resolveSessionSeam(session)).brand, () => this.endLoaded(session));
  }

  private async endLoaded(session: InterviewSession): Promise<InterviewSession> {
    if (session.status !== 'live') return this.finalize(session.id);

    const endedAt = session.endedAt ?? new Date();
    const claim = await prisma.interviewSession.updateMany({
      where: { id: session.id, status: 'live' },
      data: { status: 'finalizing', endedAt },
    });
    if (claim.count !== 1) return this.finalize(session.id);

    // Parley: stop the conversation and pull its final transcript directly.
    const parley = isParleySession(session);
    const endProvider = parley ? null : safeProvider(await resolveSessionSeam(session));
    const signalled = endProvider ? await withTimeout(endProvider.sendEndSignal(session.roomName), 3000, false) : false;
    const drained = parley
      ? await drainParleySession(this, session)
      : signalled ? await this.waitForWorkerEnded(session.id, endedAt.getTime()) : false;
    logger.info('INTERVIEW_ENGINE_SESSION', 'candidate ended interview', {
      sessionId: session.id, endSignalSent: signalled, workerDrained: drained, ...(parley ? { transport: 'parley' } : {}),
    });

    const fresh = await prisma.interviewSession.findUnique({ where: { id: session.id } });
    if (!fresh) throw new InterviewNotFoundError();
    // A worker error during the wait may already have failed the session.
    if (fresh.status !== 'finalizing') return fresh;
    return this.finalizeClaimed(fresh, { workerDrained: drained });
  }

  /** Poll liveMetrics.workerEndedAt until the worker's 'ended' callback lands
   *  (stamped at or after `sinceMs`), up to END_SIGNAL_WAIT_MS. */
  private async waitForWorkerEnded(sessionId: string, sinceMs: number): Promise<boolean> {
    const deadline = Date.now() + END_SIGNAL_WAIT_MS;
    while (Date.now() < deadline) {
      const row = await prisma.interviewSession.findUnique({
        where: { id: sessionId },
        select: { status: true, liveMetrics: true },
      }).catch(() => null);
      if (!row) return false;
      if (row.status !== 'finalizing') return true;
      const endedAt = asLiveMetrics(row.liveMetrics).workerEndedAt;
      if (typeof endedAt === 'number' && endedAt >= sinceMs - 5_000) return true;
      await sleep(END_SIGNAL_POLL_MS);
    }
    return false;
  }

  /**
   * Permanently delete a session the owner started — the DB row plus its R2
   * artifacts (recording + transcript + report). If the session is still active
   * we tear down the LiveKit room / egress first so we don't strand a running
   * worker. Live resource teardown and R2 cleanup are best-effort: a failure
   * there must not block removing the row (otherwise the user can never clear a
   * recording whose media write failed). Ownership-scoped — cross-tenant 404s.
   */
  async deleteByOwner(params: { sessionId: string; userId: string; apiKeyId?: string | null }): Promise<void> {
    const session = await this.loadOwned(params.userId, params.sessionId, params.apiKeyId);
    return inBrand((await resolveSessionSeam(session)).brand, () => this.deleteLoaded(session, params));
  }

  private async deleteLoaded(
    session: InterviewSession,
    params: { userId: string; apiKeyId?: string | null },
  ): Promise<void> {
    // Tear down any live LiveKit resources before dropping the row.
    if (session.status === 'created' || session.status === 'live' || session.status === 'finalizing') {
      if (isParleySession(session)) {
        await stopParleySession(session);
      } else {
        const provider = safeProvider(await resolveSessionSeam(session));
        if (provider) {
          if (session.egressId) {
            await provider.stopRecording(session.egressId).catch(() => { /* best-effort */ });
          }
          await provider.deleteRoom(session.roomName).catch(() => { /* best-effort */ });
        }
      }
    }

    // Remove R2 media/transcript/report (best-effort, never throws).
    await interviewR2Storage
      .deleteSessionArtifacts(session.id, [session.recordingKey, session.transcriptKey])
      .catch(() => { /* best-effort */ });

    // deleteMany (not delete) so a concurrent double-delete — two tabs, an
    // overlapping retry — is an idempotent no-op rather than a Prisma P2025
    // throw that would surface as a confusing 500. Stays owner-scoped.
    await prisma.interviewSession.deleteMany({
      where: { id: session.id, userId: params.userId, ...(params.apiKeyId ? { apiKeyId: params.apiKeyId } : {}) },
    });

    logger.info('INTERVIEW_ENGINE_SESSION', 'session deleted', {
      sessionId: session.id,
      userId: params.userId,
      status: session.status,
    });
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  async getReport(params: { sessionId: string; userId: string; apiKeyId?: string | null }): Promise<{
    session: InterviewSession;
    recordingUrl: string | null;
    transcriptUrl: string | null;
  }> {
    const session = await this.loadOwned(params.userId, params.sessionId, params.apiKeyId);
    // Presigned links come from the session's own bucket (CN_S3_* on GoApply).
    return inBrand((await resolveSessionSeam(session)).brand, () => this.reportLoaded(session));
  }

  private async reportLoaded(session: InterviewSession): Promise<{
    session: InterviewSession;
    recordingUrl: string | null;
    transcriptUrl: string | null;
  }> {

    // Self-healing: re-fire the LLM enrichment for reports stuck at the
    // deterministic version (a deploy/restart killed the fire-and-forget
    // _enrichReport). Guarded + attempt-capped inside; never blocks the read.
    void this.maybeReenrichOnRead(session).catch((err) => {
      logger.warn('INTERVIEW_ENGINE_SESSION', 'lazy re-enrich check failed', {
        sessionId: session.id, error: err instanceof Error ? err.message : String(err),
      });
    });

    let recordingUrl: string | null = null;
    let transcriptUrl: string | null = null;
    if (session.recordingKey) {
      // recordingKey means egress STARTED; the object only exists once egress
      // finishes writing. Presign only what actually exists — never a dead
      // link. While the recording may still land (session ended recently) keep
      // advertising it so the report page's poll loop waits; once the landing
      // grace has passed with no object, stop advertising (in-memory only:
      // headObject also nulls on transient R2 errors, so never persist this).
      const head = await interviewR2Storage.headObject(session.recordingKey);
      if (head) {
        const ext = session.recordingMimeType === 'audio/mp4' ? 'm4a' : 'mp4';
        recordingUrl = await interviewR2Storage.presignGet({
          key: session.recordingKey,
          fileName: `interview-${session.id}.${ext}`,
          contentType: session.recordingMimeType ?? 'video/mp4',
        });
      } else {
        const terminal = session.status === 'completed' || session.status === 'failed' || session.status === 'expired';
        const endedMs = (session.endedAt ?? session.updatedAt)?.getTime() ?? Date.now();
        if (terminal && Date.now() - endedMs > RECORDING_LANDING_GRACE_MS) {
          session.recordingKey = null; // serializer → recordingAvailable: false
        }
      }
    }
    if (session.transcriptKey) {
      transcriptUrl = await interviewR2Storage.presignGet({
        key: session.transcriptKey,
        fileName: `transcript-${session.id}.json`,
        contentType: 'application/json',
        asAttachment: true,
      });
    }
    return { session, recordingUrl, transcriptUrl };
  }

  async listRecent(userId: string, limit = 20): Promise<InterviewSession[]> {
    return prisma.interviewSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 50),
    });
  }

  async getOwned(userId: string, sessionId: string, apiKeyId?: string | null): Promise<InterviewSession> {
    return this.loadOwned(userId, sessionId, apiKeyId);
  }

  // ─── Practice from a job (WP-43) ─────────────────────────────────────────

  /**
   * A finished candidate practice: tick the getting-started checklist step
   * `practice` (growth.markChecklistStep, idempotent there) and stamp the
   * session as completed for its job, which is what the job's "Practiced"
   * step reads (practicedJobs). Never throws.
   *
   * Order: `completedAt` is stamped first (atomic jsonb merge, so concurrent
   * telemetry writers to liveMetrics never lose their update), then growth is
   * told, and only after growth succeeded is `checklistMarkedAt` claimed with
   * a conditional merge. A transient growth failure leaves no claim, so a
   * later run (another lifecycle event, the reconcile cron) retries it.
   */
  async markPracticeCompleted(session: Pick<InterviewSession, 'id' | 'userId' | 'status' | 'source'>): Promise<boolean> {
    if (session.status !== 'completed' || session.source !== 'roboapply') return false;
    try {
      const fresh = await prisma.interviewSession.findUnique({
        where: { id: session.id },
        select: { liveMetrics: true, endedAt: true, jobId: true, practiceCompletedAt: true },
      });
      if (!fresh) return false;
      const meta = readPracticeMeta(fresh.liveMetrics);
      if (meta?.checklistMarkedAt) return false;
      const completedAt = fresh.practiceCompletedAt?.toISOString() ?? meta?.completedAt ?? null;
      return await completePractice({
        target: 'live',
        sessionId: session.id,
        userId: session.userId,
        jobId: fresh.jobId ?? meta?.jobId ?? null,
        completedAt: completedAt ? null : (fresh.endedAt ?? new Date()).toISOString(),
      });
    } catch (err) {
      logger.warn('INTERVIEW_ENGINE_SESSION', 'practice completion hook failed', {
        sessionId: session.id, error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** What the report needs beyond the session detail: the job it was for and the recording consent. */
  async getPracticeInfo(params: { sessionId: string; userId: string }): Promise<PracticeSessionInfo> {
    const session = await this.loadOwned(params.userId, params.sessionId);
    const meta = readPracticeMeta(session.liveMetrics);
    // SCHEMA-3 columns first, liveMetrics.practice for older rows.
    const jobId = session.jobId ?? meta?.jobId ?? null;
    const recording = readPracticeRecording(session);
    const completedAt = session.practiceCompletedAt?.toISOString() ?? meta?.completedAt ?? null;
    return {
      sessionId: session.id,
      status: session.status,
      job: jobId
        ? {
            id: jobId,
            title: meta?.jobId === jobId ? meta.jobTitle : null,
            companyName: meta?.jobId === jobId ? meta.companyName : null,
          }
        : null,
      recording: {
        consented: recording.audio === true,
        video: recording.video === true,
        available: !!session.recordingKey,
      },
      completedAt: session.status === 'completed' ? (completedAt ?? session.endedAt?.toISOString() ?? null) : null,
    };
  }

  /**
   * The job's "Practiced" step: for each of `jobIds`, the end time of the
   * user's latest completed practice for that job (absent = not practised).
   * Counts live (voice/video) sessions and written practices (GoApply without
   * voice). Seam for the job checklist (WP-34) and the tracker (WP-38).
   */
  async practicedJobs(userId: string, jobIds: string[]): Promise<Record<string, string>> {
    const ids = [...new Set(jobIds.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean))].slice(0, 100);
    if (ids.length === 0) return {};
    const [rows, written] = await Promise.all([
      prisma.interviewSession.findMany({
        where: {
          userId,
          source: 'roboapply',
          status: 'completed',
          OR: [
            { jobId: { in: ids } },
            ...ids.map((id) => ({ liveMetrics: { path: ['practice', 'jobId'], equals: id } })),
          ],
        },
        select: { liveMetrics: true, endedAt: true, createdAt: true, jobId: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      practiceDeps.findTextPracticesForJobs(userId, ids).catch(() => [] as TextPracticeRow[]),
    ]);
    const out: Record<string, string> = {};
    const keepLatest = (jobId: string | null, at: string | null | undefined) => {
      if (!jobId || !at || !ids.includes(jobId)) return;
      if (!out[jobId] || out[jobId] < at) out[jobId] = at;
    };
    for (const row of rows) {
      const meta = readPracticeMeta(row.liveMetrics);
      keepLatest(row.jobId ?? meta?.jobId ?? null, (row.endedAt ?? row.createdAt).toISOString());
    }
    for (const row of written) {
      // A written practice counts once it was answered and scored (completedAt stamp).
      const meta = textPracticeMetaOf(row);
      keepLatest(meta?.jobId ?? null, meta?.completedAt ?? null);
    }
    return out;
  }

  // ─── Written practice (WP-43; GoApply without `ai.interviewVoice`) ────────
  //
  // First-party wrappers over the existing text interview (RAMockService).
  // The route checks the brand gate (phone, aiAllowed) before any of these
  // run. What they add over the bare text interview: the job loaded
  // server-side (market check) seeds the role; the session is metered like a
  // live practice (gate at start, pro-rated debit when scored; the first free
  // practice is topped up by the route before the gate); and an answered,
  // scored practice ticks the checklist and the job's "Practiced" step once.

  async startTextPractice(input: TextPracticeStartInput): Promise<TextPracticeStartResult> {
    const durationMinutes = clampTextMinutes(input.durationMinutes);
    if (!input.creditExempt) {
      const afford = await practiceDeps.gatePractice(input.userId, durationMinutes);
      if (!afford.ok) {
        logger.info('INTERVIEW_ENGINE_SESSION', 'written practice blocked — insufficient credits', {
          userId: input.userId, plannedDurationMinutes: durationMinutes, balance: afford.balance, required: afford.required,
        });
        throw new InterviewInsufficientCreditsError(afford);
      }
    }
    const job = input.job;
    // The job's title (and company) is the role the interviewer plans for; its
    // posting is the evidence the questions are written from (WP-66).
    const role = job
      ? `${job.title}${job.companyName ? ` (${job.companyName})` : ''}`.slice(0, 200)
      : (input.role ?? '').trim().slice(0, 200);
    const started = await practiceDeps.textStart(
      input.userId,
      {
        role,
        interviewerId: input.interviewerId,
        typeId: input.typeId,
        format: 'voice',
        language: input.language,
        durationMinutes,
        jdText: job?.jdText || undefined,
        market: practiceDeps.currentMarket(),
        // SCHEMA-3 column (RAMockSession.jobId), written with the row.
        jobId: job?.id ?? null,
      },
      input.locale,
    );
    const meta: TextPracticeMeta = {
      v: 1,
      kind: 'text',
      jobId: job?.id ?? null,
      jobTitle: job?.title ?? null,
      companyName: job?.companyName ?? null,
      creditExempt: input.creditExempt === true,
    };
    // Tag the row as a first-party practice (the metering rule, the job's
    // display names). The job id is also on the row's own column; the JSON
    // copy stays during the transition (an older deploy reads only it). A
    // lost tag only loses the "Practiced" step, so it is best-effort.
    await practiceDeps.mergePracticeMeta('text', started.sessionId, meta as unknown as Record<string, unknown>).catch((err) => {
      logger.warn('INTERVIEW_ENGINE_SESSION', 'written practice tag failed', {
        sessionId: started.sessionId, error: err instanceof Error ? err.message : String(err),
      });
      return false;
    });
    return { ...started, jobId: meta.jobId };
  }

  async textPracticeTurn(input: { userId: string; sessionId: string; answer: string; questionIndex: number; locale?: string }) {
    const row = await practiceDeps.findTextPractice(input.userId, input.sessionId);
    if (!row || !textPracticeMetaOf(row)) throw new InterviewNotFoundError();
    return practiceDeps.textTurn(
      input.userId,
      { sessionId: input.sessionId, answer: input.answer, questionIndex: input.questionIndex },
      input.locale,
    );
  }

  /**
   * Score a written practice. When at least one question was answered it
   * counts as a practice: debit the pro-rated credits (idempotent per
   * session, capped at what the start gate authorised), stamp it completed
   * for its job and tick the checklist step once.
   */
  async scoreTextPractice(input: { userId: string; sessionId: string }): Promise<TextPracticeScoreResult> {
    const row = await practiceDeps.findTextPractice(input.userId, input.sessionId);
    const meta = row ? textPracticeMetaOf(row) : null;
    if (!row || !meta) throw new InterviewNotFoundError();
    const score = await practiceDeps.textScore(input.userId, input.sessionId, practiceDeps.currentMarket());
    const answered = countTextAnswers(row.transcript) > 0;
    if (answered) {
      if (!meta.creditExempt) {
        await practiceDeps
          .debitPractice({
            userId: input.userId,
            sessionId: input.sessionId,
            durationSec: Math.max(1, Math.round(score.durationMinutes)) * 60,
            plannedDurationMinutes: row.plannedDurationMinutes,
          })
          .catch((err) => {
            logger.warn('INTERVIEW_ENGINE_SESSION', 'written practice debit failed', {
              sessionId: input.sessionId, error: err instanceof Error ? err.message : String(err),
            });
          });
      }
      if (!meta.checklistMarkedAt) {
        await completePractice({
          target: 'text',
          sessionId: input.sessionId,
          userId: input.userId,
          jobId: meta.jobId,
          completedAt: meta.completedAt ? null : new Date().toISOString(),
        });
      }
      // GoApply: the results are ready (soft; once per practice, also on a repeated score call).
      void notifyPracticeReportReady({
        target: 'text',
        sessionId: input.sessionId,
        userId: input.userId,
        cn: practiceDeps.currentMarket() === 'cn',
        title: meta.jobTitle ?? row.role ?? '',
        completedAt: new Date(),
      });
    }
    return { ...score, practiceCounted: answered, jobId: meta.jobId };
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /**
   * Load a session scoped to the owner. Internal callers scope by userId only.
   * External (API-key) callers ALSO match apiKeyId, so two external customers
   * who happen to share a user row can never cross-read each other's sessions.
   */
  private async loadOwned(userId: string, sessionId: string, apiKeyId?: string | null): Promise<InterviewSession> {
    const id = (sessionId ?? '').trim();
    if (!id) throw new InterviewValidationError('sessionId is required');
    const session = await prisma.interviewSession.findFirst({
      where: { id, userId, ...(apiKeyId ? { apiKeyId } : {}) },
    });
    if (!session) throw new InterviewNotFoundError();
    return session;
  }

  /**
   * Each brand's worker carries its own secret (LIVEKIT_AGENT_CALLBACK_SECRET /
   * CN_LIVEKIT_AGENT_CALLBACK_SECRET), and a callback may only touch a session
   * of its own brand: the mainland worker's secret can never append to, end or
   * meter a RoboApply session, nor the reverse. A secret no brand configured is
   * refused before any database read; otherwise the session's brand (its
   * stored seam: column, else liveMetrics, else the owner's brand) picks the
   * one secret that is accepted. Constant-time compares.
   * An unknown session id passes here (there is nothing of another brand to
   * touch) and each callback handles not-found as before.
   */
  private async assertCallbackSecret(sessionId: string, secret: string | undefined): Promise<void> {
    const configured = getAgentCallbackSecrets();
    if (configured.length === 0) throw new InterviewAuthError('Callback secret not configured');
    if (!secret || !configured.some((e) => secretEquals(secret, e))) throw new InterviewAuthError('Invalid callback secret');
    const id = (sessionId ?? '').trim();
    if (!id) return;
    const row = await prisma.interviewSession.findUnique({ where: { id }, select: { liveMetrics: true, userId: true, brand: true, voiceProvider: true } });
    if (!row) return;
    const expected = getAgentCallbackSecret((await resolveSessionSeam(row)).brand);
    if (!expected || !secretEquals(secret, expected)) throw new InterviewAuthError('Invalid callback secret');
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function secretEquals(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The provider of a stored seam, or null when it can no longer be built
 *  (a reserved provider id). Teardown is best-effort, so it never throws. */
function safeProvider(seam: VoiceSeam): VoiceSessionProvider | null {
  try {
    return voiceProviderFor(seam);
  } catch (err) {
    logger.warn('INTERVIEW_ENGINE_SESSION', 'voice provider unavailable for teardown', {
      brand: seam.brand, provider: seam.provider, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** A webhook signed by one brand's LiveKit project acts only on that brand's
 *  sessions. No signer given (a caller that does not pass it) = accepted. */
function webhookSignerMatches(signer: BrandId | undefined, seam: VoiceSeam, sessionId: string, event: string): boolean {
  if (!signer || signer === seam.brand) return true;
  logger.warn('INTERVIEW_ENGINE_WEBHOOK', 'ignored a webhook signed by another brand project', {
    sessionId, event, signer, sessionBrand: seam.brand,
  });
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bound a worker-supplied telemetry value before storing it. */
function compactTelemetryValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 200);
  try {
    const json = JSON.stringify(value);
    return json && json.length <= 1000 ? JSON.parse(json) : String(json).slice(0, 1000);
  } catch {
    return null;
  }
}

/** Race a promise against a timeout; resolve to `fallback` if it's too slow. */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clampDuration(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.round(value);
  return Math.max(5, Math.min(120, n));
}

function asTranscript(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) return [];
  const out: TranscriptTurn[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text : '';
    if (!text) continue;
    const role = r.role === 'candidate' || r.role === 'system' ? r.role : 'interviewer';
    out.push({ role, text, ts: typeof r.ts === 'number' ? r.ts : Date.now(), interim: r.interim === true ? true : undefined });
  }
  return out;
}

function sanitizeTurns(turns: unknown): TranscriptTurn[] {
  if (!Array.isArray(turns)) return [];
  const out: TranscriptTurn[] = [];
  for (const t of turns) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text.slice(0, 8000) : '';
    if (!text.trim()) continue;
    const role = r.role === 'candidate' || r.role === 'system' ? r.role : 'interviewer';
    out.push({ role, text, ts: typeof r.ts === 'number' ? r.ts : Date.now() });
    if (out.length >= 100) break; // per-call cap
  }
  return out;
}

function renderTranscriptText(turns: TranscriptTurn[], candidateName: string): string {
  return turns
    .filter((t) => !t.interim)
    .map((t) => `${t.role === 'candidate' ? candidateName : t.role === 'system' ? 'System' : 'Interviewer'}: ${t.text}`)
    .join('\n\n');
}

// ─── Practice from a job: jobs, resumes, consent, first free practice (WP-43) ──
//
// Narrow typed adapters over the rows WP-43 reads. The practice facts live in
// `liveMetrics.practice` (PracticeMeta) until the schema carries first-class
// columns (Schema request WP-43-S1: InterviewSession.jobId / recordingConsent).

export type PracticeMarket = 'intl' | 'cn';

export interface PracticeRecordingChoice {
  audio: boolean;
  video: boolean;
}

export const NO_RECORDING: PracticeRecordingChoice = Object.freeze({ audio: false, video: false }) as PracticeRecordingChoice;

/** `liveMetrics.practice` — written at create, stamped at completion. */
export interface PracticeMeta {
  v: 1;
  jobId: string | null;
  jobTitle: string | null;
  companyName: string | null;
  /** The recording the user consented to for this session (H8). */
  recording: PracticeRecordingChoice;
  completedAt?: string;
  checklistMarkedAt?: string;
}

export interface PracticeSessionInfo {
  sessionId: string;
  status: string;
  job: { id: string; title: string | null; companyName: string | null } | null;
  /** consented=false renders "Recording off" on the report. */
  recording: { consented: boolean; video: boolean; available: boolean };
  completedAt: string | null;
}

/** Read `liveMetrics.practice`; null when the session has none (= no job, no recording). */
export function readPracticeMeta(liveMetrics: unknown): PracticeMeta | null {
  const raw = asLiveMetrics(liveMetrics).practice;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const rec = p.recording && typeof p.recording === 'object' ? (p.recording as Record<string, unknown>) : {};
  const audio = rec.audio === true;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    v: 1,
    jobId: str(p.jobId),
    jobTitle: str(p.jobTitle),
    companyName: str(p.companyName),
    recording: { audio, video: audio && rec.video === true },
    ...(str(p.completedAt) ? { completedAt: str(p.completedAt)! } : {}),
    ...(str(p.checklistMarkedAt) ? { checklistMarkedAt: str(p.checklistMarkedAt)! } : {}),
  };
}

/** Parse the `InterviewSession.recordingConsent` column ({ audio, video }); null when absent or malformed. */
export function parseRecordingConsent(value: unknown): PracticeRecordingChoice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.audio !== 'boolean') return null;
  return { audio: v.audio, video: v.audio && v.video === true };
}

/**
 * The recording the user consented to for a live session: the
 * `recordingConsent` column (SCHEMA-3) first, else `liveMetrics.practice`
 * (rows written before the column existed). No choice = nothing recorded.
 */
export function readPracticeRecording(row: { liveMetrics: unknown; recordingConsent?: unknown }): PracticeRecordingChoice {
  return parseRecordingConsent(row.recordingConsent) ?? readPracticeMeta(row.liveMetrics)?.recording ?? NO_RECORDING;
}

/** A job id that is unknown, from the other market, or someone else's private import. */
export class PracticeJobNotFoundError extends InterviewNotFoundError {
  readonly code = 'job_not_found' as const;
  constructor() {
    super();
    this.name = 'PracticeJobNotFoundError';
  }
}

export interface PracticeJob {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  /** The posting as plain text (≤ 8000 chars), used as the interview brief. */
  jdText: string;
  /** Closed or archived postings still work for practice; the UI says so. */
  closed: boolean;
}

export interface PracticeJobRow {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  description: string;
  descriptionPlain: string;
  market: string;
  visibility: string;
  ownerUserId: string | null;
  archivedAt: Date | null;
  closedAt: Date | null;
}

export type PracticeResumeKind = 'chosen' | 'tailored' | 'primary' | 'latest';

export interface PracticeResumeRow {
  id: string;
  name: string;
  resumeMarkdown: string;
  kind: PracticeResumeKind;
}

export interface PracticeUserRow {
  brand: string;
  name: string | null;
  emailVerified: boolean;
  emailVerifiedAt: Date | null;
  emailIsPlaceholder: boolean;
  phoneE164: string | null;
  phoneVerifiedAt: Date | null;
}

export type PracticeConsentType = 'interview_recording' | 'interview_video';
export type FirstPracticeGrantReason = 'email_verified' | 'phone_verified';
export type FirstPracticeGrantStatus = 'granted' | 'already_granted' | 'in_progress' | 'no_profile' | 'failed';

export interface PracticeDeps {
  findJob(jobId: string): Promise<PracticeJobRow | null>;
  findResume(userId: string, opts: { resumeId?: string | null; jobId?: string | null }): Promise<PracticeResumeRow | null>;
  findUser(userId: string): Promise<PracticeUserRow | null>;
  hasConsent(userId: string, type: PracticeConsentType): Promise<boolean>;
  markChecklistStep(userId: string, step: 'practice'): Promise<unknown>;
  grantPracticeCredit(userId: string, reason: FirstPracticeGrantReason, key: string): Promise<{ status: FirstPracticeGrantStatus }>;
  currentMarket(): PracticeMarket;
  /**
   * Atomic jsonb merge of `patch` into the practice object of a live session
   * (`InterviewSession.liveMetrics.practice`) or a written one
   * (`RAMockSession.blueprint.practice`). With `unlessSet`, the merge is a
   * claim: it applies only while that key is still absent. True = applied.
   */
  mergePracticeMeta(
    target: PracticeTarget,
    sessionId: string,
    patch: Record<string, unknown>,
    unlessSet?: PracticeClaimKey,
  ): Promise<boolean>;
  /**
   * GoApply: mirror "your practice report is ready" to WeChat
   * (features/notify-cn `sendNotice`, template `report_ready`). Resolves with
   * the delivery outcome; expected skips (not linked, no accepted prompt,
   * channel off, template unset) are not errors.
   */
  sendReportNotice(input: PracticeReportNotice): Promise<unknown>;
  /** Set `practiceCompletedAt` once (SCHEMA-3 column; never overwritten). */
  stampPracticeCompleted(target: PracticeTarget, sessionId: string, at: Date): Promise<unknown>;
  /** Practice credits: can the user afford a practice of this length? */
  gatePractice(userId: string, plannedMinutes: number): Promise<{ ok: boolean; balance: number; required: number; tier: string }>;
  /** Pro-rated practice debit, idempotent per session id. */
  debitPractice(input: { userId: string; sessionId: string; durationSec: number; plannedDurationMinutes: number | null }): Promise<unknown>;
  textStart(
    userId: string,
    input: TextStartCall,
    locale?: string,
  ): Promise<{ sessionId: string; questions: TextPracticeQuestion[]; cnFormat?: TextPracticeCnFormat | null }>;
  textTurn(
    userId: string,
    input: { sessionId: string; answer: string; questionIndex: number },
    locale?: string,
  ): Promise<{ nextIndex: number | null; turns: Array<{ who: 'them' | 'you'; text: string }>; coachTip: unknown }>;
  textScore(userId: string, sessionId: string, market?: PracticeMarket): Promise<TextPracticeScore>;
  findTextPractice(userId: string, sessionId: string): Promise<TextPracticeRow | null>;
  findTextPracticesForJobs(userId: string, jobIds: string[]): Promise<TextPracticeRow[]>;
}

export type PracticeTarget = 'live' | 'text';

/** Keys of the practice object that are claimed once (the merge applies only while the key is absent). */
export type PracticeClaimKey = 'checklistMarkedAt' | 'reportNoticeAt';

/** What the WeChat "report ready" notice carries (the person's own practice; no numbers). */
export interface PracticeReportNotice {
  userId: string;
  template: 'report_ready';
  params: { title: string; completedAt: string };
  /** The report this notice is about (the session id): a prompt accepted for it is spent first. */
  eventId: string;
  /** Same-site path the message opens. */
  href: string;
}

export interface TextStartCall {
  role: string;
  interviewerId: string;
  typeId: string;
  format: 'voice';
  language?: string;
  durationMinutes: number;
  /** The job post the practice is for: evidence for the question plan (WP-66). */
  jdText?: string;
  /** The requesting brand's market (GoApply runs its AI-interview format). */
  market?: PracticeMarket;
  /** Written to `RAMockSession.jobId` with the row. */
  jobId?: string | null;
}

/** Per-question timing of the GoApply AI-interview format (from `blueprint.cnFormat`). */
export interface TextPracticeCnFormat {
  formatId: string;
  minutes: number;
  questions: Array<{ prepSeconds: number; answerSeconds: number; story: boolean }>;
}

export interface TextPracticeQuestion {
  q: string;
  hint: string;
  coachTip: { kind: 'good' | 'careful'; text: string } | null;
}

export interface TextPracticeScore {
  overall: number;
  delta: number | null;
  breakdown: Array<{ key: string; value: number; note: string }>;
  strengths: string[];
  gaps: string[];
  durationMinutes: number;
  /** GoApply only: the practice report block (communication / logic / story answers, STAR, filler words). */
  cn?: CnPracticeReport;
}

/** The RAMockSession columns the written practice reads. */
export interface TextPracticeRow {
  id: string;
  /** The role the practice was planned for (the notice title); absent from an older select. */
  role?: string | null;
  blueprint: unknown;
  transcript: unknown;
  plannedDurationMinutes: number | null;
  status: string;
  /** SCHEMA-3 columns; absent from a row read by an older select. */
  jobId?: string | null;
  practiceCompletedAt?: Date | null;
}

/**
 * The first-party view of a written practice.
 *
 * `jobId` and `completedAt` live on `RAMockSession.jobId` /
 * `practiceCompletedAt` (SCHEMA-3) and are read from there first
 * (`textPracticeMetaOf`). `RAMockSession.blueprint.practice` still carries the
 * tag that makes a text interview a first-party practice (`kind: 'text'`), the
 * metering rule, the checklist claim and the job's display names, which have
 * no column, plus a copy of `jobId` / `completedAt` for rows written before
 * the columns and for a rollback (no backfill DML).
 */
export interface TextPracticeMeta {
  v: 1;
  kind: 'text';
  jobId: string | null;
  jobTitle: string | null;
  companyName: string | null;
  /** Admin runs are not metered (mirrors the live create). */
  creditExempt: boolean;
  completedAt?: string;
  checklistMarkedAt?: string;
}

export interface TextPracticeStartInput {
  userId: string;
  role?: string;
  interviewerId: string;
  typeId: string;
  language?: string;
  durationMinutes?: number;
  /** Loaded server-side and market-checked by the caller (loadPracticeJob). */
  job: PracticeJob | null;
  creditExempt?: boolean;
  locale?: string;
}

export interface TextPracticeStartResult {
  sessionId: string;
  questions: TextPracticeQuestion[];
  jobId: string | null;
  /** GoApply AI-interview format: thinking and answer time per question; absent otherwise. */
  cnFormat?: TextPracticeCnFormat | null;
}

export interface TextPracticeScoreResult extends TextPracticeScore {
  /** True when the practice was answered: it counts for the checklist and the job. */
  practiceCounted: boolean;
  jobId: string | null;
}

/**
 * A written practice's meta, columns first: `RAMockSession.jobId` and
 * `practiceCompletedAt` win over the JSON copies, which serve rows written
 * before the columns. null for a text interview that is not a first-party
 * practice (no `blueprint.practice` tag).
 */
export function textPracticeMetaOf(row: Pick<TextPracticeRow, 'blueprint' | 'jobId' | 'practiceCompletedAt'>): TextPracticeMeta | null {
  const meta = readTextPracticeMeta(row.blueprint);
  if (!meta) return null;
  const jobId = typeof row.jobId === 'string' && row.jobId ? row.jobId : meta.jobId;
  const completedAt = row.practiceCompletedAt instanceof Date ? row.practiceCompletedAt.toISOString() : meta.completedAt;
  return {
    ...meta,
    jobId,
    // The display names belong to the job the JSON tag was written for.
    ...(jobId === meta.jobId ? {} : { jobTitle: null, companyName: null }),
    ...(completedAt ? { completedAt } : {}),
  };
}

/**
 * Read `RAMockSession.blueprint.practice` alone; null for a text interview
 * that is not a first-party practice. Callers holding the row use
 * `textPracticeMetaOf`, which reads the columns first.
 */
export function readTextPracticeMeta(blueprint: unknown): TextPracticeMeta | null {
  if (!blueprint || typeof blueprint !== 'object' || Array.isArray(blueprint)) return null;
  const raw = (blueprint as Record<string, unknown>).practice;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.kind !== 'text') return null;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    v: 1,
    kind: 'text',
    jobId: str(p.jobId),
    jobTitle: str(p.jobTitle),
    companyName: str(p.companyName),
    creditExempt: p.creditExempt === true,
    ...(str(p.completedAt) ? { completedAt: str(p.completedAt)! } : {}),
    ...(str(p.checklistMarkedAt) ? { checklistMarkedAt: str(p.checklistMarkedAt)! } : {}),
  };
}

const TEXT_MINUTES_DEFAULT = 20;

function clampTextMinutes(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : TEXT_MINUTES_DEFAULT;
  return Math.min(120, Math.max(5, n));
}

/** Non-empty candidate answers in a written transcript (a skipped question is an empty answer). */
function countTextAnswers(transcript: unknown): number {
  if (!Array.isArray(transcript)) return 0;
  return transcript.filter(
    (turn) => !!turn && typeof turn === 'object' && (turn as { who?: unknown }).who === 'you'
      && typeof (turn as { text?: unknown }).text === 'string' && ((turn as { text: string }).text).trim().length > 0,
  ).length;
}

/**
 * Shared completion for live and written practice: stamp `completedAt` (when
 * given), tell growth, then claim `checklistMarkedAt`. Growth is idempotent,
 * so a rare concurrent double call is harmless; the claim keeps later runs
 * from calling it again. A growth failure leaves no claim (a retry may tick
 * it). Returns true when this call made the claim.
 */
async function completePractice(input: {
  target: PracticeTarget;
  sessionId: string;
  userId: string;
  jobId: string | null;
  completedAt: string | null;
}): Promise<boolean> {
  try {
    if (input.completedAt) {
      await practiceDeps.mergePracticeMeta(input.target, input.sessionId, { completedAt: input.completedAt });
      // The SCHEMA-3 column, set once (best-effort: liveMetrics stays the fallback).
      await practiceDeps.stampPracticeCompleted(input.target, input.sessionId, new Date(input.completedAt)).catch((err: unknown) => {
        logger.warn('INTERVIEW_ENGINE_SESSION', 'practiceCompletedAt stamp failed', {
          sessionId: input.sessionId, target: input.target, error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    await practiceDeps.markChecklistStep(input.userId, 'practice');
    const claimed = await practiceDeps.mergePracticeMeta(
      input.target,
      input.sessionId,
      { checklistMarkedAt: new Date().toISOString() },
      'checklistMarkedAt',
    );
    if (claimed) {
      logger.info('INTERVIEW_ENGINE_SESSION', 'practice completed: checklist step marked', {
        sessionId: input.sessionId, userId: input.userId, target: input.target, jobId: input.jobId ?? undefined,
      });
    }
    return claimed;
  } catch (err) {
    logger.warn('INTERVIEW_ENGINE_SESSION', 'practice completion hook failed', {
      sessionId: input.sessionId, target: input.target, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Longest title a WeChat template field takes (`thing` keywords: 20 characters). */
const REPORT_NOTICE_TITLE_MAX = 20;

/**
 * GoApply only: when a practice report is finished, mirror "your report is
 * ready" to WeChat (features/notify-cn, template `report_ready`). Soft and
 * once per report:
 *   - `reportNoticeAt` is claimed first with a conditional merge on the
 *     practice object, so a repeated score call, a second finalize trigger or
 *     another instance never sends a second notice for the same report;
 *   - nothing here throws, and a skipped or failed send is not retried (the
 *     report itself is on the page; WeChat only mirrors it).
 * RoboApply (`cn` false) sends nothing and claims nothing.
 */
async function notifyPracticeReportReady(input: {
  target: PracticeTarget;
  sessionId: string;
  userId: string;
  /** Is this a GoApply practice? (A thunk when it has to be looked up; a failed lookup sends nothing.) */
  cn: boolean | (() => Promise<boolean>);
  title: string;
  completedAt: Date;
}): Promise<boolean> {
  try {
    if (!(typeof input.cn === 'function' ? await input.cn() : input.cn)) return false;
    const completedAt = input.completedAt.toISOString();
    const claimed = await practiceDeps.mergePracticeMeta(input.target, input.sessionId, { reportNoticeAt: completedAt }, 'reportNoticeAt');
    if (!claimed) return false;
    // Whole characters (a title may hold characters outside the BMP).
    const title = [...(input.title ?? '').trim()].slice(0, REPORT_NOTICE_TITLE_MAX).join('');
    // The notice needs a title: an untitled practice is not announced.
    if (!title) return false;
    await practiceDeps.sendReportNotice({
      userId: input.userId,
      template: 'report_ready',
      params: { title, completedAt },
      eventId: input.sessionId,
      href: input.target === 'live' ? `/practice/${input.sessionId}/report` : '/practice',
    });
    return true;
  } catch (err) {
    logger.warn('INTERVIEW_ENGINE_SESSION', 'practice report notice failed', {
      sessionId: input.sessionId, target: input.target, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

const PRACTICE_TABLES: Record<PracticeTarget, { table: string; column: string }> = {
  live: { table: '"InterviewSession"', column: '"liveMetrics"' },
  text: { table: '"RAMockSession"', column: '"blueprint"' },
};

const TEXT_PRACTICE_SELECT = {
  id: true, role: true, blueprint: true, transcript: true, plannedDurationMinutes: true, status: true, jobId: true, practiceCompletedAt: true,
} as const;

/** Map the text interview's errors onto the engine's (404 / 422 via handleEngineError). */
async function mapTextErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'MockSessionNotFoundError') throw new InterviewNotFoundError();
    if (name === 'MockValidationError') throw new InterviewValidationError((err as Error).message);
    throw err;
  }
}

const RESUME_SELECT = { id: true, name: true, resumeMarkdown: true } as const;

const defaultPracticeDeps: PracticeDeps = {
  async findJob(jobId) {
    return prisma.rAJob.findUnique({
      where: { id: jobId },
      select: {
        id: true, title: true, companyName: true, location: true, description: true, descriptionPlain: true,
        market: true, visibility: true, ownerUserId: true, archivedAt: true, closedAt: true,
      },
    });
  },
  async findResume(userId, { resumeId, jobId }) {
    const base = { userId, deletedAt: null };
    if (resumeId) {
      const chosen = await prisma.rAResumeVariant.findFirst({ where: { ...base, id: resumeId }, select: RESUME_SELECT });
      if (chosen) return { ...chosen, kind: 'chosen' };
    }
    if (jobId) {
      const tailored = await prisma.rAResumeVariant.findFirst({
        where: { ...base, targetJobId: jobId },
        orderBy: { lastEditedAt: 'desc' },
        select: RESUME_SELECT,
      });
      if (tailored) return { ...tailored, kind: 'tailored' };
    }
    const primary = await prisma.rAResumeVariant.findFirst({ where: { ...base, isPrimary: true }, select: RESUME_SELECT });
    if (primary) return { ...primary, kind: 'primary' };
    const latest = await prisma.rAResumeVariant.findFirst({
      where: base,
      orderBy: { lastEditedAt: 'desc' },
      select: RESUME_SELECT,
    });
    return latest ? { ...latest, kind: 'latest' } : null;
  },
  async findUser(userId) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: {
        brand: true, name: true, emailVerified: true, emailVerifiedAt: true, emailIsPlaceholder: true,
        phoneE164: true, phoneVerifiedAt: true,
      },
    });
  },
  async hasConsent(userId, type) {
    const { hasLiveConsent } = await import('../../platform/consent/index.js');
    return hasLiveConsent(userId, type);
  },
  async markChecklistStep(userId, step) {
    const growth = await import('../../features/growth/index.js');
    return growth.markChecklistStep(userId, step);
  },
  async grantPracticeCredit(userId, reason, key) {
    const credits = await import('../../platform/credits/index.js');
    return credits.grantPracticeCredit(userId, reason, key);
  },
  currentMarket() {
    return getCurrentBrandOrDefault().market === 'cn' ? 'cn' : 'intl';
  },
  async mergePracticeMeta(target, sessionId, patch, unlessSet) {
    const { table, column } = PRACTICE_TABLES[target];
    // One statement: concurrent writers to the same column (worker metrics,
    // client events, lifecycle) keep their keys; the WHERE is the claim.
    // A missing column, or a JSON null / non-object, starts from {}.
    const base = `(CASE WHEN jsonb_typeof(${column}) = 'object' THEN ${column} ELSE '{}'::jsonb END)`;
    const practice = `(CASE WHEN jsonb_typeof(${column} -> 'practice') = 'object' THEN ${column} -> 'practice' ELSE '{}'::jsonb END)`;
    const claim = unlessSet ? ` AND (${column} -> 'practice' ->> '${unlessSet}') IS NULL` : '';
    const count = await prisma.$executeRawUnsafe(
      `UPDATE ${table}
          SET ${column} = jsonb_set(${base}, '{practice}', ${practice} || $2::jsonb, true)
        WHERE id = $1${claim}`,
      sessionId,
      JSON.stringify(patch),
    );
    return count === 1;
  },
  async sendReportNotice(input) {
    const { notifyCnService } = await import('../../features/notify-cn/index.js');
    return notifyCnService().sendNotice(input);
  },
  async stampPracticeCompleted(target, sessionId, at) {
    const where = { id: sessionId, practiceCompletedAt: null };
    const data = { practiceCompletedAt: at };
    return target === 'live'
      ? prisma.interviewSession.updateMany({ where, data })
      : prisma.rAMockSession.updateMany({ where, data });
  },
  async gatePractice(userId, plannedMinutes) {
    return gateMockInterview(userId, plannedMinutes);
  },
  async debitPractice(input) {
    const credits = await import('../../lib/mockCreditService.js');
    return credits.debitForFinishedSession({ ...input, metadata: { practice: 'text' } });
  },
  async textStart(userId, input, locale) {
    const { raMockService } = await import('../../roboapply/v2/services/RAMockService.js');
    return mapTextErrors(() => raMockService.start(userId, input, locale));
  },
  async textTurn(userId, input, locale) {
    const { raMockService } = await import('../../roboapply/v2/services/RAMockService.js');
    return mapTextErrors(() => raMockService.nextTurn(userId, input, locale));
  },
  async textScore(userId, sessionId, market) {
    const { raMockService } = await import('../../roboapply/v2/services/RAMockService.js');
    return mapTextErrors(() => raMockService.score(userId, sessionId, { market }));
  },
  async findTextPractice(userId, sessionId) {
    const id = (sessionId ?? '').trim();
    if (!id) return null;
    return prisma.rAMockSession.findFirst({ where: { id, userId }, select: TEXT_PRACTICE_SELECT });
  },
  async findTextPracticesForJobs(userId, jobIds) {
    return prisma.rAMockSession.findMany({
      where: {
        userId,
        status: 'complete',
        // The column first; the JSON path finds rows written before it.
        OR: [{ jobId: { in: jobIds } }, ...jobIds.map((id) => ({ blueprint: { path: ['practice', 'jobId'], equals: id } }))],
      },
      select: TEXT_PRACTICE_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  },
};

let practiceDeps: PracticeDeps = defaultPracticeDeps;

/** Test seam: override some practice dependencies (null restores the defaults). */
export function setPracticeDeps(overrides: Partial<PracticeDeps> | null): void {
  practiceDeps = overrides ? { ...defaultPracticeDeps, ...overrides } : defaultPracticeDeps;
}

/**
 * The job a practice is for. 404 (PracticeJobNotFoundError) when it does not
 * exist, belongs to the other market (a GoApply session never loads a
 * RoboApply job and vice versa) or is another user's private import.
 */
export async function loadPracticeJob(userId: string, jobId: string, market?: PracticeMarket): Promise<PracticeJob | null> {
  const id = jobId.trim();
  if (!id || id.length > 64) return null;
  const row = await practiceDeps.findJob(id);
  if (!row) return null;
  if (row.market !== (market ?? practiceDeps.currentMarket())) return null;
  if (row.visibility !== 'public' && row.ownerUserId !== userId) return null;
  const text = (row.descriptionPlain || row.description || '').trim();
  return {
    id: row.id,
    title: row.title,
    companyName: row.companyName,
    location: row.location,
    jdText: text.slice(0, 8000),
    closed: !!(row.archivedAt || row.closedAt),
  };
}

async function loadPracticeJobOrThrow(userId: string, jobId: string, market?: PracticeMarket): Promise<PracticeJob> {
  const job = await loadPracticeJob(userId, jobId, market);
  if (!job) throw new PracticeJobNotFoundError();
  return job;
}

/** Résumé context sent to the interview brief: PII stripped, clipped to the blueprint's 2000 chars. */
export const PRACTICE_RESUME_CONTEXT_CHARS = 2000;

export interface PracticeResume {
  id: string;
  name: string;
  kind: PracticeResumeKind;
  /** Redacted and clipped; this exact text goes into the interview brief. */
  context: string;
}

/** The resume to practise with: `resumeId`, else the job's tailored one, else the primary, else the latest. */
export async function loadPracticeResume(
  userId: string,
  opts: { resumeId?: string | null; jobId?: string | null; knownValues?: string[] },
): Promise<PracticeResume | null> {
  const row = await practiceDeps.findResume(userId, { resumeId: opts.resumeId ?? null, jobId: opts.jobId ?? null });
  if (!row) return null;
  const { redactPii, LLM_PII_KINDS } = await import('../../platform/pii/index.js');
  const redacted = redactPii(row.resumeMarkdown ?? '', {
    kinds: LLM_PII_KINDS,
    knownValues: (opts.knownValues ?? []).filter((v) => typeof v === 'string' && v.trim().length >= 2),
  }).text;
  return { id: row.id, name: row.name, kind: row.kind, context: redacted.trim().slice(0, PRACTICE_RESUME_CONTEXT_CHARS) };
}

/**
 * H8: the recording this session may make. Off unless the user asked for it
 * AND their newest `interview_recording` record is a grant; the camera also
 * needs `interview_video` and a video session. External API sessions carry
 * the tenant's own attestation. A failed consent lookup fails closed.
 */
export async function resolvePracticeRecording(input: {
  userId: string;
  source: InterviewSource;
  mode: InterviewMode;
  requested?: { audio?: boolean; video?: boolean } | null;
  /** False where the brand never records video (GoApply, CN L-11). Default true. */
  allowVideo?: boolean;
}): Promise<PracticeRecordingChoice> {
  const wantAudio = input.requested?.audio === true;
  if (!wantAudio) return NO_RECORDING;
  const wantVideo = input.requested?.video === true && input.mode === 'video' && input.allowVideo !== false;
  if (input.source === 'external') return { audio: true, video: wantVideo };
  if (input.source !== 'roboapply') return NO_RECORDING;
  const live = async (type: PracticeConsentType) => {
    try {
      return await practiceDeps.hasConsent(input.userId, type);
    } catch {
      return false;
    }
  };
  if (!(await live('interview_recording'))) return NO_RECORDING;
  return { audio: true, video: wantVideo ? await live('interview_video') : false };
}

export interface FirstPracticeState {
  /** How this brand verifies before the first free practice: email (RoboApply) or phone (GoApply). */
  method: 'email' | 'phone';
  verified: boolean;
  /** The grant result when verified (idempotent; null when not verified or unknown). */
  grant: FirstPracticeGrantStatus | null;
}

/**
 * Ruling C42: the first full practice is free after verification — email on
 * RoboApply (WP-10 grants it when the link is clicked), phone on GoApply. This
 * tops up the same idempotency key, so it never grants twice; it covers a
 * GoApply phone verification (no grant at bind time yet) and a failed grant.
 */
export async function ensureFirstPracticeGrant(userId: string): Promise<FirstPracticeState> {
  let user: PracticeUserRow | null = null;
  try {
    user = await practiceDeps.findUser(userId);
  } catch {
    user = null;
  }
  const method: 'email' | 'phone' = user?.brand === 'goapply' ? 'phone' : 'email';
  if (!user) return { method, verified: false, grant: null };
  const verified =
    method === 'phone'
      ? !!(user.phoneE164 && user.phoneVerifiedAt)
      // emailVerified defaults to true for grandfathered rows; only an explicit
      // verification (emailVerifiedAt) earns the free practice here.
      : !!(user.emailVerified && user.emailVerifiedAt && !user.emailIsPlaceholder);
  if (!verified) return { method, verified, grant: null };
  const reason: FirstPracticeGrantReason = method === 'phone' ? 'phone_verified' : 'email_verified';
  try {
    const res = await practiceDeps.grantPracticeCredit(userId, reason, reason);
    return { method, verified, grant: res.status };
  } catch (err) {
    logger.warn('INTERVIEW_ENGINE_SESSION', 'first practice grant failed', {
      userId, error: err instanceof Error ? err.message : String(err),
    });
    return { method, verified, grant: 'failed' };
  }
}

export const interviewSessionService = new InterviewSessionService();
export default interviewSessionService;
