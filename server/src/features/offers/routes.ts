// server/src/features/offers/routes.ts — STUB (FND-5). Owner: WP-64.
// Mounted by features/index.ts at /api/v1/roboapply/offers. Capability `offers` per route.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { CompareOffersBodySchema, OfferEntryParamsSchema, PutOfferBodySchema } from './contract.js';

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

export function createOffersRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('offers', { env: deps.env });
  const p = { params: OfferEntryParamsSchema };

  router.get('/', ...auth, on, stub('offers.list'));
  router.post('/compare', ...auth, on, stub('offers.compare', { body: CompareOffersBodySchema }));
  router.put('/:trackerEntryId', ...auth, on, stub('offers.put', { ...p, body: PutOfferBodySchema }));
  router.delete('/:trackerEntryId', ...auth, on, stub('offers.delete', p));
  router.post('/:trackerEntryId/negotiation-draft', ...auth, on, stub('offers.negotiationDraft', p));

  return router;
}
