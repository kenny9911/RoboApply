// server/src/features/jobs/detail/routes.ts — STUB (FND-5). Owner: WP-34 (score route: WP-18 via match/index.ts).
// Mounted by features/index.ts at /api/v1/roboapply/jobs, AFTER /jobs/import.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../../roboapply/engine/middleware/seekerAuth.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../../platform/http.js';
import type { FeatureRouterDeps } from '../../index.js';
import { JobIdParamsSchema, MarkAppliedBodySchema, ScoreJobBodySchema } from './contract.js';

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

export function createJobDetailRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const p = { params: JobIdParamsSchema };

  router.get('/:id', ...auth, stub('jobs.get', p));
  router.post('/:id/score', ...auth, stub('jobs.score', { ...p, body: ScoreJobBodySchema }));
  router.get('/:id/similar', ...auth, stub('jobs.similar', p));
  router.post('/:id/save', ...auth, stub('jobs.save', p));
  router.delete('/:id/save', ...auth, stub('jobs.unsave', p));
  router.post('/:id/apply-click', ...auth, stub('jobs.applyClick', p));
  router.post('/:id/applied', ...auth, stub('jobs.markApplied', { ...p, body: MarkAppliedBodySchema }));
  router.delete('/:id/applied', ...auth, stub('jobs.undoApplied', p));
  router.post('/:id/share', ...auth, stub('jobs.share', p));

  return router;
}
