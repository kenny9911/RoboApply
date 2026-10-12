// server/src/features/announcements/adminRoutes.ts — announcements admin (WP-61).
// Mounted by features/index.ts at /api/v1/roboapply/admin/announcements (admin only).
//
//   GET    /?brand=&active=   → { items: AdminAnnouncementView[] }
//   POST   /                  body UpsertAnnouncement → 201 AdminAnnouncementView
//   PATCH  /:id               body PatchAnnouncement  → AdminAnnouncementView
//   DELETE /:id               → null
//
// Publishing (`active: true`) needs content in every locale the brand serves
// (422, reason `translations_missing`, `details.missing`).

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { AdminAnnouncementsQuerySchema, AnnouncementParamsSchema, PatchAnnouncementBodySchema, UpsertAnnouncementBodySchema } from './contract.js';
import { AnnouncementsService, announcementsService } from './service.js';

export interface AnnouncementsAdminRouterDeps extends FeatureRouterDeps {
  service?: AnnouncementsService;
}

export function createAnnouncementsAdminRouter(deps: AnnouncementsAdminRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const service = () => deps.service ?? announcementsService();

  router.get('/', ...admin, route(async (req) => service().adminList(parseQuery(req, AdminAnnouncementsQuerySchema))));

  router.post('/', ...admin, route(async (req) => service().adminCreate(parseBody(req, UpsertAnnouncementBodySchema)), { status: 201 }));

  router.patch(
    '/:id',
    ...admin,
    route(async (req) => {
      const { id } = parseParams(req, AnnouncementParamsSchema);
      return service().adminUpdate(id, parseBody(req, PatchAnnouncementBodySchema));
    }),
  );

  router.delete(
    '/:id',
    ...admin,
    route(async (req) => {
      const { id } = parseParams(req, AnnouncementParamsSchema);
      await service().adminDelete(id);
      return null;
    }),
  );

  return router;
}
