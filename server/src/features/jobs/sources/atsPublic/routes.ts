// server/src/features/jobs/sources/atsPublic/routes.ts — admin career sources (WP-42).
// Mounted by features/index.ts at /api/v1/roboapply/admin/career-sources (admin only).
//
//   GET    /            list (?market, ?enabled)
//   POST   /            add a company job board
//   PATCH  /:id         rename / re-tag / turn on or off
//   DELETE /:id         remove (its open jobs are archived)
//   POST   /:id/run     read the board now
//
// The boards feed the international site only, so on a GoApply host every
// route answers 404 feature_disabled.

import { Router, type Request, type RequestHandler } from 'express';
import { requireAuth } from '../../../../middleware/auth.js';
import { requireAdmin } from '../../../../middleware/admin.js';
import { getCurrentBrandOrDefault } from '../../../../platform/brand/index.js';
import { fail, parseBody, parseParams, parseQuery, route } from '../../../../platform/http.js';
import type { FeatureRouterDeps } from '../../../index.js';
import { CareerSourceBodySchema, CareerSourceParamsSchema, ListCareerSourcesQuerySchema, PatchCareerSourceBodySchema } from './contract.js';
import { careerSourcesService, type CareerSourcesService } from './service.js';

export interface CareerSourcesRouterDeps extends FeatureRouterDeps {
  service?: () => CareerSourcesService;
}

/** 404 feature_disabled outside the international site. */
const intlOnly: RequestHandler = (_req, res, next) => {
  if (getCurrentBrandOrDefault().market !== 'intl') {
    fail(res, 'feature_disabled');
    return;
  }
  next();
};

function adminId(req: Request): string | null {
  const user = (req as Request & { user?: { id?: unknown } }).user;
  return typeof user?.id === 'string' ? user.id : null;
}

export function createCareerSourcesAdminRouter(deps: CareerSourcesRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const svc = () => (deps.service ?? careerSourcesService)();
  const gate = intlOnly;

  router.get('/', ...admin, gate, route(async (req) => svc().list(parseQuery(req, ListCareerSourcesQuerySchema))));
  router.post('/', ...admin, gate, route(async (req) => svc().create(parseBody(req, CareerSourceBodySchema), adminId(req)), { status: 201 }));
  router.patch('/:id', ...admin, gate, route(async (req) => svc().update(parseParams(req, CareerSourceParamsSchema).id, parseBody(req, PatchCareerSourceBodySchema))));
  router.delete('/:id', ...admin, gate, route(async (req) => svc().remove(parseParams(req, CareerSourceParamsSchema).id)));
  router.post('/:id/run', ...admin, gate, route(async (req) => svc().runNow(parseParams(req, CareerSourceParamsSchema).id)));

  return router;
}
