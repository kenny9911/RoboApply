// backend/src/roboapply/v2/routes/queue.ts
//
// Mounted at /api/v1/roboapply/v2/queue.
//
//   GET    /              — list pending review-queue items (+ pendingCount)
//   POST   /:id/send      — submit-now; resolves with the item flipped to 'sent'
//   POST   /:id/skip      — skip; resolves with the item flipped to 'skipped'
//   PATCH  /:id/cover     — overwrite the draft cover letter (≤6000 chars)
//
// Method semantics + idempotency mirror lib/stub/raV2.stub.ts §Queue. All
// reads/writes are scoped to the authed user via the V1 mission FK inside
// RAQueueService → v1Bridge.
//
// i18n RULE for this page (applies to every current AND future endpoint here):
//   1. Resolve the request locale with `getRequestLocale(req)` and pass it
//      into the service call — never default to English at the route layer.
//   2. Deterministic server-derived user-visible strings (check chips,
//      fallback labels, …) come from lib/raQueueMessages.ts in that locale.
//   3. LLM-generated content (cover letters etc.) gets the locale passed into
//      the agent call (`{ locale }`) so the model answers in the UI language.
//   4. Error payloads stay machine codes ('not_found', 'internal_error') —
//      the frontend maps those to localized copy via its queue.* bundle keys.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { getRequestLocale } from '../lib/raLocale.js';
import { logger } from '../../../services/LoggerService.js';
import {
  raQueueService,
  QueueInvalidInputError,
  QueueItemNotFoundError,
} from '../services/RAQueueService.js';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await raQueueService.list(userId, getRequestLocale(req));
    return res.json(result);
  } catch (err) {
    logger.error('RA_V2_QUEUE', 'list failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/:id/send', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await raQueueService.send(
      userId,
      req.params.id,
      getRequestLocale(req),
    );
    return res.json(result);
  } catch (err) {
    if (err instanceof QueueItemNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    logger.error('RA_V2_QUEUE', 'send failed', {
      userId: req.user?.id,
      runId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/:id/skip', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await raQueueService.skip(
      userId,
      req.params.id,
      getRequestLocale(req),
    );
    return res.json(result);
  } catch (err) {
    if (err instanceof QueueItemNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    logger.error('RA_V2_QUEUE', 'skip failed', {
      userId: req.user?.id,
      runId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.patch('/:id/cover', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { coverLetterMarkdown } = req.body ?? {};
    const result = await raQueueService.updateCover(
      userId,
      req.params.id,
      coverLetterMarkdown,
      getRequestLocale(req),
    );
    return res.json(result);
  } catch (err) {
    if (err instanceof QueueItemNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err instanceof QueueInvalidInputError) {
      return res.status(422).json({ error: err.message });
    }
    logger.error('RA_V2_QUEUE', 'updateCover failed', {
      userId: req.user?.id,
      runId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
