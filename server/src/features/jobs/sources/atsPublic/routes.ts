// server/src/features/jobs/sources/atsPublic/routes.ts — admin career sources
// (WP-42; MARKET_STRATEGY JI-3, JC-4).
// Mounted by features/index.ts at /api/v1/roboapply/admin/career-sources (admin only).
//
//   GET    /            list (?market, ?enabled, ?origin, ?state)
//   POST   /            add a company job board
//   POST   /import      add many boards from a CSV or JSON list
//   PATCH  /:id         rename / re-tag / change countries / turn on or off
//   DELETE /:id         remove (its open jobs are archived; the removal is remembered)
//   POST   /:id/run     read the board's listing now and mark it due
//
// Both brands, one list. A board is one source shared by both sites, so an
// admin on either host can list, add, change, check and remove any board. The
// request's brand decides the default of the list (the boards that feed that
// brand's market) and who "Check now" says is asking (that brand's own
// User-Agent: a GoApply admin's check never names RoboApply).

import { Router, type Request } from 'express';
import { requireAuth } from '../../../../middleware/auth.js';
import { requireAdmin } from '../../../../middleware/admin.js';
import { getCurrentBrandOrDefault, type Market } from '../../../../platform/brand/index.js';
import { parseBody, parseParams, parseQuery, route } from '../../../../platform/http.js';
import type { FeatureRouterDeps } from '../../../index.js';
import { CareerSourceBodySchema, CareerSourceParamsSchema, ImportCareerSourcesBodySchema, ListCareerSourcesQuerySchema, PatchCareerSourceBodySchema } from './contract.js';
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
  router.post('/import', ...admin, route(async (req) => svc().importMany(parseBody(req, ImportCareerSourcesBodySchema), adminId(req), market())));
  router.patch('/:id', ...admin, route(async (req) => svc().update(parseParams(req, CareerSourceParamsSchema).id, parseBody(req, PatchCareerSourceBodySchema))));
  router.delete('/:id', ...admin, route(async (req) => svc().remove(parseParams(req, CareerSourceParamsSchema).id, adminId(req))));
  router.post('/:id/run', ...admin, route(async (req) => svc().runNow(parseParams(req, CareerSourceParamsSchema).id, market())));

  return router;
}
