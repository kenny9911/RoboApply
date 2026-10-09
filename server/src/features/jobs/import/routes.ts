// server/src/features/jobs/import/routes.ts — STUB (FND-5). Owner: WP-35.
// Mounted by features/index.ts at /api/v1/roboapply/jobs/import, BEFORE the
// job-detail router at /jobs. Capability `jobs.import` per route.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../../platform/http.js';
import type { FeatureRouterDeps } from '../../index.js';
import { ImportJobBodySchema, ImportParamsSchema } from './contract.js';

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

export function createJobImportRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const flag = requireFlag('jobs.import', { env: deps.env });

  router.post('/', ...auth, flag, stub('jobImport.create', { body: ImportJobBodySchema }));
  router.get('/:importId', ...auth, flag, stub('jobImport.status', { params: ImportParamsSchema }));

  return router;
}
