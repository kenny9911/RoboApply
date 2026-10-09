// server/src/features/growth/routes.ts — STUB (FND-5). Owners: WP-23 (events), WP-60 (invites).
//
// Mounted by features/index.ts at /api/v1/roboapply/invites (seeker;
// capability `invites` per route, separate from GoApply's `cn.referralCodes`).
// The public events router lives in publicRoutes.ts.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { InviteEmailBodySchema } from './contract.js';

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

export function createInvitesRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('invites', { env: deps.env });

  router.get('/', ...auth, on, stub('invites.get'));
  router.post('/email', ...auth, on, stub('invites.email', { body: InviteEmailBodySchema }));

  return router;
}
