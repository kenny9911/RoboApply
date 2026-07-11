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
import { prisma } from '../../../lib/prisma.js';
import { raCrossBankSearchService } from '../services/RACrossBankSearchService.js';

const router = Router();

// Durable per-user daily cap on this expensive endpoint. Backed by counting
// today's cross-bank deduction rows (one insight + N score rows per run) rather
// than an in-memory Map — the latter resets on every serverless cold start and
// is per-instance, so it can't actually bound spend on Vercel. [review FIX-5]
// The cap is expressed in LLM CALLS/day (≈ runs × ~10); tune via env.
const DAILY_CALL_CAP = Number.parseInt(process.env.RA_CROSSBANK_DAILY_CALL_CAP ?? '', 10) || 400;

function startOfUtcDay(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function overDailyCap(userId: string): Promise<boolean> {
  try {
    const p = prisma as any;
    const used = await p.usageDeductionLog.count({
      where: {
        userId,
        sku: { in: ['ra_crossbank_score', 'ra_crossbank_insight'] },
        createdAt: { gte: startOfUtcDay() },
      },
    });
    return used >= DAILY_CALL_CAP;
  } catch {
    // If the count query fails, fail OPEN (don't block the user) — the
    // service's own scorer budget still bounds per-run cost.
    return false;
  }
}

router.post('/run', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    if (await overDailyCap(userId)) {
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
export const __test = { overDailyCap, startOfUtcDay };
