// server/src/features/cn/campus/routes.ts — STUB (FND-5). Owner: WP-58.
//
// Mounted by features/index.ts:
//   createCampusEventsRouter()  at /api/v1/roboapply/cn/campus-events (S/P)
//   createCampusPublicRouter()  at /api/v1/public/campus
//   createCampusAdminRouter()   at /api/v1/roboapply/admin/cn/campus (admin)
// Capability `jobs.campusCalendar` on the user-facing routes; admin curation
// is not gated so staff can prepare entries before the capability turns on.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../../roboapply/engine/middleware/seekerAuth.js';
import { optionalAuth, requireAuth } from '../../../middleware/auth.js';
import { requireAdmin } from '../../../middleware/admin.js';
import { requireFlag } from '../../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../../platform/http.js';
import type { FeatureRouterDeps } from '../../index.js';
import {
  AdminCampusEventsQuerySchema,
  CampusCompanyParamsSchema,
  CampusEventDraftBodySchema,
  CampusEventParamsSchema,
  CampusSubscriptionParamsSchema,
  CreateCampusSubscriptionBodySchema,
  ExtractCampusEventBodySchema,
  ListCampusEventsQuerySchema,
  PatchCampusEventBodySchema,
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

export function createCampusEventsRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];
  const on = requireFlag('jobs.campusCalendar', { env: deps.env });

  router.get('/', ...maybeAuth, on, stub('campus.list', { query: ListCampusEventsQuerySchema }));
  router.get('/subscriptions', ...auth, on, stub('campus.listSubscriptions'));
  router.post('/subscriptions', ...auth, on, stub('campus.subscribe', { body: CreateCampusSubscriptionBodySchema }));
  router.delete('/subscriptions/:id', ...auth, on, stub('campus.unsubscribe', { params: CampusSubscriptionParamsSchema }));
  router.get('/:id', ...maybeAuth, on, stub('campus.get', { params: CampusEventParamsSchema }));

  return router;
}

export function createCampusPublicRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const on = requireFlag('jobs.campusCalendar', { env: deps.env });
  router.get('/', on, stub('campus.public.list', { query: ListCampusEventsQuerySchema }));
  router.get('/companies/:slug', on, stub('campus.public.company', { params: CampusCompanyParamsSchema }));
  return router;
}

export function createCampusAdminRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const p = { params: CampusEventParamsSchema };

  router.get('/events', ...admin, stub('campus.admin.list', { query: AdminCampusEventsQuerySchema }));
  router.post('/events/extract', ...admin, stub('campus.admin.extract', { body: ExtractCampusEventBodySchema }));
  router.post('/events', ...admin, stub('campus.admin.create', { body: CampusEventDraftBodySchema }));
  router.patch('/events/:id', ...admin, stub('campus.admin.update', { ...p, body: PatchCampusEventBodySchema }));
  router.post('/events/:id/verify', ...admin, stub('campus.admin.verify', p));
  router.post('/events/:id/publish', ...admin, stub('campus.admin.publish', p));
  router.delete('/events/:id', ...admin, stub('campus.admin.delete', p));

  return router;
}
