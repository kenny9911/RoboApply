// server/src/features/cn/jobs/routes.ts — STUB (FND-5). Owner: WP-41.
//
// Mounted by features/index.ts:
//   createCnJobsRouter()       at /api/v1/roboapply/cn/jobs (seeker)
//   createCnJobsAdminRouter()  at /api/v1/roboapply/admin/cn/jobs (admin)

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../../roboapply/engine/middleware/seekerAuth.js';
import { requireAuth } from '../../../middleware/auth.js';
import { requireAdmin } from '../../../middleware/admin.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../../platform/http.js';
import type { FeatureRouterDeps } from '../../index.js';
import {
  BlacklistEntryBodySchema,
  BlacklistParamsSchema,
  ExternalLinksQuerySchema,
  FraudJobParamsSchema,
  FraudQueueQuerySchema,
  ResolveFraudBodySchema,
} from './contract.js';

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

export function createCnJobsRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  router.get('/external-links', ...auth, stub('cnJobs.externalLinks', { query: ExternalLinksQuerySchema }));
  return router;
}

export function createCnJobsAdminRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];

  router.get('/fraud', ...admin, stub('cnJobs.admin.fraudQueue', { query: FraudQueueQuerySchema }));
  router.post('/fraud/:jobId/resolve', ...admin, stub('cnJobs.admin.resolve', { params: FraudJobParamsSchema, body: ResolveFraudBodySchema }));
  router.get('/blacklist', ...admin, stub('cnJobs.admin.blacklist'));
  router.post('/blacklist', ...admin, stub('cnJobs.admin.addBlacklist', { body: BlacklistEntryBodySchema }));
  router.delete('/blacklist/:id', ...admin, stub('cnJobs.admin.removeBlacklist', { params: BlacklistParamsSchema }));

  return router;
}
