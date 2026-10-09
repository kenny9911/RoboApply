// server/src/features/tracker/routes.ts — STUB (FND-5). Owner: WP-38.
//
// Mounted by features/index.ts at /api/v1/roboapply/v2/tracker AFTER the
// legacy V2 router. Only new paths are declared here.
//
// KNOWN SHADOW (WP-38 request): the legacy tracker router declares
// `GET /:id`, so `GET /follow-ups` and `GET /export.csv` reach the legacy
// handler first (it answers 404 not_found for those ids) until WP-38, which
// owns roboapply/v2/routes/tracker.ts, declares them before `/:id` there or
// lets non-cuid ids fall through with `next()`. `/:id/events` and
// `/:id/artifacts` have two segments and are not shadowed.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { AddTrackerNoteBodySchema, TrackerEntryParamsSchema } from './contract.js';

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

export function createTrackerRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const p = { params: TrackerEntryParamsSchema };

  router.get('/follow-ups', ...auth, stub('tracker.followUps'));
  router.get('/export.csv', ...auth, stub('tracker.exportCsv'));
  router.get('/:id/events', ...auth, stub('tracker.events', p));
  router.post('/:id/events', ...auth, stub('tracker.addNote', { ...p, body: AddTrackerNoteBodySchema }));
  router.get('/:id/artifacts', ...auth, stub('tracker.artifacts', p));

  return router;
}
