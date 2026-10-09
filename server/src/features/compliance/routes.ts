// server/src/features/compliance/routes.ts — STUB (FND-5). Owner: WP-13.
//
// Mounted by features/index.ts:
//   createComplianceRouter()       at /api/v1/roboapply/compliance (seeker)
//   createLegalPublicRouter()      at /api/v1/public/legal         (public)
//   createComplianceAdminRouter()  at /api/v1/roboapply/admin/compliance (admin)

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { AdminPiRequestsQuerySchema, CreatePiRequestBodySchema, LegalDocParamsSchema, LegalDocQuerySchema } from './contract.js';

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

export function createComplianceRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];

  router.get('/disclosures', ...auth, stub('compliance.disclosures'));
  router.get('/pi-requests', ...auth, stub('compliance.listPiRequests'));
  router.post('/pi-requests', ...auth, stub('compliance.createPiRequest', { body: CreatePiRequestBodySchema }));
  router.post('/export', ...auth, stub('compliance.export'));

  return router;
}

export function createLegalPublicRouter(_deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  router.get('/:doc', stub('compliance.legalDoc', { params: LegalDocParamsSchema, query: LegalDocQuerySchema }));
  return router;
}

export function createComplianceAdminRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  router.get('/pi-requests', ...admin, stub('compliance.admin.piRequests', { query: AdminPiRequestsQuerySchema }));
  return router;
}
