// backend/src/interview-engine/parley/parleySessions.ts
//
// The Parley side of a practice interview (pilot; see parleyConfig.ts).
//
// A Parley session replaces the LiveKit room + agent dispatch + worker: the
// browser talks to the Parley node directly, and Parley runs STT → LLM → TTS
// itself. Everything after the conversation is UNCHANGED — the transcript is
// written through the same ingest the worker callbacks use, and the session
// finalizes, scores, bills and reports exactly like a LiveKit one.
//
//   create  (POST /sessions)            control.transport = 'parley'  (flag decides, once)
//   connect (POST /sessions/:id/connection)
//           created → live claim, then POST {parley}/v1/sessions; the handle
//           (Parley id + client token) is kept in liveMetrics.parley so a
//           reconnect reuses the same conversation
//   end     candidate End → POST {parley}/end {closing:false}, GET the final
//           transcript, ingest it, finalize (no webhook needed on this path)
//   other ends (time up, candidate hung up, network loss) → Parley's signed
//           session.ended webhook → ingest + finalize
//   safety  finalize of a Parley session that never got a transcript (lost
//           webhook, cron sweep) pulls it from Parley first
//
// This module never imports InterviewSessionService (it imports this one):
// callers hand in a ParleySink — the service's own secret-gated ingest
// methods, invoked with the configured worker callback secret, because a
// verified Parley event plays the worker's role.

import type { InterviewSession } from '../../generated/prisma/client.js';
import prisma from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import { getAgentCallbackSecret, getCallbackBaseUrl } from '../config.js';
import { inSeam } from '../providers/brandScope.js';
import { readRowSeam } from '../providers/sessionSeam.js';
import { asLiveMetrics, readSessionControl } from '../sessions/lifecycleHelpers.js';
import type { LiveModelUsageItem } from '../billing/sessionCost.js';
import type { InterviewMode, ResolvedVoice, TranscriptTurn } from '../types.js';
import { getParleyConfig, getParleyWebhookBaseOverride, resolveParleyTtsProfile, type ParleyConfig } from './parleyConfig.js';
import {
  createParleySession,
  endParleySession,
  getParleySession,
  ParleyApiError,
  type ParleyCreateSessionInput,
  type ParleySessionInfo,
  type ParleyTurnRecord,
} from './parleyClient.js';

export const PARLEY_WEBHOOK_PATH = '/api/v1/interview-engine/webhooks/parley';

/** Parley's hard stop is maxDurationSec + 30 s and its wrap-up note fires
 *  wrapUpNoticeSec (agent setting, 2 min by default) before maxDurationSec.
 *  One minute of runway past the planned length keeps the wrap-up close to the
 *  LiveKit worker's "begin closing at T−2 min" and the hard stop at ~T+90 s. */
const OVERTIME_SEC = 60;
/** sanitizeTurns accepts at most this many turns per ingest call. */
const INGEST_BATCH = 100;
/** A reconnect that lost the create race waits this long for the winner's handle. */
const HANDLE_WAIT_MS = 10_000;
const HANDLE_POLL_MS = 300;

const FALLBACK_PROMPT = 'You are a professional interviewer. Conduct a thoughtful interview.';

/** Spoken when Parley ends the interview itself (time up). An End click skips it. */
const CLOSING_LINES: Record<string, string> = {
  en: "That's all the time we have today. Thanks for your answers — your feedback report will be ready shortly. Goodbye.",
  zh: '好的，今天的面试就到这里。感谢你的回答，你的反馈报告很快就会生成。再见。',
  'zh-TW': '好的，今天的面試就到這裡。感謝你的回答，你的回饋報告很快就會產生。再見。',
  ja: '本日の面接はここまでです。ご回答ありがとうございました。フィードバックレポートはまもなくご覧いただけます。',
  ko: '오늘 면접은 여기까지입니다. 답변해 주셔서 감사합니다. 피드백 리포트가 곧 준비됩니다.',
  es: 'Hemos llegado al final de la entrevista. Gracias por tus respuestas; tu informe de evaluación estará listo en breve. ¡Hasta pronto!',
  fr: "Nous arrivons à la fin de l'entretien. Merci pour vos réponses ; votre rapport d'évaluation sera prêt dans quelques instants. Au revoir.",
  pt: 'Chegamos ao fim da entrevista. Obrigado pelas suas respostas; seu relatório de feedback ficará pronto em instantes. Até logo.',
  de: 'Damit sind wir am Ende des Interviews. Vielen Dank für Ihre Antworten – Ihr Feedback-Bericht ist in Kürze fertig. Auf Wiedersehen.',
};

export function closingLineFor(language: string): string {
  return CLOSING_LINES[language] ?? CLOSING_LINES[language.split('-')[0]] ?? CLOSING_LINES.en;
}

/** Connect → Parley unavailable (unreachable node, bad agent, …). Mapped to
 *  503 `worker_unavailable`, which the practice page shows as "interviewer
 *  unavailable" with a Retry. */
export class ParleyUnavailableError extends Error {
  readonly code = 'worker_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'ParleyUnavailableError';
  }
}

// ─── Session state (liveMetrics JSON, no schema change) ─────────────────────

type IceServer = { urls: string | string[]; username?: string; credential?: string };

/** What the browser needs to join, stored once the Parley session exists. */
export interface ParleyHandle {
  sessionId: string;
  clientToken: string;
  expiresAt: string;
  iceServers: IceServer[];
}

/** The join block returned by POST /sessions/:id/connection for Parley. */
export interface ParleyJoin extends ParleyHandle {
  baseUrl: string;
}

/** Was this session created on the Parley transport? (liveMetrics.control.transport) */
export function isParleySession(session: { liveMetrics: unknown }): boolean {
  return readSessionControl(session.liveMetrics).transport === 'parley';
}

export function readParleyHandle(liveMetrics: unknown): ParleyHandle | null {
  const raw = asLiveMetrics(liveMetrics).parley;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;
  if (typeof h.sessionId !== 'string' || typeof h.clientToken !== 'string') return null;
  return {
    sessionId: h.sessionId,
    clientToken: h.clientToken,
    expiresAt: typeof h.expiresAt === 'string' ? h.expiresAt : '',
    iceServers: Array.isArray(h.iceServers) ? (h.iceServers as IceServer[]) : [],
  };
}

async function saveParleyHandle(sessionId: string, handle: ParleyHandle): Promise<void> {
  // Atomic merge — the worker/client telemetry writers touch other keys of the
  // same column concurrently.
  await prisma.$executeRawUnsafe(
    `UPDATE "InterviewSession"
        SET "liveMetrics" = COALESCE("liveMetrics", '{}'::jsonb) || jsonb_build_object('parley', $2::jsonb)
      WHERE id = $1`,
    sessionId,
    JSON.stringify(handle),
  );
}

// ─── Create (connect step) ──────────────────────────────────────────────────

/** The per-session overrides Parley receives: RoboApply's generated prompt,
 *  its deterministic opening line, the language and the planned length. */
export function buildParleySessionInput(session: InterviewSession): Omit<ParleyCreateSessionInput, 'webhookUrl'> {
  const blueprint = (session.blueprint && typeof session.blueprint === 'object' && !Array.isArray(session.blueprint)
    ? session.blueprint
    : {}) as Record<string, unknown>;
  const openingLine = typeof blueprint.openingLine === 'string' ? blueprint.openingLine.trim() : '';
  const ttsProfileId = resolveParleyTtsProfile(session.language);
  return {
    language: session.language,
    systemPrompt: session.interviewPrompt?.trim() || FALLBACK_PROMPT,
    // A legacy row without a deterministic line falls back to the agent's own.
    ...(openingLine ? { openingLine } : {}),
    closingLine: closingLineFor(session.language),
    maxDurationSec: session.plannedDurationMinutes * 60 + OVERTIME_SEC,
    // Practice recordings are opt-in (INTERVIEW_ENGINE_RECORDING_ENABLED) and
    // land in R2 through LiveKit egress; Parley recordings aren't wired into
    // that pipeline, so the pilot never records.
    recording: false,
    externalRef: session.id,
    metadata: { product: 'roboapply', interviewSessionId: session.id },
    ...(ttsProfileId ? { ttsProfileId } : {}),
  };
}

export interface ParleyConnection {
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
  transport: 'parley';
  parley: ParleyJoin;
}

/**
 * The connect step for a Parley session that passed the status guards
 * ('created' or 'live'). Exactly one caller wins the created→live claim and
 * creates the Parley session; everyone else (reconnects, a second tab, a
 * StrictMode double call) gets the stored handle — posting a new WebRTC offer
 * to the same Parley session resumes the conversation.
 */
export async function getParleyConnection(session: InterviewSession, voice: ResolvedVoice): Promise<ParleyConnection> {
  const cfg = getParleyConfig();
  if (!cfg) throw new ParleyUnavailableError('Parley is not configured (PARLEY_URL / PARLEY_API_KEY / PARLEY_WEBHOOK_SECRET / PARLEY_AGENT_ID).');
  const identity = `candidate-${session.id}`;

  let handle: ParleyHandle | null = readParleyHandle(session.liveMetrics);
  if (!handle && session.status === 'created') {
    const startedAt = session.startedAt ?? new Date();
    const claim = await prisma.interviewSession.updateMany({
      where: { id: session.id, status: 'created' },
      data: { status: 'live', startedAt, participantIdentity: identity },
    });
    if (claim.count === 1) handle = await createHandle(cfg, session, startedAt);
  }
  if (!handle) handle = await waitForHandle(session.id);
  if (!handle) throw new ParleyUnavailableError('Parley session is still being created; retry.');

  return {
    sessionId: session.id,
    url: '',
    token: '',
    roomName: session.roomName,
    identity,
    mode: session.mode as InterviewMode,
    language: session.language,
    voice,
    expiresAt: handle.expiresAt,
    agentDispatched: true,
    recording: false,
    transport: 'parley',
    parley: { ...handle, baseUrl: cfg.baseUrl },
  };
}

async function createHandle(cfg: ParleyConfig, session: InterviewSession, startedAt: Date): Promise<ParleyHandle> {
  const control = readSessionControl(session.liveMetrics);
  const input: ParleyCreateSessionInput = {
    ...buildParleySessionInput(session),
    webhookUrl: `${getParleyWebhookBaseOverride() ?? getCallbackBaseUrl(control.callbackBaseUrl)}${PARLEY_WEBHOOK_PATH}`,
  };
  const t0 = Date.now();
  try {
    const created = await createParleySession(cfg, input);
    const handle: ParleyHandle = {
      sessionId: created.id,
      clientToken: created.clientToken,
      expiresAt: created.expiresAt,
      iceServers: created.rtc?.iceServers ?? [],
    };
    await saveParleyHandle(session.id, handle);
    logger.info('INTERVIEW_ENGINE_SESSION', 'parley session created', {
      sessionId: session.id, parleySessionId: created.id, language: session.language,
      ttsProfileId: input.ttsProfileId, ms: Date.now() - t0,
    });
    return handle;
  } catch (err) {
    // Give the claim back so the candidate's Retry starts over cleanly instead
    // of finding a 'live' session with no conversation behind it.
    await prisma.interviewSession.updateMany({
      where: { id: session.id, status: 'live' },
      data: { status: 'created', startedAt: session.startedAt ?? null, participantIdentity: session.participantIdentity ?? null },
    }).catch(() => { /* the sweep will expire it */ });
    logger.error('INTERVIEW_ENGINE_SESSION', 'parley session create failed', {
      sessionId: session.id, startedAt: startedAt.toISOString(),
      status: err instanceof ParleyApiError ? err.status : undefined,
      code: err instanceof ParleyApiError ? err.code : undefined,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ParleyUnavailableError(err instanceof Error ? err.message : 'Parley session create failed');
  }
}

async function waitForHandle(sessionId: string): Promise<ParleyHandle | null> {
  const deadline = Date.now() + HANDLE_WAIT_MS;
  while (Date.now() < deadline) {
    const row = await prisma.interviewSession.findUnique({
      where: { id: sessionId },
      select: { liveMetrics: true, status: true },
    }).catch(() => null);
    if (!row || (row.status !== 'live' && row.status !== 'created')) return null;
    const handle = readParleyHandle(row.liveMetrics);
    if (handle) return handle;
    await new Promise((r) => setTimeout(r, HANDLE_POLL_MS));
  }
  return null;
}

// ─── Outcome → RoboApply transcript / usage / finalize ──────────────────────

/** The InterviewSessionService methods a Parley outcome is written through. */
export interface ParleySink {
  ingestTranscript(params: { sessionId: string; secret: string | undefined; turns: TranscriptTurn[] }): Promise<{ ok: true; total: number }>;
  ingestMetrics(params: { sessionId: string; secret: string | undefined; events: unknown }): Promise<unknown>;
  ingestUsage(params: { sessionId: string; secret: string | undefined; modelUsage: LiveModelUsageItem[] }): Promise<{ ok: true }>;
  workerLifecycle(params: { sessionId: string; secret: string | undefined; event: string; reason?: string }): Promise<void>;
}

/** Parley turns (atMs since the interview started) → RoboApply turns (epoch
 *  ms). Timestamps are made strictly increasing per role: the ingest dedupes
 *  on (role, ts), so two same-millisecond turns must never collapse. */
export function toTranscriptTurns(turns: ParleyTurnRecord[] | undefined, baseMs: number): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  const last: Record<string, number> = {};
  const sorted = [...(turns ?? [])].sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
  for (const turn of sorted) {
    const text = typeof turn.text === 'string' ? turn.text.trim() : '';
    if (!text) continue;
    const role = turn.role === 'user' ? 'candidate' : 'interviewer';
    let ts = Math.round(baseMs + Math.max(0, Number(turn.atMs) || 0));
    if (last[role] !== undefined && ts <= last[role]) ts = last[role] + 1;
    last[role] = ts;
    out.push({ role, text, ts });
  }
  return out;
}

/** Estimated audio usage so admin cost analytics aren't blank for Parley
 *  sessions (Parley reports no token/character counts yet; LLM stays unpriced). */
export function parleyUsageItems(turns: ParleyTurnRecord[] | undefined, durationMs: number | undefined): LiveModelUsageItem[] {
  const agentChars = (turns ?? []).filter((t) => t.role === 'agent').reduce((n, t) => n + (t.text?.length ?? 0), 0);
  const items: LiveModelUsageItem[] = [];
  if (durationMs && durationMs > 0) items.push({ type: 'stt_usage', provider: 'parley', model: 'parley-stt', audioDurationMs: durationMs });
  if (agentChars > 0) items.push({ type: 'tts_usage', provider: 'parley', model: 'parley-tts', charactersCount: agentChars });
  return items;
}

function requireSecret(): string {
  const secret = getAgentCallbackSecret();
  if (!secret) throw new Error('LIVEKIT_AGENT_CALLBACK_SECRET is not set — Parley outcomes cannot be ingested');
  return secret;
}

/**
 * Write a finished Parley conversation into the RoboApply session: transcript
 * (batched), per-turn latency metrics, estimated usage. Does NOT finalize.
 * Returns the number of turns sent.
 */
export async function ingestParleyOutcome(
  sink: ParleySink,
  sessionId: string,
  outcome: { transcript?: ParleyTurnRecord[]; baseMs: number; durationMs?: number; reason?: string },
): Promise<number> {
  const secret = requireSecret();
  const turns = toTranscriptTurns(outcome.transcript, outcome.baseMs);
  for (let i = 0; i < turns.length; i += INGEST_BATCH) {
    await sink.ingestTranscript({ sessionId, secret, turns: turns.slice(i, i + INGEST_BATCH) });
  }
  const latency = (outcome.transcript ?? [])
    .filter((t) => t.role === 'agent' && t.metrics && typeof t.metrics.voiceToVoiceMs === 'number')
    .map((t) => ({ type: 'parley_turn', ts: Math.round(outcome.baseMs + (t.atMs ?? 0)), ...t.metrics }));
  if (latency.length) {
    await Promise.resolve(sink.ingestMetrics({ sessionId, secret, events: latency })).catch((err) => {
      logger.warn('INTERVIEW_ENGINE_SESSION', 'parley latency metrics not stored', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  await sink.ingestUsage({ sessionId, secret, modelUsage: parleyUsageItems(outcome.transcript, outcome.durationMs) });
  logger.info('INTERVIEW_ENGINE_SESSION', 'parley outcome ingested', {
    sessionId, turns: turns.length, durationMs: outcome.durationMs, reason: outcome.reason, latencyTurns: latency.length,
  });
  return turns.length;
}

function baseFromInfo(info: ParleySessionInfo, fallback: Date | null): number {
  const started = info.startedAt ? Date.parse(info.startedAt) : NaN;
  if (Number.isFinite(started)) return started;
  return (fallback ?? new Date()).getTime();
}

/**
 * Candidate pressed End (endByOwner already claimed 'finalizing'): stop the
 * Parley session without the closing line, then read and ingest the final
 * transcript. True when the transcript is in — finalize can skip its grace.
 */
export async function drainParleySession(sink: ParleySink, session: InterviewSession): Promise<boolean> {
  const cfg = getParleyConfig();
  const handle = readParleyHandle(session.liveMetrics);
  if (!cfg || !handle) return false;
  try {
    await endParleySession(cfg, handle.sessionId, { closing: false }).catch((err) => {
      // Already over on Parley's side (time up / hung up) — its transcript is still readable.
      if (!(err instanceof ParleyApiError && err.status === 404)) throw err;
    });
    const info = await getParleySession(cfg, handle.sessionId);
    await ingestParleyOutcome(sink, session.id, {
      transcript: info.transcript, baseMs: baseFromInfo(info, session.startedAt), durationMs: info.durationMs, reason: info.endReason,
    });
    return true;
  } catch (err) {
    logger.error('INTERVIEW_ENGINE_SESSION', 'parley drain failed — finalizing with what is stored', {
      sessionId: session.id, parleySessionId: handle.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Finalize safety net: a Parley session finalizing without a drain (lost
 * webhook, cron sweep) pulls its transcript from Parley first. Best-effort.
 */
export async function pullParleyTranscript(sink: ParleySink, session: InterviewSession): Promise<void> {
  const cfg = getParleyConfig();
  const handle = readParleyHandle(session.liveMetrics);
  if (!cfg || !handle) return;
  try {
    const info = await getParleySession(cfg, handle.sessionId);
    if (info.status === 'live' || info.status === 'connecting') {
      // Still talking on Parley's side (RoboApply is finalizing anyway, e.g.
      // the expiry sweep) — stop it so the transcript is complete.
      await endParleySession(cfg, handle.sessionId, { closing: false }).catch(() => undefined);
      const done = await getParleySession(cfg, handle.sessionId);
      await ingestParleyOutcome(sink, session.id, {
        transcript: done.transcript, baseMs: baseFromInfo(done, session.startedAt), durationMs: done.durationMs, reason: done.endReason,
      });
      return;
    }
    if (info.transcript?.length) {
      await ingestParleyOutcome(sink, session.id, {
        transcript: info.transcript, baseMs: baseFromInfo(info, session.startedAt), durationMs: info.durationMs, reason: info.endReason,
      });
    }
  } catch (err) {
    logger.warn('INTERVIEW_ENGINE_SESSION', 'parley transcript pull failed', {
      sessionId: session.id, parleySessionId: handle.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Owner deleted an active session: stop the Parley conversation. Best-effort. */
export async function stopParleySession(session: { liveMetrics: unknown }): Promise<void> {
  const cfg = getParleyConfig();
  const handle = readParleyHandle(session.liveMetrics);
  if (!cfg || !handle) return;
  await endParleySession(cfg, handle.sessionId, { closing: false }).catch(() => undefined);
}

// ─── Webhook ────────────────────────────────────────────────────────────────

export interface ParleyWebhookPayload {
  event?: string;
  createdAt?: string;
  data?: {
    sessionId?: string;
    externalRef?: string;
    reason?: string;
    /** When the interview started on Parley; every turn's atMs is relative to it. */
    startedAt?: string;
    durationMs?: number;
    transcript?: ParleyTurnRecord[];
  };
}

/**
 * A verified Parley webhook. Routed to the RoboApply session named by
 * externalRef, and only if that session's stored Parley id matches — a
 * stray/replayed event for another session is ignored.
 */
export async function handleParleyWebhook(sink: ParleySink, payload: ParleyWebhookPayload): Promise<'handled' | 'ignored'> {
  const data = payload.data ?? {};
  const sessionId = typeof data.externalRef === 'string' ? data.externalRef : '';
  if (!sessionId || typeof data.sessionId !== 'string') return 'ignored';
  const session = await prisma.interviewSession.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true, liveMetrics: true, startedAt: true, brand: true, voiceProvider: true },
  });
  if (!session || !isParleySession(session)) return 'ignored';
  if (readParleyHandle(session.liveMetrics)?.sessionId !== data.sessionId) return 'ignored';
  // A verified Parley event plays the worker's role, so it carries the worker
  // secret of the SESSION's brand and plane, whichever host Parley called.
  const seam = readRowSeam(session);
  return seam ? inSeam(seam, () => applyParleyEvent(sink, payload, session)) : applyParleyEvent(sink, payload, session);
}

async function applyParleyEvent(
  sink: ParleySink,
  payload: ParleyWebhookPayload,
  session: { id: string; status: string; startedAt: Date | null },
): Promise<'handled' | 'ignored'> {
  const data = payload.data ?? {};
  const sessionId = session.id;
  const secret = requireSecret();

  if (payload.event === 'session.started') {
    await sink.workerLifecycle({ sessionId, secret, event: 'started' });
    return 'handled';
  }
  if (payload.event === 'session.ended') {
    // Already finalizing/finalized on our side (End → drain, the expiry sweep
    // → pull): that path ingested this same outcome, so a second ingest would
    // only duplicate the latency telemetry.
    if (session.status !== 'live' && session.status !== 'created') return 'ignored';
    // The same base the drain/pull path uses (Parley's startedAt), so a turn
    // ingested by both gets the same ts and the (role, ts) dedupe drops it.
    const started = data.startedAt ? Date.parse(data.startedAt) : NaN;
    const sentAt = payload.createdAt ? Date.parse(payload.createdAt) : NaN;
    const baseMs = Number.isFinite(started)
      ? started
      : Number.isFinite(sentAt) && typeof data.durationMs === 'number'
        ? sentAt - data.durationMs
        : (session.startedAt ?? new Date()).getTime();
    await ingestParleyOutcome(sink, sessionId, {
      transcript: data.transcript, baseMs, durationMs: data.durationMs, reason: data.reason,
    });
    // 'ended' stamps workerEndedAt and finalizes with the drain already done.
    await sink.workerLifecycle({ sessionId, secret, event: 'ended', reason: data.reason });
    return 'handled';
  }
  return 'ignored';
}
