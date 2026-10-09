// backend/src/interview-engine/routes/parleyWebhookRoutes.ts
//
// Parley webhook receiver (practice-interview pilot, see parley/). Mounted at
// /api/v1/interview-engine/webhooks/parley. Like the LiveKit receiver, the RAW
// body parser is registered for this exact path in app.ts BEFORE
// express.json(): the HMAC is computed over the untouched bytes.
//
//   session.started → worker 'started' telemetry
//   session.ended   → transcript + latency + usage ingest, then finalize
//
// Unlike LiveKit's, this one answers only AFTER processing: Parley retries a
// non-2xx with backoff, and every step is idempotent (turns dedupe on
// role:ts, finalize claims once), so a retry is the recovery path — and a
// serverless instance never freezes mid-finalize after an early 200.

import { Router, type Request, type Response } from 'express';
import { logger } from '../../services/LoggerService.js';
import { interviewSessionService } from '../sessions/InterviewSessionService.js';
import { getParleyConfig } from '../parley/parleyConfig.js';
import { verifyParleySignature } from '../parley/parleyClient.js';
import { handleParleyWebhook, type ParleyWebhookPayload } from '../parley/parleySessions.js';

const router = Router();

router.post('/parley', async (req: Request, res: Response) => {
  const cfg = getParleyConfig();
  if (!cfg) return res.status(503).json({ error: 'parley_not_configured' });

  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : '';
  if (!verifyParleySignature(req.header('x-parley-signature'), raw, cfg.webhookSecret)) {
    logger.warn('INTERVIEW_ENGINE_WEBHOOK', 'parley signature verification failed', { event: req.header('x-parley-event') });
    return res.status(401).json({ error: 'invalid_signature' });
  }

  let payload: ParleyWebhookPayload;
  try {
    payload = JSON.parse(raw) as ParleyWebhookPayload;
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }

  try {
    const result = await handleParleyWebhook(interviewSessionService, payload);
    if (result === 'ignored') {
      logger.info('INTERVIEW_ENGINE_WEBHOOK', 'parley event ignored', {
        event: payload.event, sessionId: payload.data?.externalRef, parleySessionId: payload.data?.sessionId,
      });
    }
    return res.json({ ok: true, ...(result === 'ignored' ? { ignored: true } : {}) });
  } catch (err) {
    logger.error('INTERVIEW_ENGINE_WEBHOOK', 'parley event processing failed', {
      event: payload.event, sessionId: payload.data?.externalRef,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'processing_failed' });
  }
});

export default router;
