// backend/src/interview-engine/routes/externalRoutes.ts
//
// PUBLIC external API for third-party apps to run mock interviews inside their
// own product (requirement #7). Authenticated with an `X-API-Key` (rh_...) — a
// cookie/JWT is rejected here so the surface is unambiguously machine-to-machine.
// Mounted at /api/v1/interview-engine/v1.
//
//   POST /sessions                 — create a session (optionally ?connect=1 to
//                                    get the LiveKit connection in one call)
//   GET  /sessions/:id             — session + status
//   POST /sessions/:id/connection  — LiveKit url + token + room (for their client)
//   POST /sessions/:id/end         — finalize
//   GET  /sessions/:id/report      — scored report + presigned media URLs
//
// All sessions are scoped to the API key owner (req.user) so one tenant can
// never read another's. An external session records only when the tenant
// sends `recording: true` (their attestation that the candidate agreed, H8).
//
// FIRST-PARTY practice routes (WP-43) live here too, under /practice. They are
// the opposite: cookie/JWT only, an API key is refused. See the section below.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import {
  interviewSessionService,
  InterviewInsufficientCreditsError,
  ensureFirstPracticeGrant,
  loadPracticeJob,
  loadPracticeResume,
  readPracticeMeta,
  type FirstPracticeState,
} from '../sessions/InterviewSessionService.js';
import { toSessionSummary, toSessionDetail } from './serialize.js';
import { handleEngineError } from './errors.js';
import { getInterviewMediaPolicy, isRecordingEnabled, resolveSessionCallbackBaseUrl } from '../config.js';
import { shouldUseParley } from '../parley/parleyConfig.js';
import type { InterviewSource } from '../types.js';
import { aiGateOpen, currentBrand, gateBody, gateStatus, loadConsent, marketOf, practiceGate } from './practiceGate.js';

export { practiceGate } from './practiceGate.js';
export type { PracticeGate, PracticeGateReason } from './practiceGate.js';

const router = Router();

/** Require that auth resolved via an API key (not a browser cookie/JWT). */
function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!req.apiKeyId) {
    return res.status(403).json({ error: 'api_key_required', message: 'This endpoint requires an X-API-Key header.' });
  }
  next();
}

router.post('/sessions', requireAuth, requireApiKey, async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const created = await interviewSessionService.createSession({
      userId: req.user!.id,
      source: 'external',
      apiKeyId: req.apiKeyId,
      externalRef: typeof b.externalRef === 'string' ? b.externalRef.slice(0, 200) : undefined,
      role: typeof b.role === 'string' ? b.role : '',
      interviewType: typeof b.interviewType === 'string' ? b.interviewType : undefined,
      personaId: typeof b.personaId === 'string' ? b.personaId : undefined,
      mode: b.mode === 'video' ? 'video' : b.mode === 'voice' ? 'voice' : undefined,
      language: typeof b.language === 'string' ? b.language : undefined,
      durationMinutes: typeof b.durationMinutes === 'number' ? b.durationMinutes : undefined,
      characteristics: b.characteristics,
      candidateName: typeof b.candidateName === 'string' ? b.candidateName : undefined,
      resumeContext: typeof b.resumeContext === 'string' ? b.resumeContext : undefined,
      callbackBaseUrl: resolveSessionCallbackBaseUrl(req.headers),
      recording: b.recording === true ? { audio: true, video: b.recordVideo === true } : undefined,
      requestId: getCurrentRequestId() ?? undefined,
    });
    // External callers keep their synchronous contract: the session comes back
    // ready ('created'). strictLlm:false keeps the never-fail heuristic
    // blueprint fallback this API always had.
    const session = await interviewSessionService.prepareSession({
      sessionId: created.id,
      userId: req.user!.id,
      apiKeyId: req.apiKeyId,
      requestId: getCurrentRequestId() ?? undefined,
      strictLlm: false,
    });

    if (req.query.connect === '1' || req.query.connect === 'true') {
      const connection = await interviewSessionService.getConnection({
        sessionId: session.id,
        userId: req.user!.id,
        apiKeyId: req.apiKeyId,
        requestId: getCurrentRequestId() ?? undefined,
      });
      return res.json({ session: toSessionDetail(session), connection });
    }
    return res.json({ session: toSessionDetail(session) });
  } catch (err) {
    return handleEngineError(res, 'external_create', err, { userId: req.user?.id, apiKeyId: req.apiKeyId });
  }
});

router.get('/sessions/:id', requireAuth, requireApiKey, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const session = await interviewSessionService.getOwned(req.user!.id, req.params.id, req.apiKeyId);
    return res.json({ session: toSessionDetail(session) });
  } catch (err) {
    return handleEngineError(res, 'external_get', err, { userId: req.user?.id, sessionId: req.params.id });
  }
});

router.post('/sessions/:id/connection', requireAuth, requireApiKey, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const connection = await interviewSessionService.getConnection({
      sessionId: req.params.id,
      userId: req.user!.id,
      apiKeyId: req.apiKeyId,
      requestId: getCurrentRequestId() ?? undefined,
    });
    return res.json({ connection });
  } catch (err) {
    return handleEngineError(res, 'external_connection', err, { userId: req.user?.id, sessionId: req.params.id });
  }
});

router.post('/sessions/:id/end', requireAuth, requireApiKey, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const session = await interviewSessionService.endByOwner({ sessionId: req.params.id, userId: req.user!.id, apiKeyId: req.apiKeyId });
    return res.json({ session: toSessionSummary(session) });
  } catch (err) {
    return handleEngineError(res, 'external_end', err, { userId: req.user?.id, sessionId: req.params.id });
  }
});

router.get('/sessions/:id/report', requireAuth, requireApiKey, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { session, recordingUrl, transcriptUrl } = await interviewSessionService.getReport({ sessionId: req.params.id, userId: req.user!.id, apiKeyId: req.apiKeyId });
    return res.json({
      session: toSessionDetail(session),
      transcript: Array.isArray(session.transcript) ? session.transcript : [],
      recordingUrl,
      transcriptUrl,
    });
  } catch (err) {
    return handleEngineError(res, 'external_report', err, { userId: req.user?.id, sessionId: req.params.id });
  }
});

// ─── First-party practice (WP-43) ─────────────────────────────────────────
//
// Cookie/JWT routes for the practice setup and report (an API key → 403):
//
//   GET  /practice/setup?job=&resume=  — prefill (job + resume to use), first
//                                        free practice state, voice and
//                                        recording availability, AI consent
//   POST /practice/sessions            — create a candidate session: `jobId`
//                                        (loaded server-side, market-checked →
//                                        404 job_not_found), `resumeId`, and
//                                        `recording: {audio, video}` honoured
//                                        only with the matching consents (H8)
//   GET  /practice/sessions/:id        — report extras: the job it was for,
//                                        whether recording was consented
//   GET  /practice/jobs?ids=a,b        — the job checklist's "Practiced" step
//   POST /practice/text/start          — written practice (where voice is
//                                        not available): `jobId` loaded server-side
//                                        (404 job_not_found), metered like a
//                                        live practice (402 + bucket)
//   POST /practice/text/next-turn      — one answer → the interviewer's reply
//   POST /practice/text/:id/score      — score; an answered practice ticks the
//                                        checklist and the job's "Practiced"
//                                        step once
//
// Every practice route that reaches an LLM checks the brand gate first, so a
// GoApply user without a bound phone or the AI consent never gets an LLM call
// (aiAllowed, TASK_PLAN §2.2), whichever client calls it.
//
// GoApply (market cn): AI routes need a bound phone where one can be bound
// (403 phone_binding_required) and a live `ai_resume_parsing` consent
// (aiAllowed → 503 ai_unavailable/ai_consent_required). Voice is on by default
// and runs on the shared media plane when GoApply has none of its own (D5);
// without the voice capability (`ai.interviewVoice`: no LiveKit at all, or the
// product switch off), or with a configuration no voice session can start on
// (practiceGate: no interview model the plane's worker can run, the
// domestic-only wall without a plane of its own), a session answers 503
// ai_unavailable/voice_unavailable and the setup offers text practice instead.

/** Admins are exempt from practice credits, on the roboapply source (mirrors internalRoutes). */
function isAdmin(user: { role?: string | null; roles?: string[] | null } | undefined): boolean {
  if (!user) return false;
  return user.role === 'admin' || (Array.isArray(user.roles) && user.roles.includes('admin'));
}

function requireFirstParty(req: Request, res: Response, next: NextFunction) {
  if (req.apiKeyId) {
    return res.status(403).json({ error: 'cookie_session_required', message: 'Practice routes are for signed-in users, not API keys.' });
  }
  next();
}

function str(value: unknown, max = 64): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

async function recordingAvailable(): Promise<boolean> {
  if (!isRecordingEnabled()) return false;
  try {
    const { interviewR2Storage } = await import('../storage/r2Storage.js');
    return interviewR2Storage.canStore();
  } catch {
    return false;
  }
}

async function recordingConsents(userId: string): Promise<{ audio: boolean; video: boolean }> {
  try {
    const { hasLiveConsent } = await loadConsent();
    const [audio, video] = await Promise.all([
      hasLiveConsent(userId, 'interview_recording'),
      hasLiveConsent(userId, 'interview_video'),
    ]);
    return { audio, video: audio && video };
  } catch {
    return { audio: false, video: false };
  }
}

/** 402 + what the out-of-credits sheet needs: the bucket, and whether the free first practice still waits on verification. */
function insufficientCredits(res: Response, err: InterviewInsufficientCreditsError, firstPractice: FirstPracticeState | null) {
  return res.status(402).json({
    error: 'insufficient_credits',
    message: err.message,
    balance: err.balance,
    required: err.required,
    tier: err.tier,
    bucket: 'practice',
    firstPractice,
  });
}

async function requestLocale(req: Request): Promise<string | undefined> {
  try {
    const { getRequestLocale } = await import('../../roboapply/v2/lib/raLocale.js');
    return getRequestLocale(req);
  } catch {
    return undefined;
  }
}

function isJobNotFound(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'job_not_found';
}

router.get('/practice/setup', requireAuth, requireFirstParty, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  try {
    const brand = await currentBrand();
    const jobId = str(req.query.job);
    const resumeId = str(req.query.resume);
    const job = jobId ? await loadPracticeJob(userId, jobId, marketOf(brand)) : null;
    if (jobId && !job) return res.status(404).json({ error: 'job_not_found' });
    const [resume, firstPractice, gate, available, consent] = await Promise.all([
      loadPracticeResume(userId, { resumeId, jobId: job?.id ?? null, knownValues: [req.user!.name ?? ''] }).catch(() => null),
      ensureFirstPracticeGrant(userId),
      practiceGate(userId, brand),
      recordingAvailable(),
      recordingConsents(userId),
    ]);
    return res.json({
      market: marketOf(brand),
      job: job
        ? { id: job.id, title: job.title, companyName: job.companyName, location: job.location, jdText: job.jdText, closed: job.closed }
        : null,
      resume: resume ? { id: resume.id, name: resume.name, kind: resume.kind } : null,
      firstPractice,
      voice: gate.voice,
      ai: gate.ai,
      recording: { available, consent },
      // One policy on both brands (config.ts getInterviewMediaPolicy); the
      // client reads it instead of the brand.
      media: getInterviewMediaPolicy(brand),
    });
  } catch (err) {
    return handleEngineError(res, 'practice_setup', err, { userId });
  }
});

router.post('/practice/sessions', requireAuth, requireFirstParty, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  let firstPractice: FirstPracticeState | null = null;
  try {
    const b = req.body ?? {};
    const brand = await currentBrand();
    const gate = await practiceGate(userId, brand);
    if (!gate.voice.available && gate.voice.reason) {
      return res.status(gateStatus(gate.voice.reason)).json(gateBody(gate.voice.reason));
    }

    const admin = isAdmin(req.user as { role?: string; roles?: string[] });
    // Same source rule as the internal create: legacy role-'user' accounts
    // stay on the ungated recruiter source.
    const source: InterviewSource = !admin && req.user!.role === 'user' ? 'recruiter' : 'roboapply';
    const jobId = str(b.jobId);
    // C42: top up the first free practice before the credit gate runs.
    firstPractice = source === 'roboapply' && !admin ? await ensureFirstPracticeGrant(userId) : null;
    const resume = await loadPracticeResume(userId, {
      resumeId: str(b.resumeId),
      jobId,
      knownValues: [req.user!.name ?? ''],
    }).catch(() => null);
    const rec = b.recording && typeof b.recording === 'object' ? (b.recording as Record<string, unknown>) : {};

    const session = await interviewSessionService.createSession({
      userId,
      source,
      creditExempt: admin,
      callbackBaseUrl: resolveSessionCallbackBaseUrl(req.headers),
      transport: source === 'roboapply' && shouldUseParley(req.user!) ? 'parley' : undefined,
      role: typeof b.role === 'string' ? b.role : '',
      interviewType: typeof b.interviewType === 'string' ? b.interviewType : undefined,
      personaId: typeof b.personaId === 'string' ? b.personaId : undefined,
      mode: b.mode === 'video' ? 'video' : b.mode === 'voice' ? 'voice' : undefined,
      language: typeof b.language === 'string' ? b.language : undefined,
      durationMinutes: typeof b.durationMinutes === 'number' ? b.durationMinutes : undefined,
      characteristics: b.characteristics,
      candidateName: typeof b.candidateName === 'string' ? b.candidateName : req.user!.name ?? undefined,
      // Server-chosen resume, PII-redacted; the client never sends the text.
      resumeContext: resume?.context || undefined,
      jdText: typeof b.jdText === 'string' ? b.jdText : undefined,
      jobId,
      market: marketOf(brand),
      recording: { audio: rec.audio === true, video: rec.video === true },
      requestId: getCurrentRequestId() ?? undefined,
    });
    const meta = readPracticeMeta(session.liveMetrics);
    return res.json({
      session: toSessionDetail(session),
      practice: {
        jobId: meta?.jobId ?? null,
        resumeId: resume?.id ?? null,
        recording: meta?.recording ?? { audio: false, video: false },
      },
    });
  } catch (err) {
    if (isJobNotFound(err)) return res.status(404).json({ error: 'job_not_found' });
    if (err instanceof InterviewInsufficientCreditsError) return insufficientCredits(res, err, firstPractice);
    return handleEngineError(res, 'practice_create', err, { userId });
  }
});

router.get('/practice/sessions/:id', requireAuth, requireFirstParty, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const info = await interviewSessionService.getPracticeInfo({ sessionId: req.params.id, userId: req.user!.id });
    return res.json({ practice: info });
  } catch (err) {
    return handleEngineError(res, 'practice_info', err, { userId: req.user?.id, sessionId: req.params.id });
  }
});

router.get('/practice/jobs', requireAuth, requireFirstParty, async (req: Request, res: Response) => {
  try {
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= 64).slice(0, 100);
    const practiced = await interviewSessionService.practicedJobs(req.user!.id, ids);
    return res.json({ practiced });
  } catch (err) {
    return handleEngineError(res, 'practice_jobs', err, { userId: req.user?.id });
  }
});

// ─── Written practice ─────────────────────────────────────────────────────

router.post('/practice/text/start', requireAuth, requireFirstParty, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  let firstPractice: FirstPracticeState | null = null;
  try {
    const b = req.body ?? {};
    const brand = await currentBrand();
    if (!(await aiGateOpen(req, res, brand))) return res;
    const jobId = str(b.jobId);
    const job = jobId ? await loadPracticeJob(userId, jobId, marketOf(brand)) : null;
    if (jobId && !job) return res.status(404).json({ error: 'job_not_found' });
    const admin = isAdmin(req.user as { role?: string; roles?: string[] });
    // C42: top up the first free practice before the credit gate runs.
    firstPractice = admin ? null : await ensureFirstPracticeGrant(userId);
    const started = await interviewSessionService.startTextPractice({
      userId,
      role: typeof b.role === 'string' ? b.role : '',
      interviewerId: typeof b.interviewerId === 'string' ? b.interviewerId : '',
      typeId: typeof b.typeId === 'string' ? b.typeId : '',
      language: typeof b.language === 'string' ? b.language : undefined,
      durationMinutes: typeof b.durationMinutes === 'number' ? b.durationMinutes : undefined,
      job,
      creditExempt: admin,
      locale: await requestLocale(req),
      // The account name never goes to the web-search vendor (as in the live practice).
      knownValues: [req.user!.name ?? ''],
    });
    return res.json(started);
  } catch (err) {
    if (err instanceof InterviewInsufficientCreditsError) return insufficientCredits(res, err, firstPractice);
    return handleEngineError(res, 'practice_text_start', err, { userId });
  }
});

router.post('/practice/text/next-turn', requireAuth, requireFirstParty, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  try {
    const b = req.body ?? {};
    if (!(await aiGateOpen(req, res, await currentBrand()))) return res;
    const result = await interviewSessionService.textPracticeTurn({
      userId,
      sessionId: typeof b.sessionId === 'string' ? b.sessionId : '',
      answer: typeof b.answer === 'string' ? b.answer.slice(0, 8000) : '',
      questionIndex: Number.isInteger(b.questionIndex) ? b.questionIndex : 0,
      locale: await requestLocale(req),
    });
    return res.json(result);
  } catch (err) {
    return handleEngineError(res, 'practice_text_turn', err, { userId });
  }
});

router.post('/practice/text/:id/score', requireAuth, requireFirstParty, async (req: Request<{ id: string }>, res: Response) => {
  const userId = req.user!.id;
  try {
    if (!(await aiGateOpen(req, res, await currentBrand()))) return res;
    const result = await interviewSessionService.scoreTextPractice({ userId, sessionId: req.params.id });
    return res.json(result);
  } catch (err) {
    return handleEngineError(res, 'practice_text_score', err, { userId, sessionId: req.params.id });
  }
});

export default router;
