// backend/src/roboapply/v2/routes/insights.ts
//
// Mounted at /api/v1/roboapply/v2/insights.
//
//   GET  /weekly   — returns the cached row for the requested week (or null)
//   POST /refresh  — regenerate via RACareerInsightAgent (1/hour cooldown)
//
// `/refresh` cooldown is enforced in the service via an in-memory map; the
// 429 carries `code: 'rate_limited'`.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { getRequestLocale } from '../lib/raLocale.js';
import { logger } from '../../../services/LoggerService.js';
import {
  raInsightService,
  InsightRateLimitedError,
  weekRangeFor,
} from '../services/RAInsightService.js';

const router = Router();

router.get('/weekly', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const wkRaw = req.query.weekStartUtc;
    const week =
      typeof wkRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(wkRaw)
        ? wkRaw
        : undefined;
    const { insight, weekStartUtc } = await raInsightService.getWeekly(userId, week);
    return res.json({
      insight,
      week: weekRangeFor(weekStartUtc),
      // Stub returns null; cron-scheduled generation is BE3 territory.
      nextGenerationAt: null,
    });
  } catch (err) {
    logger.error('RA_V2_INSIGHT', 'weekly failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/refresh', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const insight = await raInsightService.refresh(userId, getRequestLocale(req));
    return res.json({ insight });
  } catch (err) {
    if (err instanceof InsightRateLimitedError) {
      return res.status(429).json({ error: 'rate_limited' });
    }
    logger.error('RA_V2_INSIGHT', 'refresh failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
