// backend/src/roboapply/routes/digest.ts
//
// Mounted at /api/v1/roboapply/digest/* in backend/src/index.ts.
//
//   GET /today — returns today's persisted digest (narrative + emailBody +
//                cited runs) for Mission Control SSE replay. 404 if the
//                7am cron hasn't fired yet.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireSeekerProfile } from '../engine/middleware/seekerAuth.js';
import { getTodayDigestForUser } from '../services/RoboApplyDigestService.js';
import { logger } from '../../services/LoggerService.js';

const router = Router();

// ─── GET /today ─────────────────────────────────────────────────────────

router.get('/today', requireAuth, requireSeekerProfile, async (req: Request, res: Response) => {
  try {
    const payload = await getTodayDigestForUser(req.user!.id);
    // "No digest yet" is a normal first-run state, not an error. Returning
    // 200 with `data: null` lets the frontend render the empty-state agent
    // quote ("Good morning. First day on the job…") without a console 404.
    if (!payload) {
      return res.json({ success: true, data: null });
    }
    return res.json({ success: true, data: payload });
  } catch (err) {
    logger.error('ROBOAPPLY_DIGEST', 'GET /today failed', {
      error: err instanceof Error ? err.message : String(err),
    }, req.requestId);
    return res.status(500).json({ success: false, code: 'get_digest_failed', error: 'Failed to load digest' });
  }
});

export default router;
