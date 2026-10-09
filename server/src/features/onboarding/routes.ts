// server/src/features/onboarding/routes.ts — STUB (FND-5). Owner: WP-30 (GoApply steps via onboarding-cn, WP-31).
//
// Mounted by features/index.ts at /api/v1/roboapply/onboarding (TASK_PLAN.md §4.1.a).
// Every handler parses its input with the contract schemas and answers
// 501 not_implemented until the owner fills it. Seeker session required.
// The legacy /v2/onboarding/* router keeps working until WP-75 removes it.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  MarketSnapshotQuerySchema,
  OnboardingConfirmBodySchema,
  OnboardingResumeBodySchema,
  StepBodySchema,
  StepParamsSchema,
  TitleSuggestQuerySchema,
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

export function createOnboardingRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];

  router.get('/state', ...auth, stub('onboarding.state'));
  router.put('/steps/:step', ...auth, stub('onboarding.step', { params: StepParamsSchema, body: StepBodySchema }));
  router.get('/title-suggest', ...auth, stub('onboarding.titleSuggest', { query: TitleSuggestQuerySchema }));
  router.get('/market-snapshot', ...auth, stub('onboarding.marketSnapshot', { query: MarketSnapshotQuerySchema }));
  router.post('/resume', ...auth, stub('onboarding.resume', { body: OnboardingResumeBodySchema }));
  router.post('/match', ...auth, stub('onboarding.match'));
  router.post('/confirm', ...auth, stub('onboarding.confirm', { body: OnboardingConfirmBodySchema }));
  router.post('/complete', ...auth, stub('onboarding.complete'));
  router.post('/skip', ...auth, stub('onboarding.skip'));

  return router;
}
