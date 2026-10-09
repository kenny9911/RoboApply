// server/src/features/coaching/routes.ts — STUB (FND-5). Owner: WP-72.
// Mounted by features/index.ts at /api/v1/roboapply/coaching. Capability `coaching` per route.
// The roster admin router lives in adminRoutes.ts. No bookings routes in V2.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { CoachParamsSchema, CoachRequestBodySchema, ListCoachesQuerySchema } from './contract.js';

function stub(what: string, s: { params?: ZodType; query?: ZodType; body?: ZodType } = {}): RequestHandler {
  return markStub(
    route(async (req) => {
      if (s.params) parseParams(req, s.params);
      if (s.query) parseQuery(req, s.query);
      if (s.body) parseBody(req, s.body);
      throw new NotImplementedError(what);
    }),
  );
}

export function createCoachingRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('coaching', { env: deps.env });

  router.get('/coaches', ...auth, on, stub('coaching.list', { query: ListCoachesQuerySchema }));
  router.get('/coaches/:id', ...auth, on, stub('coaching.get', { params: CoachParamsSchema }));
  router.post('/coaches/:id/request', ...auth, on, stub('coaching.request', { params: CoachParamsSchema, body: CoachRequestBodySchema }));

  return router;
}
