// server/src/features/feed/routes.ts — STUB (FND-5). Owner: WP-32.
// Mounted by features/index.ts at /api/v1/roboapply/feed. Every route checks
// `jobs.feed` (GoApply: R-14 recruitment-info mode) after the seeker session.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  FeedQueryBodySchema,
  FeedRatingBodySchema,
  HideJobBodySchema,
  ImpressionsBodySchema,
  JobParamsSchema,
  NewCountQuerySchema,
  NlQueryBodySchema,
  ReportJobBodySchema,
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

export function createFeedRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const feed = requireFlag('jobs.feed', { env: deps.env });

  router.post('/query', ...auth, feed, stub('feed.query', { body: FeedQueryBodySchema }));
  router.get('/counts', ...auth, feed, stub('feed.counts'));
  router.post('/jobs/:id/hide', ...auth, feed, stub('feed.hide', { params: JobParamsSchema, body: HideJobBodySchema }));
  router.post('/jobs/:id/unhide', ...auth, feed, stub('feed.unhide', { params: JobParamsSchema }));
  router.post('/jobs/:id/report', ...auth, feed, stub('feed.report', { params: JobParamsSchema, body: ReportJobBodySchema }));
  router.post('/impressions', ...auth, feed, stub('feed.impressions', { body: ImpressionsBodySchema }));
  router.post('/rating', ...auth, feed, stub('feed.rating', { body: FeedRatingBodySchema }));
  router.get('/explore', ...auth, feed, stub('feed.explore'));
  router.post('/nl-query', ...auth, feed, stub('feed.nlQuery', { body: NlQueryBodySchema }));
  router.get('/new-count', ...auth, feed, stub('feed.newCount', { query: NewCountQuerySchema }));
  router.get('/skills-check', ...auth, feed, stub('feed.skillsCheck'));

  return router;
}
