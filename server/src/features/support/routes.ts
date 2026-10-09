// server/src/features/support/routes.ts — STUB (FND-5). Owner: WP-40.
// Mounted by features/index.ts at /api/v1/roboapply/support (optional session).

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { optionalAuth } from '../../middleware/auth.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { SupportContactBodySchema } from './contract.js';

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

export function createSupportRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];
  router.post('/contact', ...maybeAuth, stub('support.contact', { body: SupportContactBodySchema }));
  return router;
}
