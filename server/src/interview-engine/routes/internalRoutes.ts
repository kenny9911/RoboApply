// backend/src/interview-engine/routes/internalRoutes.ts
//
// Cookie/JWT-authenticated routes for the first-party UIs (RoboApply candidate
// app + RoboHire recruiter SPA). Mounted at /api/v1/interview-engine.
//
//   GET  /catalog                      — personas + interview types
//   GET  /sessions/recent              — the user's recent sessions
//   POST /sessions                     — create a session (status 'preparing'; fast)
//   POST /sessions/:id/prepare         — generate blueprint + prompt (long; {retry:true} re-runs a failure)
//   GET  /sessions/:id                 — session detail
//   POST /sessions/:id/connection      — go live → LiveKit url + token + room
//   POST /sessions/:id/coach           — live whisper hint/nudge (never 500s)
//   POST /sessions/:id/client-events   — browser telemetry → liveMetrics (never 500s)
//   POST /sessions/:id/end             — finalize (candidate ended)
//   GET  /sessions/:id/report          — scored report + presigned media URLs
//   DELETE /sessions/:id               — delete session + its R2 recording/transcript

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import { getCatalog } from '../catalog/interviewCatalog.js';
import { interviewSessionService } from '../sessions/InterviewSessionService.js';
import { recordCoachCost } from '../billing/sessionCost.js';
import { interviewCoachService } from '../coaching/interviewCoachService.js';
import type { CoachMode } from '../coaching/InterviewCoachAgent.js';
import { toSessionSummary, toSessionDetail } from './serialize.js';
import { handleEngineError } from './errors.js';
import { resolveSessionCallbackBaseUrl } from '../config.js';
import type { InterviewSource } from '../types.js';

/** Admins are exempt from mock-interview credits — explicitly, on the
 *  'roboapply' source (never via the recruiter source path). */
function isAdmin(user: { role?: string | null; roles?: string[] | null } | undefined): boolean {
  if (!user) return false;
  return user.role === 'admin' || (Array.isArray(user.roles) && user.roles.includes('admin'));
}

const router = Router();

router.get('/catalog', requireAuth, (_req: Request, res: Response) => {
  return res.json(getCatalog());
});

router.get('/sessions/recent', requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await interviewSessionService.listRecent(req.user!.id);
    return res.json({ sessions: rows.map(toSessionSummary) });
  } catch (err) {
    return handleEngineError(res, 'recent', err, { userId: req.user?.id });
  }
});

router.post('/sessions', requireAuth, async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const admin = isAdmin(req.user as { role?: string; roles?: string[] });
    // Legacy role-'user' (RoboHire-style) accounts stay on the 'recruiter'
    // source, which was never credit-gated or debited. Moving them onto the
    // seeker credit gate is a billing change that needs product sign-off.
    const source: InterviewSource = !admin && req.user!.role === 'user' ? 'recruiter' : 'roboapply';
    const session = await interviewSessionService.createSession({
      userId: req.user!.id,
      source,
      creditExempt: admin,
      callbackBaseUrl: resolveSessionCallbackBaseUrl(req.headers),
      role: typeof b.role === 'string' ? b.role : '',
      interviewType: typeof b.interviewType === 'string' ? b.interviewType : undefined,
      personaId: typeof b.personaId === 'string' ? b.personaId : undefined,
      mode: b.mode === 'video' ? 'video' : b.mode === 'voice' ? 'voice' : undefined,
      language: typeof b.language === 'string' ? b.language : undefined,
      durationMinutes: typeof b.durationMinutes === 'number' ? b.durationMinutes : undefined,
      characteristics: b.characteristics,
      candidateName: typeof b.candidateName === 'string' ? b.candidateName : req.user!.name ?? undefined,
      resumeContext: typeof b.resumeContext === 'string' ? b.resumeContext : undefined,
      jdText: typeof b.jdText === 'string' ? b.jdText : undefined,
      requestId: getCurrentRequestId() ?? undefined,
    });
    return res.json({ session: toSessionDetail(session) });
  } catch (err) {
    return handleEngineError(res, 'create', err, { userId: req.user?.id });
  }
});

// C2: run (or re-run with {retry:true}) blueprint + prompt generation. A long
// request — the client also polls GET /sessions/:id as a backup.
router.post('/sessions/:id/prepare', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const session = await interviewSessionService.prepareSession({
      sessionId: req.params.id,
      userId: req.user!.id,
      retry: req.body?.retry === true,
      requestId: getCurrentRequestId() ?? undefined,
    });
    return res.json({ session: toSessionDetail(session) });
  } catch (err) {
    return handleEngineError(res, 'prepare', err, { userId: req.user?.id, sessionId: req.params.id });
  }
});

router.get('/sessions/:id', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const session = await interviewSessionService.getOwned(req.user!.id, req.params.id);
    return res.json({ session: toSessionDetail(session) });
  } catch (err) {
    return handleEngineError(res, 'get', err, { userId: req.user?.id, sessionId: req.params.id });
  }
});

router.post('/sessions/:id/connection', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const connection = await interviewSessionService.getConnection({
      sessionId: req.params.id,
      userId: req.user!.id,
      requestId: getCurrentRequestId() ?? undefined,
    });
    return res.json({ connection });
  } catch (err) {
    return handleEngineError(res, 'connection', err, { userId: req.user?.id, sessionId: req.params.id });
  }
});

// Live COACH whisper — a one-line hint (pre-answer strategy) or nudge (live
// correction). Best-effort + never-throws: returns { coach: null } on any
// failure so the live room degrades silently. The coach is an aid, not a gate.
router.post('/sessions/:id/coach', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const b = req.body ?? {};
    const mode: CoachMode = b.mode === 'nudge' ? 'nudge' : 'hint';
    const requestId = getCurrentRequestId() ?? undefined;
    const tip = await interviewCoachService.coach({
      userId: req.user!.id,
      sessionId: req.params.id,
      mode,
      question: typeof b.question === 'string' ? b.question : '',
      answer: typeof b.answer === 'string' ? b.answer : undefined,
      requestId,
    });
    // Meter the coach LLM spend onto the session (fire-and-forget; never
    // throws). Recorded even when the tip degraded to null — tokens already
    // spent are real cost; a request that made no LLM call no-ops inside.
    if (requestId) void recordCoachCost(req.params.id, requestId);
    return res.json({ coach: tip });
  } catch {
    // Defensive: the service already swallows errors, but never 500 the coach.
    return res.json({ coach: null });
  }
});

// First-party browser telemetry from the live room (join timings, connection
// quality, UI events) → liveMetrics.clientEvents. Same degrade contract as the
// coach: telemetry must never surface an error into a running interview, so
// any failure — malformed body, unowned session, DB hiccup — answers ok with
// nothing stored.
router.post('/sessions/:id/client-events', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const result = await interviewSessionService.ingestClientEvents({
      sessionId: req.params.id,
      userId: req.user!.id,
      events: req.body?.events,
    });
    return res.json({ ok: true, stored: result.stored });
  } catch {
    return res.json({ ok: true, stored: 0 });
  }
});

router.post('/sessions/:id/end', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const session = await interviewSessionService.endByOwner({ sessionId: req.params.id, userId: req.user!.id });
    return res.json({ session: toSessionDetail(session) });
  } catch (err) {
    return handleEngineError(res, 'end', err, { userId: req.user?.id, sessionId: req.params.id });
  }
});

router.get('/sessions/:id/report', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { session, recordingUrl, transcriptUrl } = await interviewSessionService.getReport({
      sessionId: req.params.id,
      userId: req.user!.id,
    });
    return res.json({
      session: toSessionDetail(session),
      transcript: Array.isArray(session.transcript) ? session.transcript : [],
      recordingUrl,
      transcriptUrl,
    });
  } catch (err) {
    return handleEngineError(res, 'report', err, { userId: req.user?.id, sessionId: req.params.id });
  }
});

router.delete('/sessions/:id', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    await interviewSessionService.deleteByOwner({ sessionId: req.params.id, userId: req.user!.id });
    return res.json({ ok: true });
  } catch (err) {
    return handleEngineError(res, 'delete', err, { userId: req.user?.id, sessionId: req.params.id });
  }
});

export default router;
