// server/src/features/announcements/routes.ts — STUB (FND-5). Owner: WP-61.
// Mounted by features/index.ts at /api/v1/roboapply/announcements (seeker; no flag).
// The admin router lives in adminRoutes.ts.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { AnnouncementParamsSchema } from './contract.js';

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

export function createAnnouncementsRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];

  router.get('/next', ...auth, stub('announcements.next'));
  router.post('/:id/seen', ...auth, stub('announcements.seen', { params: AnnouncementParamsSchema }));

  return router;
}
