// server/src/features/coaching/adminRoutes.ts — roster management (WP-72).
// Mounted by features/index.ts at /api/v1/roboapply/admin/coaching (admin only).
// Staff list real coaches who agreed to be listed, for either site.
//
//   GET    /coaches?brand&active     every roster row (incl. the private request address)
//   POST   /coaches                  add a coach (listing needs a booking link or a request email)
//   PATCH  /coaches/:id              edit; `null` clears an optional field
//   DELETE /coaches/:id              remove from the roster

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { AdminCoachesQuerySchema, CoachBodySchema, CoachParamsSchema, PatchCoachBodySchema } from './contract.js';
import type { CoachingService } from './service.js';

export interface CoachingAdminRouterOptions {
  /** Test seam; defaults to the process-wide service. */
  service?: CoachingService;
}

export function createCoachingAdminRouter(deps: FeatureRouterDeps = {}, options: CoachingAdminRouterOptions = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const svc = async (): Promise<CoachingService> => options.service ?? (await import('./service.js')).getCoachingService();

  router.get(
    '/coaches',
    ...admin,
    route(async (req) => {
      const query = parseQuery(req, AdminCoachesQuerySchema);
      return (await svc()).adminList(query);
    }),
  );

  router.post(
    '/coaches',
    ...admin,
    route(
      async (req) => {
        const adminId = requireUserId(req);
        const body = parseBody(req, CoachBodySchema);
        return (await svc()).adminCreate(adminId, body);
      },
      { status: 201 },
    ),
  );

  router.patch(
    '/coaches/:id',
    ...admin,
    route(async (req) => {
      const adminId = requireUserId(req);
      const { id } = parseParams(req, CoachParamsSchema);
      const body = parseBody(req, PatchCoachBodySchema);
      return (await svc()).adminUpdate(adminId, id, body);
    }),
  );

  router.delete(
    '/coaches/:id',
    ...admin,
    route(async (req) => {
      const adminId = requireUserId(req);
      const { id } = parseParams(req, CoachParamsSchema);
      await (await svc()).adminDelete(adminId, id);
      return { deleted: true };
    }),
  );

  return router;
}
