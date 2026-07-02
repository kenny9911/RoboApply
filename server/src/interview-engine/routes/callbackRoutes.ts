// backend/src/interview-engine/routes/callbackRoutes.ts
//
// Worker → control-plane callbacks. The Python LiveKit agent posts the running
// transcript and lifecycle events here. NOT behind user auth — gated by the
// shared secret (LIVEKIT_AGENT_CALLBACK_SECRET) which the worker sends in the
// `x-interview-callback-secret` header. Mounted at
// /api/v1/interview-engine/callbacks.
//
//   POST /sessions/:id/transcript   body { turns: [{ role, text, ts }] }
//   POST /sessions/:id/usage        body { modelUsage: [{ type, provider, model, ... }] }
//   POST /sessions/:id/metrics      body { events: [{ type, ts, ...latency fields }] }
//   POST /sessions/:id/lifecycle    body { event: 'started' | 'ended', joinMs?, greeting? }

import { Router, type Request, type Response } from 'express';
import { interviewSessionService } from '../sessions/InterviewSessionService.js';
import { handleEngineError } from './errors.js';

const router = Router();

const SECRET_HEADER = 'x-interview-callback-secret';

router.post('/sessions/:id/transcript', async (req: Request, res: Response) => {
  try {
    const secret = (req.headers[SECRET_HEADER] as string | undefined) ?? undefined;
    const turns = Array.isArray(req.body?.turns) ? req.body.turns : [];
    const result = await interviewSessionService.ingestTranscript({ sessionId: req.params.id, secret, turns });
    return res.json(result);
  } catch (err) {
    return handleEngineError(res, 'callback_transcript', err, { sessionId: req.params.id });
  }
});

router.post('/sessions/:id/usage', async (req: Request, res: Response) => {
  try {
    const secret = (req.headers[SECRET_HEADER] as string | undefined) ?? undefined;
    const modelUsage = Array.isArray(req.body?.modelUsage) ? req.body.modelUsage : [];
    const result = await interviewSessionService.ingestUsage({ sessionId: req.params.id, secret, modelUsage });
    return res.json(result);
  } catch (err) {
    return handleEngineError(res, 'callback_usage', err, { sessionId: req.params.id });
  }
});

router.post('/sessions/:sessionId/metrics', async (req: Request, res: Response) => {
  try {
    const secret = (req.headers[SECRET_HEADER] as string | undefined) ?? undefined;
    const result = await interviewSessionService.ingestMetrics({
      sessionId: req.params.sessionId,
      secret,
      events: req.body?.events,
    });
    return res.json(result);
  } catch (err) {
    return handleEngineError(res, 'callback_metrics', err, { sessionId: req.params.sessionId });
  }
});

router.post('/sessions/:id/lifecycle', async (req: Request, res: Response) => {
  try {
    const secret = (req.headers[SECRET_HEADER] as string | undefined) ?? undefined;
    const event = typeof req.body?.event === 'string' ? req.body.event : '';
    await interviewSessionService.workerLifecycle({
      sessionId: req.params.id,
      secret,
      event,
      joinMs: typeof req.body?.joinMs === 'number' ? req.body.joinMs : undefined,
      greeting: typeof req.body?.greeting === 'string' ? req.body.greeting : undefined,
    });
    return res.json({ ok: true });
  } catch (err) {
    return handleEngineError(res, 'callback_lifecycle', err, { sessionId: req.params.id });
  }
});

export default router;
