// server/src/features/credits/adminRoutes.ts — STUB (FND-5). Owner: WP-21a.
// Mounted by features/index.ts at /api/v1/roboapply/admin/credits (admin only):
// caps editor (AppConfig credits.catalog.v1), entitlement overrides, FX
// reference (TWD line), TW revenue monitor.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { CreateOverrideBodySchema, ListOverridesQuerySchema, OverrideParamsSchema, PutCatalogBodySchema, PutFxReferenceBodySchema } from './contract.js';

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

export function createCreditsAdminRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];

  router.get('/catalog', ...admin, stub('credits.admin.getCatalog'));
  router.put('/catalog', ...admin, stub('credits.admin.putCatalog', { body: PutCatalogBodySchema }));
  router.get('/overrides', ...admin, stub('credits.admin.listOverrides', { query: ListOverridesQuerySchema }));
  router.post('/overrides', ...admin, stub('credits.admin.createOverride', { body: CreateOverrideBodySchema }));
  router.delete('/overrides/:id', ...admin, stub('credits.admin.deleteOverride', { params: OverrideParamsSchema }));
  router.get('/fx-reference', ...admin, stub('credits.admin.getFx'));
  router.put('/fx-reference', ...admin, stub('credits.admin.putFx', { body: PutFxReferenceBodySchema }));
  router.get('/tw-revenue', ...admin, stub('credits.admin.twRevenue'));

  return router;
}
