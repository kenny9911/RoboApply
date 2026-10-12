// server/src/features/coaching/routes.ts — the coach list for seekers (WP-72).
// Mounted by features/index.ts at /api/v1/roboapply/coaching. Capability
// `coaching` on every route (404 feature_disabled when off). Brand-scoped:
// a user only ever sees the current site's roster.
//
//   GET  /coaches?specialty&language    listed coaches (active, reachable)
//   GET  /coaches/:id                   one listed coach
//   POST /coaches/:id/request           { name?, topic, message?, durationMin?, preferredTimes?, contactEmail }
//                                       → emailed to the coach (Reply-To: the user) and to staff;
//                                         5 per user per day; nothing is charged
//
// There are no booking routes in V2 (no bookings data): /bookings answers
// 404 not_found explicitly, so it never falls through to another router.

import { Router, type RequestHandler } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { DAY, rateLimit, type RateWindow } from '../../platform/ratelimit/index.js';
import { HttpError, parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { COACHING_LIMITS, CoachParamsSchema, CoachRequestBodySchema, ListCoachesQuerySchema } from './contract.js';
import type { CoachingService } from './service.js';

export const COACHING_REQUEST_WINDOWS: readonly RateWindow[] = [{ limit: COACHING_LIMITS.requestsPerUserPerDay, windowSec: DAY }];

export interface CoachingRouterOptions {
  /** Test seam; defaults to the process-wide service. */
  service?: CoachingService;
  /** Test seam for the per-user request limit. */
  requestLimit?: RequestHandler;
}

function brandOf(req: unknown): ProductBrand {
  return (req as { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();
}

export function createCoachingRouter(deps: FeatureRouterDeps = {}, options: CoachingRouterOptions = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('coaching', { env: deps.env });
  const svc = async (): Promise<CoachingService> => options.service ?? (await import('./service.js')).getCoachingService();
  const requestLimit =
    options.requestLimit ?? rateLimit({ name: 'coachingRequestPerUser', windows: COACHING_REQUEST_WINDOWS, by: 'user' });

  router.get(
    '/coaches',
    ...auth,
    on,
    route(async (req) => {
      const query = parseQuery(req, ListCoachesQuerySchema);
      return (await svc()).listActive(brandOf(req).id, query);
    }),
  );

  router.get(
    '/coaches/:id',
    ...auth,
    on,
    route(async (req) => {
      const { id } = parseParams(req, CoachParamsSchema);
      return (await svc()).get(brandOf(req).id, id);
    }),
  );

  router.post(
    '/coaches/:id/request',
    ...auth,
    on,
    requestLimit,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, CoachParamsSchema);
      const body = parseBody(req, CoachRequestBodySchema);
      return (await svc()).request(brandOf(req).id, { userId }, id, body);
    }),
  );

  // V2 has no bookings (TASK_PLAN.md C12): say so explicitly, after auth.
  const noBookings = route(async () => {
    throw new HttpError('not_found');
  });
  router.get('/bookings', ...auth, on, noBookings);
  router.post('/bookings', ...auth, on, noBookings);
  router.get('/bookings/:id', ...auth, on, noBookings);

  return router;
}
