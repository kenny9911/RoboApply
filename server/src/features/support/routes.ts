// server/src/features/support/routes.ts — support area router (WP-40).
// Mounted by features/index.ts at /api/v1/roboapply/support (optional session).
//
//   POST /contact       → SupportContactResponse   5/day/IP (DB-backed)
//   GET  /index-stats   → IndexStatsResponse       public; CDN-cached 1 h (no-store when partial)
//   GET  /credit-caps   → CreditCapsResponse       public; CDN-cached 15 min
//
// The counts never depend on who asks, so the GET answers are public and
// cacheable; the brand comes from the request's host (the CDN keys on it).

import { Router, type Request, type RequestHandler } from 'express';
import { optionalAuth } from '../../middleware/auth.js';
import { getCurrentBrand } from '../../platform/brand/brandContext.js';
import { parseBody, route } from '../../platform/http.js';
import { DAY, rateLimit, type RateWindow } from '../../platform/ratelimit/index.js';
import type { FeatureRouterDeps } from '../index.js';
import { SUPPORT_LIMITS, SupportContactBodySchema } from './contract.js';
import { supportService, type SupportService } from './service.js';

/** RATE_LIMITS entry requested from INT (`supportContactPerIp`); the windows live here until then. */
export const SUPPORT_CONTACT_WINDOWS: readonly RateWindow[] = [{ limit: SUPPORT_LIMITS.perIpPerDay, windowSec: DAY }];

export const INDEX_STATS_CACHE_CONTROL = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';
/** A partial answer (a count query failed) is not kept by the CDN or the browser. */
export const INDEX_STATS_PARTIAL_CACHE_CONTROL = 'no-store';
export const CREDIT_CAPS_CACHE_CONTROL = 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400';

export interface SupportRouterDeps extends FeatureRouterDeps {
  service?: SupportService;
  /** Rate-limit guard for POST /contact (tests inject a pass-through or a fake). */
  contactLimit?: RequestHandler;
}

function sessionUserId(req: Request): string | null {
  const id = (req as Request & { user?: { id?: unknown } }).user?.id;
  return typeof id === 'string' && id ? id : null;
}

export function createSupportRouter(deps: SupportRouterDeps = {}): Router {
  const router = Router();
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];
  const service = () => deps.service ?? supportService();
  const contactLimit = deps.contactLimit ?? rateLimit({ name: 'supportContactPerIp', windows: SUPPORT_CONTACT_WINDOWS, by: 'ip' });

  router.post(
    '/contact',
    ...maybeAuth,
    contactLimit,
    route(async (req) => {
      const body = parseBody(req, SupportContactBodySchema);
      return service().contact(body, { brand: getCurrentBrand(), userId: sessionUserId(req) });
    }),
  );

  router.get(
    '/index-stats',
    route(async (_req, res) => {
      const data = await service().indexStats(getCurrentBrand());
      res.setHeader('Cache-Control', data.partial ? INDEX_STATS_PARTIAL_CACHE_CONTROL : INDEX_STATS_CACHE_CONTROL);
      return data;
    }),
  );

  router.get(
    '/credit-caps',
    route(async (_req, res) => {
      const data = await service().creditCaps(getCurrentBrand());
      res.setHeader('Cache-Control', CREDIT_CAPS_CACHE_CONTROL);
      return data;
    }),
  );

  return router;
}
