// server/src/features/jobs/sources/atsPublic/routes.ts — admin career sources (WP-42).
// Mounted by features/index.ts at /api/v1/roboapply/admin/career-sources (admin only).
//
//   GET    /            list (?market, ?enabled)
//   POST   /            add a company job board
//   PATCH  /:id         rename / re-tag / turn on or off
//   DELETE /:id         remove (its open jobs are archived)
//   POST   /:id/run     read the board now
//
// Both brands: an admin lists, adds, changes and checks the boards of the
// brand whose host they are on (the request brand's market). A board of the
// other brand is never listed and answers 404 by id.

import { Router, type Request } from 'express';
import { requireAuth } from '../../../../middleware/auth.js';
import { requireAdmin } from '../../../../middleware/admin.js';
import { getCurrentBrandOrDefault, type Market } from '../../../../platform/brand/index.js';
import { parseBody, parseParams, parseQuery, route } from '../../../../platform/http.js';
import type { FeatureRouterDeps } from '../../../index.js';
import { CareerSourceBodySchema, CareerSourceParamsSchema, ListCareerSourcesQuerySchema, PatchCareerSourceBodySchema } from './contract.js';
import { careerSourcesService, type CareerSourcesService } from './service.js';

export interface CareerSourcesRouterDeps extends FeatureRouterDeps {
  service?: () => CareerSourcesService;
}

/** The market of the brand this request is for. */
const market = (): Market => getCurrentBrandOrDefault().market;

function adminId(req: Request): string | null {
  const user = (req as Request & { user?: { id?: unknown } }).user;
  return typeof user?.id === 'string' ? user.id : null;
}

export function createCareerSourcesAdminRouter(deps: CareerSourcesRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const svc = () => (deps.service ?? careerSourcesService)();

  router.get('/', ...admin, route(async (req) => svc().list(parseQuery(req, ListCareerSourcesQuerySchema), market())));
  router.post('/', ...admin, route(async (req) => svc().create(parseBody(req, CareerSourceBodySchema), adminId(req), market()), { status: 201 }));
  router.patch('/:id', ...admin, route(async (req) => svc().update(parseParams(req, CareerSourceParamsSchema).id, parseBody(req, PatchCareerSourceBodySchema), market())));
  router.delete('/:id', ...admin, route(async (req) => svc().remove(parseParams(req, CareerSourceParamsSchema).id, market())));
  router.post('/:id/run', ...admin, route(async (req) => svc().runNow(parseParams(req, CareerSourceParamsSchema).id, market())));

  return router;
}
