// backend/src/interview-engine/routes/webhookRoutes.ts
//
// LiveKit Cloud webhook receiver. Mounted at
// /api/v1/interview-engine/webhooks/livekit. The RAW body parser is registered
// for this exact path in backend/src/index.ts BEFORE express.json(), so
// req.body here is a Buffer (required for signature verification).
//
// Handled events:
//   egress_ended  → persist recording file size/duration
//   room_finished → finalize the session (score + transcript → R2)

import { Router, type Request, type Response } from 'express';
import { logger } from '../../services/LoggerService.js';
import { receiveWebhook } from '../livekit/webhookReceiver.js';
import { interviewSessionService } from '../sessions/InterviewSessionService.js';

const router = Router();

function bigintToNumber(v: unknown): number | undefined {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

router.post('/livekit', async (req: Request, res: Response) => {
  let rawBody: string;
  if (Buffer.isBuffer(req.body)) rawBody = req.body.toString('utf8');
  else if (typeof req.body === 'string') rawBody = req.body;
  else rawBody = JSON.stringify(req.body ?? {});

  let event;
  try {
    event = await receiveWebhook(rawBody, req.headers.authorization);
  } catch (err) {
    logger.warn('INTERVIEW_ENGINE_WEBHOOK', 'signature verification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(401).json({ error: 'invalid_signature' });
  }

  // Always 200 quickly; process best-effort so LiveKit doesn't retry-storm.
  res.json({ ok: true });

  try {
    const name = event.event;
    if (name === 'egress_ended') {
      const eg: any = (event as any).egressInfo;
      if (eg) {
        const fr = Array.isArray(eg.fileResults) && eg.fileResults.length > 0 ? eg.fileResults[0] : eg.file;
        const sizeBytes = fr ? bigintToNumber(fr.size) : undefined;
        const durNs = fr ? bigintToNumber(fr.duration) : undefined;
        const durationSec = typeof durNs === 'number' && durNs > 0 ? Math.round(durNs / 1e9) : undefined;
        await interviewSessionService.handleEgressEnded({
          egressId: eg.egressId,
          roomName: eg.roomName,
          sizeBytes,
          durationSec,
          location: fr?.location,
        });
      }
    } else if (name === 'room_finished') {
      const roomName = (event as any).room?.name;
      if (roomName) await interviewSessionService.handleRoomFinished(roomName);
    }
  } catch (err) {
    logger.error('INTERVIEW_ENGINE_WEBHOOK', 'processing failed', {
      event: event.event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
