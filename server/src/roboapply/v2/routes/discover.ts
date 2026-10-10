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
//
// Gates, in order (INT gate; the route has no web caller and stays mounted
// until the owner retires or keeps it, wave5 WP-93 #52):
//   1. `requireAuth`;
//   2. `RA_V2_DISCOVER_DISABLED=true` → 404 feature_disabled (this route only;
//      an operator off switch for both brands, never set by default.
//      `RA_CROSSBANK_DISABLED` is NOT that switch: it also turns the bank
//      ingest adapters off, see raBankClients.isBankEnabled);
//   3. GoApply with CN_RECRUITMENT_INFO_MODE=off → 404 feature_disabled: the
//      run returns recruiter-bank postings and writes them to RAJob. The mode
//      defaults to `licensed` (D5), so with no value set the route is open on
//      GoApply as it is on RoboApply; `off` is the only value that closes it;
//   4. `legacyAiGates()`: GoApply phone binding (403), then the user's AI
//      consent and the brand's text model (503 ai_unavailable). The service
//      sends the user's resume to the explorer, scorer and insight agents, so
//      no model call happens before these pass (TASK_PLAN §2.2, H4). These
//      gates stay on both brands whatever the mode.

import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { EnvSource } from '../../../platform/brand/brandEnv.js';
import { requireCnRecruitmentInfo } from '../../../features/cn/jobs/mode.js';
import { legacyAiGates } from '../lib/legacyAiGates.js';
import { requireAuth } from '../lib/raAuth.js';
import { getRequestLocale } from '../lib/raLocale.js';
import { getCurrentRequestId } from '../../../lib/requestContext.js';
import { logger } from '../../../services/LoggerService.js';
import { prisma } from '../../../lib/prisma.js';
import { raCrossBankSearchService } from '../services/RACrossBankSearchService.js';

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

/** Env: `true` answers 404 on POST /v2/discover/run, whatever else is configured. */
export const DISCOVER_DISABLED_ENV = 'RA_V2_DISCOVER_DISABLED';

function requireDiscoverEnabled(env: EnvSource): RequestHandler {
  return (_req, res, next) => {
    const raw = env[DISCOVER_DISABLED_ENV];
    if (typeof raw === 'string' && raw.trim().toLowerCase() === 'true') {
      res.status(404).json({ success: false, code: 'feature_disabled', error: 'This feature is not available.' });
      return;
    }
    next();
  };
}

async function runDiscover(req: Request, res: Response) {
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
}

/** `env` is where the kill switch and the GoApply recruitment-info mode are read from (tests pass a table). */
export function createDiscoverRouter(options: { env?: EnvSource } = {}): Router {
  const env = options.env ?? process.env;
  const router = Router();
  router.post('/run', requireAuth, requireDiscoverEnabled(env), requireCnRecruitmentInfo({ env }), ...legacyAiGates(), runDiscover);
  return router;
}

export default createDiscoverRouter();
export const __test = { overDailyCap, startOfUtcDay };
