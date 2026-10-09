// server/src/features/coaching/adminRoutes.ts — STUB (FND-5). Owner: WP-72.
// Mounted by features/index.ts at /api/v1/roboapply/admin/coaching (admin only): roster management.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { AdminCoachesQuerySchema, CoachBodySchema, CoachParamsSchema, PatchCoachBodySchema } from './contract.js';

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

export function createCoachingAdminRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const p = { params: CoachParamsSchema };

  router.get('/coaches', ...admin, stub('coaching.admin.list', { query: AdminCoachesQuerySchema }));
  router.post('/coaches', ...admin, stub('coaching.admin.create', { body: CoachBodySchema }));
  router.patch('/coaches/:id', ...admin, stub('coaching.admin.update', { ...p, body: PatchCoachBodySchema }));
  router.delete('/coaches/:id', ...admin, stub('coaching.admin.delete', p));

  return router;
}
