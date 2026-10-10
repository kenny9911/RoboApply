// server/src/features/cn/jobs/routes.ts — GoApply jobs routes (WP-41).
//
// Mounted by features/index.ts:
//   createCnJobsRouter()       at /api/v1/roboapply/cn/jobs (seeker)
//     GET  /external-links?q&city   BOSS直聘 / 智联 / 猎聘 search links for the
//                                   user's own query (GoApply only; every mode:
//                                   links are not postings)
//   createCnJobsAdminRouter()  at /api/v1/roboapply/admin/cn/jobs (admin)
//     GET    /fraud?status&cursor    可疑职位待审核 (flagged | cleared | confirmed)
//     POST   /fraud/:jobId/resolve   clear | confirm (+ blacklistEmployer)
//     GET    /blacklist              employer block list
//     POST   /blacklist              add (409 when already listed)
//     DELETE /blacklist/:id          remove (and unflag that employer's open jobs)
// The admin routes serve any deployment that serves GoApply data; RoboApply
// requests to the seeker route answer 404 feature_disabled.

import { Router, type Request } from 'express';
import { seekerAuth } from '../../../roboapply/engine/middleware/seekerAuth.js';
import { requireAuth } from '../../../middleware/auth.js';
import { requireAdmin } from '../../../middleware/admin.js';
import { getCurrentBrandOrDefault, type ProductBrand } from '../../../platform/brand/index.js';
import { HttpError, parseBody, parseParams, parseQuery, requireUserId, route } from '../../../platform/http.js';
import type { FeatureRouterDeps } from '../../index.js';
import {
  BlacklistEntryBodySchema,
  BlacklistParamsSchema,
  ExternalLinksQuerySchema,
  FraudJobParamsSchema,
  FraudQueueQuerySchema,
  ResolveFraudBodySchema,
  type BlacklistListResponse,
} from './contract.js';
import { buildExternalSearchLinks } from './deeplinks.js';
import { addToBlacklist, defaultCnJobsDeps, listBlacklist, listFraudQueue, removeFromBlacklist, resolveFraud, type CnJobsDeps } from './service.js';

export interface CnJobsRouterDeps extends FeatureRouterDeps {
  /** Test seam (default: Prisma + AppConfig + LLMService). */
  service?: CnJobsDeps;
}

const brandOf = (req: Request): ProductBrand => (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();

export function createCnJobsRouter(deps: CnJobsRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];

  router.get(
    '/external-links',
    ...auth,
    route(async (req) => {
      if (brandOf(req).market !== 'cn') throw new HttpError('feature_disabled');
      const { q, city } = parseQuery(req, ExternalLinksQuerySchema);
      return buildExternalSearchLinks(q, city);
    }),
  );
  return router;
}

export function createCnJobsAdminRouter(deps: CnJobsRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  let lazy: CnJobsDeps | null = deps.service ?? null;
  const svc = (): CnJobsDeps => (lazy ??= defaultCnJobsDeps());

  router.get(
    '/fraud',
    ...admin,
    route(async (req) => {
      const { status, cursor } = parseQuery(req, FraudQueueQuerySchema);
      return listFraudQueue(svc(), status ?? 'flagged', cursor);
    }),
  );

  router.post(
    '/fraud/:jobId/resolve',
    ...admin,
    route(async (req) => {
      const { jobId } = parseParams(req, FraudJobParamsSchema);
      const body = parseBody(req, ResolveFraudBodySchema);
      return resolveFraud(svc(), jobId, body, requireUserId(req));
    }),
  );

  router.get(
    '/blacklist',
    ...admin,
    route(async (): Promise<BlacklistListResponse> => ({ items: await listBlacklist(svc()) })),
  );

  router.post(
    '/blacklist',
    ...admin,
    route(
      async (req) => {
        const body = parseBody(req, BlacklistEntryBodySchema);
        return addToBlacklist(svc(), body, requireUserId(req));
      },
      { status: 201 },
    ),
  );

  router.delete(
    '/blacklist/:id',
    ...admin,
    route(async (req) => {
      const { id } = parseParams(req, BlacklistParamsSchema);
      await removeFromBlacklist(svc(), id);
      return null;
    }),
  );

  return router;
}
