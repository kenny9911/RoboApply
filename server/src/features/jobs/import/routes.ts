// server/src/features/jobs/import/routes.ts — "Added by you" (WP-35).
// Mounted by features/index.ts at /api/v1/roboapply/jobs/import, BEFORE the
// job-detail router at /jobs. Capability `jobs.import` per route.
//
//   POST   /                 { url } → draft | { manual, importId? } → saved job
//   GET    /                 the user's added jobs (newest first, cursor)
//   GET    /:importId        status of a draft (signed id) or a saved job
//   DELETE /jobs/:jobId      remove an added job (archived; tracker rows stay)

import { Router } from 'express';
import { seekerAuth } from '../../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../../platform/flags.js';
import { parseBody, parseParams, parseQuery, requireUserId, route } from '../../../platform/http.js';
import type { FeatureRouterDeps } from '../../index.js';
import { AddedJobParamsSchema, AddedJobsQuerySchema, ImportJobBodySchema, ImportParamsSchema } from './contract.js';
import { jobImportService, type JobImportService } from './service.js';

export interface JobImportRouterDeps extends FeatureRouterDeps {
  service?: JobImportService;
}

export function createJobImportRouter(deps: JobImportRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const flag = requireFlag('jobs.import', { env: deps.env });
  const service = (): JobImportService => deps.service ?? jobImportService;

  router.post(
    '/',
    ...auth,
    flag,
    route(async (req) => {
      const userId = requireUserId(req);
      const body = parseBody(req, ImportJobBodySchema);
      return service().importJob(userId, body, req.get('Idempotency-Key') ?? null);
    }),
  );

  router.get(
    '/',
    ...auth,
    flag,
    route(async (req) => {
      const userId = requireUserId(req);
      const query = parseQuery(req, AddedJobsQuerySchema);
      return service().listAdded(userId, query);
    }),
  );

  router.get(
    '/:importId',
    ...auth,
    flag,
    route(async (req) => {
      const userId = requireUserId(req);
      const { importId } = parseParams(req, ImportParamsSchema);
      return service().status(userId, importId);
    }),
  );

  router.delete(
    '/jobs/:jobId',
    ...auth,
    flag,
    route(async (req, res) => {
      const userId = requireUserId(req);
      const { jobId } = parseParams(req, AddedJobParamsSchema);
      await service().removeAdded(userId, jobId);
      res.status(204).end();
    }),
  );

  return router;
}
