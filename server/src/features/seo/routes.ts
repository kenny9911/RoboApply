// server/src/features/seo/routes.ts — STUB (FND-5). Owner: WP-56.
// Mounted by features/index.ts at /api/v1/public/seo (public; no flag).

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { SeoJobParamsSchema, SeoPageQuerySchema, SitemapPartParamsSchema } from './contract.js';

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

export function createSeoPublicRouter(_deps: FeatureRouterDeps = {}): Router {
  const router = Router();

  router.get('/page', stub('seo.page', { query: SeoPageQuerySchema }));
  router.get('/jobs/:id', stub('seo.job', { params: SeoJobParamsSchema }));
  router.get('/sitemap/:part', stub('seo.sitemap', { params: SitemapPartParamsSchema }));

  return router;
}
