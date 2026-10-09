// server/src/features/search/routes.ts — STUB (FND-5). Owner: WP-20.
//
// Mounted by features/index.ts:
//   createSearchProfilesRouter() at /api/v1/roboapply/search-profiles (seeker)
//   createTaxonomyRouter()       at /api/v1/roboapply/taxonomy        (S/P; /skills is seeker)
// WP-20 fills them over FND-4's `searchProfileService` (errors through
// `searchErrorToHttp`), FND-4's taxonomy (`searchTaxonomy`, `taxonomyLabel`)
// and, for /count and /:id/limiting, the feed seam (`feed.countForFilters`,
// `feed.limitingFilters`; `{count:null}` until WP-32).
//
// The route-only query/param schemas below belong in contract.ts (FND-4's
// file); WP-20 may move them there.

import { Router, type RequestHandler } from 'express';
import { z, type ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { optionalAuth } from '../../middleware/auth.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { CreateSearchProfileBodySchema, UpdateSearchProfileBodySchema } from './contract.js';

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

export const SearchProfileParamsSchema = z.object({ id: z.string().min(1).max(64) });
/** POST /search-profiles/count → `{ count: number | null, capped: boolean }` (count capped at 5,000). */
export const CountFiltersBodySchema = z.object({ filters: z.unknown() }).strict();
/** GET /taxonomy?locale&q */
export const TaxonomyQuerySchema = z.object({ locale: z.string().max(8).optional(), q: z.string().trim().max(80).optional() });
/** GET /taxonomy/skills?q= (≥2 chars; market-scoped; custom entry allowed by the client). */
export const SkillsQuerySchema = z.object({ q: z.string().trim().min(2).max(60), locale: z.string().max(8).optional() });

export function createSearchProfilesRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];

  router.get('/', ...auth, stub('search.list'));
  router.post('/', ...auth, stub('search.create', { body: CreateSearchProfileBodySchema }));
  router.post('/count', ...auth, stub('search.count', { body: CountFiltersBodySchema }));
  router.patch('/:id', ...auth, stub('search.update', { params: SearchProfileParamsSchema, body: UpdateSearchProfileBodySchema }));
  router.delete('/:id', ...auth, stub('search.remove', { params: SearchProfileParamsSchema }));
  router.post('/:id/activate', ...auth, stub('search.activate', { params: SearchProfileParamsSchema }));
  router.get('/:id/limiting', ...auth, stub('search.limiting', { params: SearchProfileParamsSchema }));

  return router;
}

export function createTaxonomyRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];

  router.get('/', ...maybeAuth, stub('taxonomy.tree', { query: TaxonomyQuerySchema }));
  router.get('/skills', ...auth, stub('taxonomy.skills', { query: SkillsQuerySchema }));

  return router;
}
