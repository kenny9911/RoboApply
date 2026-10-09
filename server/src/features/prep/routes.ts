// server/src/features/prep/routes.ts — STUB (FND-5). Owner: WP-59.
// Mounted by features/index.ts at /api/v1/roboapply/interview-bank. Capability
// `interviewBank` per route. The moderation router lives in adminRoutes.ts.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  CompaniesQuerySchema,
  CompanyQuestionsQuerySchema,
  CompanySlugParamsSchema,
  ContributionBodySchema,
  QuestionParamsSchema,
  ReportQuestionBodySchema,
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

export function createInterviewBankRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('interviewBank', { env: deps.env });

  router.get('/companies', ...auth, on, stub('prep.companies', { query: CompaniesQuerySchema }));
  router.get('/companies/:slug/questions', ...auth, on, stub('prep.questions', { params: CompanySlugParamsSchema, query: CompanyQuestionsQuerySchema }));
  router.get('/questions/:id', ...auth, on, stub('prep.question', { params: QuestionParamsSchema }));
  router.post('/questions/:id/report', ...auth, on, stub('prep.report', { params: QuestionParamsSchema, body: ReportQuestionBodySchema }));
  router.post('/contributions', ...auth, on, stub('prep.contribute', { body: ContributionBodySchema }));

  return router;
}
