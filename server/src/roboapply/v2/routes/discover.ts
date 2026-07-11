// backend/src/roboapply/v2/routes/discover.ts
//
// Mounted at /api/v1/roboapply/v2/discover.
//
//   POST /run — run one cross-bank job-search round over the RoboHire + GoHire
//               banks and return Recommended / Explore buckets + coverage +
//               insight. Materializes matched jobs into RAJob so they also
//               surface in /home, /search, /tracker.
//
// The service never throws (worst case: zeroResults). A per-user daily cap +
// rate limit bounds the ≤$0.35/run LLM cost.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { getRequestLocale } from '../lib/raLocale.js';
import { getCurrentRequestId } from '../../../lib/requestContext.js';
import { logger } from '../../../services/LoggerService.js';
import { raCrossBankSearchService } from '../services/RACrossBankSearchService.js';

const router = Router();

// Simple in-memory per-user daily cap (mirrors the mission daily-cap pattern).
// Bounds the LLM spend of an inherently expensive endpoint. Resets on restart;
// a durable cap can move to the DB later.
const DAILY_CAP = Number.parseInt(process.env.RA_CROSSBANK_DAILY_CAP ?? '', 10) || 25;
const runCounts = new Map<string, { day: string; n: number }>();

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function checkAndBumpCap(userId: string): boolean {
  const today = dayKey();
  const cur = runCounts.get(userId);
  if (!cur || cur.day !== today) {
    runCounts.set(userId, { day: today, n: 1 });
    return true;
  }
  if (cur.n >= DAILY_CAP) return false;
  cur.n += 1;
  return true;
}

router.post('/run', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    if (!checkAndBumpCap(userId)) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const resumeVariantId =
      typeof body.resumeVariantId === 'string' && body.resumeVariantId ? body.resumeVariantId : null;
    const aggressivenessRaw = body.aggressiveness;
    const aggressiveness =
      aggressivenessRaw === 'coverage' || aggressivenessRaw === 'precision' || aggressivenessRaw === 'balanced'
        ? aggressivenessRaw
        : 'balanced';
    const limit =
      typeof body.limit === 'number' && Number.isFinite(body.limit)
        ? Math.max(1, Math.min(24, Math.round(body.limit)))
        : undefined;

    const result = await raCrossBankSearchService.run({
      userId,
      resumeVariantId,
      locale: getRequestLocale(req),
      requestId: getCurrentRequestId(),
      aggressiveness,
      limit,
    });

    return res.json({
      recommended: result.recommended,
      explore: result.explore,
      coverage: result.coverage,
      insight: result.insight,
      banksSwept: result.banksSwept,
      scorer: {
        callsUsed: result.scorerCallsUsed,
        cacheHits: result.scorerCacheHits,
        budget: Number.parseInt(process.env.RA_CROSSBANK_SCORER_BUDGET ?? '', 10) || 16,
      },
      zeroResults: result.zeroResults,
    });
  } catch (err) {
    logger.error('RA_V2_CROSSBANK', 'discover/run failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
export const __test = { checkAndBumpCap, runCounts };
