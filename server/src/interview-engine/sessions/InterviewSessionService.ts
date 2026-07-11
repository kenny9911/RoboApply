// backend/src/interview-engine/sessions/InterviewSessionService.ts
//
// The Interview Engine's lifecycle orchestrator — the single brain wiring the
// prompt pipeline, LiveKit room + agent dispatch + egress, R2 transcript
// persistence, and scoring around the InterviewSession DB row.
//
// Lifecycle:
//   createSession()  → row (status 'created') with generated prompt/voice/qs
//   getConnection()  → create room + dispatch agent + start egress + mint token
//                      (status → 'live')
//   ingestTranscript() (worker callback, secret-gated) → append turns
//   handleEgressEnded() / handleRoomFinished() (LiveKit webhook) → record file +
//                      finalize
//   finalize()       → upload transcript to R2 + score → report (status
//                      → 'completed')
//
// Ownership: every read/mutation is scoped to the owning user (the human user
// OR the API-key owner for external sessions); cross-tenant access 404s.

import { randomUUID } from 'node:crypto';
import type { InterviewSession } from '../../generated/prisma/client.js';
import prisma from '../../lib/prisma.js';
import { logger, generateRequestId } from '../../services/LoggerService.js';
import {
  isLiveKitConfigured,
  getInterviewAgentName,
  getAgentCallbackSecret,
  getCallbackBaseUrl,
  getSessionExpiryMinutes,
  isRecordingEnabled,
  InterviewEngineConfigError,
} from '../config.js';
import {
  createInterviewRoom,
  dispatchAgent,
  mintJoinToken,
  deleteInterviewRoom,
} from '../livekit/liveKitClient.js';
import { startRoomRecording, stopRecording } from '../livekit/egress.js';
import { interviewR2Storage } from '../storage/r2Storage.js';
import { resolveVoice, resolveStt, normalizeLocale } from '../voice/voiceCatalog.js';
import { findPersona, findType, DEFAULT_PERSONA, DEFAULT_TYPE } from '../catalog/interviewCatalog.js';
import { normalizeCharacteristics } from '../prompt/characteristics.js';
import { interviewPromptService } from '../prompt/interviewPromptService.js';
import { inferRoleFromJd } from '../prompt/InterviewBlueprintAgent.js';
import { scoreTranscript } from '../scoring/interviewScorer.js';
import type { InterviewScore } from '../scoring/interviewScorer.js';
import { runInterviewEvaluation } from '../scoring/interviewEvaluationService.js';
import { getWorkerLlmModel } from '../config.js';
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
import { getDefaultModel } from '../../lib/llm/llmModels.js';
import { gateMockInterview } from '../../lib/mockCreditService.js';
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
} from './lifecycleHelpers.js';

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
}

export class InterviewSessionService {
  // ─── Create ─────────────────────────────────────────────────────────────

  async createSession(input: CreateSessionInput): Promise<InterviewSession> {
    const jdText = (input.jdText ?? '').trim().slice(0, 8000) || undefined;
    // When the candidate pasted a JD without picking a role, seed the role from
    // the JD so the session/report/recents never show an empty title.
    const role = (input.role ?? '').trim() || (jdText ? inferRoleFromJd(jdText) : '');
    const persona = (input.personaId && findPersona(input.personaId)) || DEFAULT_PERSONA;
    const type = (input.interviewType && findType(input.interviewType)) || DEFAULT_TYPE;
    const mode: InterviewMode = input.mode === 'video' ? 'video' : 'voice';
    const language = normalizeLocale(input.language);
    const durationMinutes = clampDuration(input.durationMinutes) ?? type.minutes;

    // CREDIT GATE (RoboApply candidate flow only). Recruiter + external-API
    // sources bill separately and are exempt. Runs BEFORE the expensive blueprint
    // LLM call so a credit-less user never burns generation cost. Throws
    // InterviewInsufficientCreditsError → 402 with an upsell payload.
    const source: InterviewSource = input.source ?? 'roboapply';
    if (source === 'roboapply') {
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

    const characteristics = normalizeCharacteristics(input.characteristics, persona.difficulty);
    const candidateName = (input.candidateName ?? '').trim() || undefined;
    const resumeContext = (input.resumeContext ?? '').trim() || undefined;

    // Generate the prompt artifacts (Tavily → blueprint → compose). Never throws.
    const gen = await interviewPromptService.generate({
      role,
      personaName: persona.name,
      personaRole: persona.role,
      personaStyle: persona.style,
      personaDifficulty: persona.difficulty,
      archetype: persona.archetype,
      typeLabel: type.label,
      typeSub: type.sub,
      typeId: type.id,
      language,
      durationMinutes,
      characteristics,
      candidateName,
      resumeContext,
      jdText,
      requestId: input.requestId,
    });

    const voice = resolveVoice(language, persona.voiceGender);
    const roomName = `ie-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + getSessionExpiryMinutes() * 60_000);

    const created = await prisma.interviewSession.create({
      data: {
        userId: input.userId,
        source: input.source ?? 'roboapply',
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
        interviewPrompt: gen.systemPrompt,
        blueprint: { ...gen.blueprint, interviewerBrief: gen.masterBrief, openingInstruction: gen.openingInstruction, openingLine: gen.openingLine } as unknown as object,
        questions: gen.seedQuestions as unknown as object,
        webSources: gen.webSources as unknown as object,
        roomName,
        status: 'created',
        expiresAt,
      },
    });

    logger.info('INTERVIEW_ENGINE_SESSION', 'session created', {
      sessionId: created.id,
      userId: input.userId,
      source: created.source,
      role,
      type: type.id,
      mode,
      language,
      durationMinutes,
      apiKeyId: input.apiKeyId ?? undefined,
      requestId: input.requestId,
    });

    // Meter the prompt-generation (blueprint) LLM cost. At create time the
    // blueprint agent is the only LLM call on this request, so the request
    // snapshot's tokens/cost are exactly the blueprint stage. Best-effort.
    if (input.requestId) {
      const snap = logger.getRequestSnapshot(input.requestId);
      void recordBlueprintCost(created.id, tokenCostFromSnapshot(snap, getDefaultModel()));
    }
    return created;
  }

  // ─── Connect (go live) ────────────────────────────────────────────────────

  async getConnection(params: {
    sessionId: string;
    userId: string;
    apiKeyId?: string | null;
    requestId?: string;
  }): Promise<ConnectionDetails> {
    if (!isLiveKitConfigured()) {
      throw new InterviewEngineConfigError('LiveKit is not configured; cannot start a live interview.');
    }
    const session = await this.loadOwned(params.userId, params.sessionId, params.apiKeyId);

    if (session.status === 'completed' || session.status === 'failed' || session.status === 'expired') {
      throw new InterviewValidationError(`Session is ${session.status}; create a new session.`);
    }

    const mode = session.mode as InterviewMode;
    const voice = (session.voice as unknown as ResolvedVoice) ?? resolveVoice(session.language);
    const identity = `candidate-${session.id}`;
    const ttlSeconds = Math.max(900, session.plannedDurationMinutes * 60 + 600); // duration + 10 min slack

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
      data: { status: 'live', startedAt: session.startedAt ?? new Date(), participantIdentity: identity },
    });

    if (claim.count === 1) {
      // We are the SOLE dispatcher for this session.
      const metadata = this.buildRoomMetadata(session, voice);
      const metadataStr = JSON.stringify(metadata);

      // Surface EVERY model this mock interview will use, in the INFO log /
      // terminal console, at the moment the interview starts. Covers the live
      // worker pipeline (LLM · STT + fallbacks · TTS voice) and the backend
      // agents (blueprint · evaluation · coach, all on the default model).
      logger.info('INTERVIEW_ENGINE_MODELS', `mock interview models · session ${session.id}`, {
        sessionId: session.id,
        role: session.role,
        interviewType: session.interviewType,
        mode,
        language: session.language,
        ...describeSessionModels(voice),
        requestId: params.requestId,
      });

      // Room create + agent dispatch are on the critical path, but a slow or
      // unavailable LiveKit must NEVER hang the connect request — wrap each in a
      // timeout. The candidate's join token is what actually matters.
      const { sid } = await withTimeout(
        createInterviewRoom({ roomName: session.roomName, metadata: metadataStr }),
        8000,
        { sid: null as string | null },
      );

      const agentName = getInterviewAgentName();
      // Race the dispatch for the response (a slow LiveKit must not hang the
      // connect), but do NOT discard a slow-but-successful dispatch id: persist
      // it whenever it lands so the reconnect path can tell "dispatched late"
      // apart from "never dispatched" (and won't double-dispatch).
      const dispatchPromise = dispatchAgent({ roomName: session.roomName, agentName, metadata: metadataStr });
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
      if (isRecordingEnabled() && interviewR2Storage.isConfigured()) {
        recording = true;
        void this.startRecordingInBackground(
          session.id,
          session.roomName,
          interviewR2Storage.recordingKey(session.id, 'mp4'),
          mode,
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
        const metadataStr = JSON.stringify(this.buildRoomMetadata(session, voice));
        const redispatchPromise = dispatchAgent({
          roomName: session.roomName,
          agentName: getInterviewAgentName(),
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
    const tok = await mintJoinToken({
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
  private async startRecordingInBackground(sessionId: string, roomName: string, filepath: string, mode: InterviewMode): Promise<void> {
    try {
      const rec = await startRoomRecording({ roomName, filepath, audioOnly: mode === 'voice' });
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

  private buildRoomMetadata(session: InterviewSession, voice: ResolvedVoice): InterviewRoomMetadata {
    const stt = resolveStt(session.language);
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
      llm: { model: getWorkerLlmModel() },
      callbackBaseUrl: getCallbackBaseUrl(),
    };
  }

  // ─── Transcript ingest (worker callback) ──────────────────────────────────

  async ingestTranscript(params: {
    sessionId: string;
    secret: string | undefined;
    turns: TranscriptTurn[];
  }): Promise<{ ok: true; total: number }> {
    this.assertCallbackSecret(params.secret);
    const incoming = sanitizeTurns(params.turns);

    // Single-statement jsonb append: atomic under concurrent worker flushes
    // (a read-modify-write here loses interleaved batches) AND status-guarded
    // in the same statement (turns arriving after 'completed' are dropped, not
    // resurrected onto an already-scored session). RETURNING gives the
    // post-append length without a second round-trip.
    const rows = await prisma.$queryRawUnsafe<Array<{ total: number }>>(
      `UPDATE "InterviewSession"
          SET transcript = COALESCE(transcript, '[]'::jsonb) || $1::jsonb,
              "updatedAt" = now()
        WHERE id = $2 AND status IN ('created', 'live', 'finalizing')
        RETURNING jsonb_array_length(transcript) AS total`,
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

  /** Worker lifecycle callback: 'started' | 'ended'. 'started' records join
   *  telemetry into liveMetrics.worker; 'ended' triggers finalize. */
  async workerLifecycle(params: {
    sessionId: string;
    secret: string | undefined;
    event: string;
    joinMs?: number;
    greeting?: string;
  }): Promise<void> {
    this.assertCallbackSecret(params.secret);
    if (params.event === 'started') {
      logger.info('INTERVIEW_ENGINE_SESSION', 'worker started', {
        sessionId: params.sessionId, joinMs: params.joinMs, greeting: params.greeting,
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
            startedAt: new Date().toISOString(),
            ...(typeof params.joinMs === 'number' && Number.isFinite(params.joinMs) ? { joinMs: params.joinMs } : {}),
            ...(typeof params.greeting === 'string' && params.greeting ? { greeting: params.greeting.slice(0, 500) } : {}),
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
    if (params.event === 'ended') {
      await this.finalize(params.sessionId).catch((err) => {
        logger.error('INTERVIEW_ENGINE_SESSION', 'finalize from worker lifecycle failed', {
          sessionId: params.sessionId, error: err instanceof Error ? err.message : String(err),
        });
      });
    }
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
    this.assertCallbackSecret(params.secret);
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

  async handleEgressEnded(params: { egressId?: string; roomName?: string; sizeBytes?: number; durationSec?: number; location?: string }): Promise<void> {
    const where = params.egressId ? { egressId: params.egressId } : params.roomName ? { roomName: params.roomName } : null;
    if (!where) return;
    const session = await prisma.interviewSession.findFirst({ where, select: { id: true, mode: true, recordingKey: true } });
    if (!session) return;
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
        recordingMimeType: session.recordingKey || producedFile ? recordingMimeForMode(session.mode) : undefined,
      },
    });
    // Meter the recording's egress + storage cost (no-op until a rate is set).
    if (typeof params.sizeBytes === 'number' && params.sizeBytes > 0) {
      void recordRecordingCost(session.id, params.sizeBytes, params.durationSec ?? 0);
    }
    logger.info('INTERVIEW_ENGINE_SESSION', 'egress ended', { sessionId: session.id, sizeBytes: params.sizeBytes, durationSec: params.durationSec });
  }

  async handleRoomFinished(roomName: string): Promise<void> {
    const session = await prisma.interviewSession.findFirst({ where: { roomName }, select: { id: true, status: true } });
    if (!session) return;
    if (session.status === 'completed') return;
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
  async finalize(sessionId: string): Promise<InterviewSession> {
    const session = await prisma.interviewSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new InterviewNotFoundError();
    if (session.status === 'completed' || session.status === 'finalizing') return session;

    // Atomically CLAIM the terminal transition so EXACTLY ONE of the converging
    // finalize triggers proceeds. finalize() is reachable concurrently from the
    // worker 'ended' lifecycle, the LiveKit room_finished webhook, AND candidate
    // endByOwner — a normal teardown fires several within milliseconds. The old
    // read-check-then-write guard was a TOCTOU: two callers could both observe
    // 'live', both pass, and both run _enrichReport → a duplicate evaluation LLM
    // spend AND a duplicate mock_interview cost ledger row. updateMany is atomic;
    // only the winner gets count===1 (mirrors the created→live claim above).
    const claim = await prisma.interviewSession.updateMany({
      where: { id: sessionId, status: { notIn: ['completed', 'finalizing'] } },
      data: { status: 'finalizing', endedAt: session.endedAt ?? new Date() },
    });
    if (claim.count !== 1) {
      // Lost the race — another trigger is already finalizing/completed. Re-read
      // so we return the current row rather than our pre-claim snapshot.
      const current = await prisma.interviewSession.findUnique({ where: { id: sessionId } });
      return current ?? session;
    }

    // Stop recording if still active (best-effort).
    if (session.egressId) await stopRecording(session.egressId);
    // Tear down the room (best-effort; releases the worker).
    await deleteInterviewRoom(session.roomName);

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
    await sleep(TRANSCRIPT_FLUSH_GRACE_MS);
    let turns = sortTurnsByTs(asTranscript(session.transcript));
    const reread = await readTurns();
    if (reread) turns = reread;

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
      await recordEvaluationCost(sessionId, tokenCostFromSnapshot(logger.getRequestSnapshot(reqId), getDefaultModel()));

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
    const quietBefore = new Date(now.getTime() - RECONCILE_QUIET_MS);
    const rows = await prisma.interviewSession.findMany({
      where: {
        status: { in: ['created', 'live', 'finalizing'] },
        expiresAt: { lt: now },
        updatedAt: { lt: quietBefore },
      },
      select: { id: true, status: true, transcript: true, endedAt: true },
      orderBy: { expiresAt: 'asc' },
      take: RECONCILE_BATCH_SIZE,
    });

    let finalized = 0;
    let expired = 0;
    for (const row of rows) {
      const turnCount = Array.isArray(row.transcript) ? row.transcript.length : 0;
      const action = decideReconcileAction(row.status, turnCount);
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
    if (rows.length > 0) {
      logger.info('INTERVIEW_ENGINE_SESSION', 'reconcile sweep complete', {
        scanned: rows.length, finalized, expired,
      });
    }
    return { scanned: rows.length, finalized, expired };
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
    this.assertCallbackSecret(params.secret);
    const items = Array.isArray(params.modelUsage) ? params.modelUsage : [];
    await recordLiveUsage(params.sessionId, items);
    logger.info('INTERVIEW_ENGINE_SESSION', 'live usage ingested', {
      sessionId: params.sessionId,
      items: items.length,
    });
    return { ok: true };
  }

  /** Candidate explicitly ends the interview from the UI. */
  async endByOwner(params: { sessionId: string; userId: string; apiKeyId?: string | null }): Promise<InterviewSession> {
    const session = await this.loadOwned(params.userId, params.sessionId, params.apiKeyId);
    return this.finalize(session.id);
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

    // Tear down any live LiveKit resources before dropping the row.
    if (session.status === 'created' || session.status === 'live' || session.status === 'finalizing') {
      if (session.egressId) {
        await stopRecording(session.egressId).catch(() => { /* best-effort */ });
      }
      await deleteInterviewRoom(session.roomName).catch(() => { /* best-effort */ });
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

  private assertCallbackSecret(secret: string | undefined): void {
    const expected = getAgentCallbackSecret();
    if (!expected) throw new InterviewAuthError('Callback secret not configured');
    if (!secret || secret !== expected) throw new InterviewAuthError('Invalid callback secret');
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export const interviewSessionService = new InterviewSessionService();
export default interviewSessionService;
