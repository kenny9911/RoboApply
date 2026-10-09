// server/src/features/growth/routes.ts — seeker routers of the growth area.
//
//   createGrowthRouter (WP-23) — getting-started checklist:
//     GET  /checklist          → ChecklistView
//     POST /checklist/dismiss  → ChecklistView (the card stays hidden)
//     Read and dismiss only: steps complete solely through
//     `markChecklistStep()` on the server (WP-34, WP-36a, WP-43). Mount
//     requested from INT at /api/v1/roboapply/growth (not in FEATURE_MOUNTS
//     yet, which features/index.ts owns). Answers 404 feature_disabled while
//     the checklist table (SR-23-1) is not available.
//
//   createInvitesRouter — STUB routes for invite friends (owner WP-60).
//     Mounted by features/index.ts at /api/v1/roboapply/invites (seeker;
//     capability `invites` per route, separate from GoApply's `cn.referralCodes`).
//
// The public events router lives in publicRoutes.ts.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { InviteEmailBodySchema } from './contract.js';
import { growthServiceImpl, type GrowthService } from './service.js';

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

export interface GrowthRouterDeps extends FeatureRouterDeps {
  service?: Pick<GrowthService, 'getChecklist' | 'dismissChecklist'>;
}

export function createGrowthRouter(deps: GrowthRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const service = deps.service ?? growthServiceImpl;

  router.get('/checklist', ...auth, route(async (req) => service.getChecklist(requireUserId(req))));
  router.post('/checklist/dismiss', ...auth, route(async (req) => service.dismissChecklist(requireUserId(req))));

  return router;
}

export function createInvitesRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('invites', { env: deps.env });

  router.get('/', ...auth, on, stub('invites.get'));
  router.post('/email', ...auth, on, stub('invites.email', { body: InviteEmailBodySchema }));

  return router;
}
