// backend/src/roboapply/v2/routes/insights.ts
//
// Mounted at /api/v1/roboapply/v2/insights. The weekly card on
// /applications?view=date (ruling C40; WP-38).
//
//   GET  /weekly?weekStartUtc=YYYY-MM-DD — the week's counts + the AI summary
//                                          for that week when one exists
//   POST /refresh                        — write this week's AI summary
//                                          (1 per hour per user; 503
//                                          ai_unavailable without consent or model;
//                                          403 phone_binding_required for a GoApply
//                                          WeChat account without a verified phone)
//
// Responses use the platform envelope (`{ success, data }`); the web reads
// them through lib/api/tracker.ts.

import { Router, type RequestHandler } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { getRequestLocale } from '../lib/raLocale.js';
import { parseQuery, requireUserId, route } from '../../../platform/http.js';
import { HOUR, rateLimit, type RateWindow } from '../../../platform/ratelimit/index.js';
import { WeeklyInsightQuerySchema } from '../../../features/tracker/index.js';
import { requirePhoneBound } from '../../../features/auth-cn/index.js';
import { raInsightService, type InsightService } from '../services/RAInsightService.js';

export const INSIGHT_REFRESH_LIMIT_NAME = 'insightRefreshPerUser';
export const INSIGHT_REFRESH_WINDOWS: readonly RateWindow[] = [{ limit: 1, windowSec: HOUR }];

export interface InsightsRouterOptions {
  service?: InsightService;
  auth?: RequestHandler[];
  limiter?: (name: string, windows: readonly RateWindow[]) => RequestHandler;
  /** GoApply WeChat accounts bind a phone before AI features (403 phone_binding_required; WP-11). */
  phoneGate?: RequestHandler;
}

export function createInsightsRouter(options: InsightsRouterOptions = {}): Router {
  const router = Router();
  const service = options.service ?? raInsightService;
  const auth = options.auth ?? [requireAuth];
  const limiter = options.limiter ?? ((name, windows) => rateLimit({ name, windows, by: 'user' }));
  const phoneGate = options.phoneGate ?? requirePhoneBound();

  router.get(
    '/weekly',
    ...auth,
    route(async (req) => {
      const { weekStartUtc } = parseQuery(req, WeeklyInsightQuerySchema);
      return service.getWeekly(requireUserId(req), weekStartUtc);
    }),
  );

  router.post(
    '/refresh',
    ...auth,
    phoneGate,
    limiter(INSIGHT_REFRESH_LIMIT_NAME, INSIGHT_REFRESH_WINDOWS),
    route(async (req) => service.refresh(requireUserId(req), getRequestLocale(req))),
  );

  return router;
}

export default createInsightsRouter();
