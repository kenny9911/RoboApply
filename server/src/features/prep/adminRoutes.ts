// server/src/features/prep/adminRoutes.ts — STUB (FND-5). Owner: WP-59.
// Mounted by features/index.ts at /api/v1/roboapply/admin/prep (admin only): contribution moderation.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { ContributionParamsSchema, ModerationQueueQuerySchema, RejectContributionBodySchema } from './contract.js';

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

export function createPrepAdminRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];

  router.get('/contributions', ...admin, stub('prep.admin.queue', { query: ModerationQueueQuerySchema }));
  router.post('/contributions/:id/approve', ...admin, stub('prep.admin.approve', { params: ContributionParamsSchema }));
  router.post('/contributions/:id/reject', ...admin, stub('prep.admin.reject', { params: ContributionParamsSchema, body: RejectContributionBodySchema }));

  return router;
}
