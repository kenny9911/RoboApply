// server/src/features/jobs/sources/atsPublic/routes.ts — STUB (FND-5). Owner: WP-42.
// Mounted by features/index.ts at /api/v1/roboapply/admin/career-sources (admin only).

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { requireAuth } from '../../../../middleware/auth.js';
import { requireAdmin } from '../../../../middleware/admin.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../../../platform/http.js';
import type { FeatureRouterDeps } from '../../../index.js';
import { CareerSourceBodySchema, CareerSourceParamsSchema, ListCareerSourcesQuerySchema, PatchCareerSourceBodySchema } from './contract.js';

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

export function createCareerSourcesAdminRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const p = { params: CareerSourceParamsSchema };

  router.get('/', ...admin, stub('careerSources.list', { query: ListCareerSourcesQuerySchema }));
  router.post('/', ...admin, stub('careerSources.create', { body: CareerSourceBodySchema }));
  router.patch('/:id', ...admin, stub('careerSources.update', { ...p, body: PatchCareerSourceBodySchema }));
  router.delete('/:id', ...admin, stub('careerSources.delete', p));
  router.post('/:id/run', ...admin, stub('careerSources.runNow', p));

  return router;
}
