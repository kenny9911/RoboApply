// server/src/features/growth/publicRoutes.ts — STUB (FND-5). Owner: WP-23.
// POST /api/v1/public/events — first-party events (≤50 per batch, 120/min/anonId).
// Works with or without a session (optionalAuth links events to the user).

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { optionalAuth } from '../../middleware/auth.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { EventsBatchBodySchema } from './contract.js';

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

export function createEventsPublicRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];
  router.post('/', ...maybeAuth, stub('growth.events', { body: EventsBatchBodySchema }));
  return router;
}
