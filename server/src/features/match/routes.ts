// server/src/features/match/routes.ts — STUB (FND-5). Owners: WP-18 (fit analysis), WP-77 (competitiveness).
// Mounted by features/index.ts at /api/v1/roboapply/match.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { CompetitivenessBodySchema, FitAnalysisBodySchema, MatchJobParamsSchema } from './contract.js';

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

export function createMatchRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const competitiveness = requireFlag('competitiveness', { env: deps.env });

  router.post('/jobs/:id/fit-analysis', ...auth, stub('match.fitAnalysis', { params: MatchJobParamsSchema, body: FitAnalysisBodySchema }));
  router.post('/competitiveness', ...auth, competitiveness, stub('match.competitiveness', { body: CompetitivenessBodySchema }));
  router.get('/competitiveness/latest', ...auth, competitiveness, stub('match.competitivenessLatest'));

  return router;
}
