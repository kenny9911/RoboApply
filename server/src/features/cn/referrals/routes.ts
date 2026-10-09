// server/src/features/cn/referrals/routes.ts — STUB (FND-5). Owner: WP-54.
// Mounted by features/index.ts at /api/v1/roboapply/cn/referrals. Capability `cn.referralCodes` per route.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../../platform/http.js';
import type { FeatureRouterDeps } from '../../index.js';
import {
  CreateReferralCodeBodySchema,
  ListReferralCodesQuerySchema,
  ReferralCodeParamsSchema,
  ReportReferralCodeBodySchema,
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

export function createCnReferralsRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('cn.referralCodes', { env: deps.env });

  router.get('/', ...auth, on, stub('cnReferrals.list', { query: ListReferralCodesQuerySchema }));
  router.post('/', ...auth, on, stub('cnReferrals.create', { body: CreateReferralCodeBodySchema }));
  router.post('/:id/report', ...auth, on, stub('cnReferrals.report', { params: ReferralCodeParamsSchema, body: ReportReferralCodeBodySchema }));
  router.delete('/:id', ...auth, on, stub('cnReferrals.delete', { params: ReferralCodeParamsSchema }));

  return router;
}
