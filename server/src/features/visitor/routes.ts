// server/src/features/visitor/routes.ts — STUB (FND-5). Owner: WP-78.
//
// Mounted by features/index.ts:
//   createVisitorCopilotRouter() at /api/v1/public/copilot (capability `visitorAssistant`)
//   createVisitorAlertsRouter()  at /api/v1/public/alerts  (capability `jobs.alerts`)
// The visitor assistant calls copilot's `handleVisitorTurn()` (WP-50).

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { requireFlag } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { AnonAlertTokenQuerySchema, AnonAlertUnsubscribeBodySchema, CreateAnonAlertBodySchema, VisitorTurnBodySchema } from './contract.js';

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

export function createVisitorCopilotRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  router.post('/', requireFlag('visitorAssistant', { env: deps.env }), stub('visitor.copilot', { body: VisitorTurnBodySchema }));
  return router;
}

export function createVisitorAlertsRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const on = requireFlag('jobs.alerts', { env: deps.env });

  router.post('/', on, stub('visitor.createAlert', { body: CreateAnonAlertBodySchema }));
  router.get('/confirm', on, stub('visitor.confirmAlert', { query: AnonAlertTokenQuerySchema }));
  router.post('/unsubscribe', on, stub('visitor.unsubscribeAlert', { body: AnonAlertUnsubscribeBodySchema }));

  return router;
}
