// server/src/features/credits/routes.ts — STUB (FND-5). Owner: WP-21a.
//
// Mounted by features/index.ts:
//   createCreditsRouter()      at /api/v1/roboapply/credits
//   createBillingPlansRouter() at /api/v1/roboapply/billing/plans (after the legacy
//                              /billing router, which has no /plans path)
//   createPublicCancelRouter() at /api/v1/public/cancel
// The admin router lives in adminRoutes.ts.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { optionalAuth } from '../../middleware/auth.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  CancelSubscriptionBodySchema,
  CreditHistoryQuerySchema,
  PublicCancelConfirmBodySchema,
  PublicCancelRequestBodySchema,
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

export function createCreditsRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];

  router.get('/', ...auth, stub('credits.get'));
  router.get('/history', ...auth, stub('credits.history', { query: CreditHistoryQuerySchema }));
  router.post('/cancel', ...auth, stub('credits.cancel', { body: CancelSubscriptionBodySchema }));

  return router;
}

export function createBillingPlansRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];
  router.get('/', ...maybeAuth, stub('billing.plans'));
  return router;
}

export function createPublicCancelRouter(_deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  router.post('/', stub('cancel.request', { body: PublicCancelRequestBodySchema }));
  router.post('/confirm', stub('cancel.confirm', { body: PublicCancelConfirmBodySchema }));
  return router;
}
