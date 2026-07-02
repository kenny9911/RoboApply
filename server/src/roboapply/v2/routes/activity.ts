// backend/src/roboapply/v2/routes/activity.ts
//
// Mounted at /api/v1/roboapply/v2/activity.
//
//   GET /            — day-grouped activity feed (?days=N, default 7, max 90)
//   GET /orb-stats   — the agent-stats aggregate (sent/replies/inQueue/…)
//
// Path note for the _real.ts wiring: the stub's `activity.feed(params)` maps to
// GET /activity (with ?days), and `activity.orbStats()` maps to
// GET /activity/orb-stats. These are NEW paths the contract didn't pin (the
// stub is in-memory) — reported back for the _real.ts swap.
//
// Response shapes mirror lib/stub/raV2.stub.ts §Activity exactly:
//   feed     → { days: RAActivityDay[] }
//   orbStats → { stats: RAAgentStats }

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { logger } from '../../../services/LoggerService.js';
import { raActivityService } from '../services/RAActivityService.js';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const daysRaw = req.query.days;
    const days =
      typeof daysRaw === 'string' && Number.isFinite(Number(daysRaw))
        ? Number(daysRaw)
        : undefined;
    const result = await raActivityService.feed(userId, days);
    return res.json(result);
  } catch (err) {
    logger.error('RA_V2_ACTIVITY', 'feed failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/orb-stats', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await raActivityService.orbStats(userId);
    return res.json(result);
  } catch (err) {
    logger.error('RA_V2_ACTIVITY', 'orbStats failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
