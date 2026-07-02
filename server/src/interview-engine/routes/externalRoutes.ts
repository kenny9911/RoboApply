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
// never read another's.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import { interviewSessionService } from '../sessions/InterviewSessionService.js';
import { toSessionSummary, toSessionDetail } from './serialize.js';
import { handleEngineError } from './errors.js';

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
    const session = await interviewSessionService.createSession({
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
      requestId: getCurrentRequestId() ?? undefined,
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

router.get('/sessions/:id', requireAuth, requireApiKey, async (req: Request, res: Response) => {
  try {
    const session = await interviewSessionService.getOwned(req.user!.id, req.params.id, req.apiKeyId);
    return res.json({ session: toSessionDetail(session) });
  } catch (err) {
    return handleEngineError(res, 'external_get', err, { userId: req.user?.id, sessionId: req.params.id });
  }
});

router.post('/sessions/:id/connection', requireAuth, requireApiKey, async (req: Request, res: Response) => {
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

router.post('/sessions/:id/end', requireAuth, requireApiKey, async (req: Request, res: Response) => {
  try {
    const session = await interviewSessionService.endByOwner({ sessionId: req.params.id, userId: req.user!.id, apiKeyId: req.apiKeyId });
    return res.json({ session: toSessionSummary(session) });
  } catch (err) {
    return handleEngineError(res, 'external_end', err, { userId: req.user?.id, sessionId: req.params.id });
  }
});

router.get('/sessions/:id/report', requireAuth, requireApiKey, async (req: Request, res: Response) => {
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

export default router;
