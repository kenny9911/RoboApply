// server/src/features/jobs/companies/routes.ts — STUB (FND-5). Owner: WP-16b.
// Mounted by features/index.ts at /api/v1/roboapply/companies.
// Typeahead is seeker-only; profile, H-1B and jobs are S/P (optional session).

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../../roboapply/engine/middleware/seekerAuth.js';
import { optionalAuth } from '../../../middleware/auth.js';
import { requireFlag } from '../../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../../platform/http.js';
import type { FeatureRouterDeps } from '../../index.js';
import { CompanyIdOrSlugParamsSchema, CompanyIdParamsSchema, CompanyJobsQuerySchema, CompanyTypeaheadQuerySchema } from './contract.js';

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

export function createCompaniesRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];

  router.get('/', ...auth, stub('companies.typeahead', { query: CompanyTypeaheadQuerySchema }));
  router.get('/:idOrSlug', ...maybeAuth, stub('companies.profile', { params: CompanyIdOrSlugParamsSchema }));
  router.get('/:id/h1b', ...maybeAuth, requireFlag('h1bHistory', { env: deps.env }), stub('companies.h1b', { params: CompanyIdParamsSchema }));
  router.get('/:id/jobs', ...maybeAuth, stub('companies.jobs', { params: CompanyIdParamsSchema, query: CompanyJobsQuerySchema }));

  return router;
}
