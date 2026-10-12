// server/src/features/announcements/routes.ts — "What's new" for seekers (WP-61).
// Mounted by features/index.ts at /api/v1/roboapply/announcements (seeker; no flag).
// The admin router lives in adminRoutes.ts.
//
//   GET  /next?locale=   → { announcement: AnnouncementView | null }  (at most one; null while
//                          the 24 h popup budget is spent, or when nothing is left to show)
//   POST /:id/seen       → null  (shown once; the first time also writes an inbox row)

import { Router, type Request } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { AnnouncementParamsSchema, NextAnnouncementQuerySchema } from './contract.js';
import { AnnouncementsService, announcementsService } from './service.js';

export interface AnnouncementsRouterDeps extends FeatureRouterDeps {
  service?: AnnouncementsService;
}

/**
 * The UI language: `?locale=`, else the `X-Robo-Locale` header the web client
 * sends (lib/api/client.ts), else the `robo_locale` cookie. The older
 * `x-ra-locale` / `NEXT_LOCALE` names are read last; nothing sends them today.
 */
export function requestLocale(req: Request, fromQuery?: string): string | null {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  for (const v of [fromQuery, req.get('x-robo-locale'), cookies?.robo_locale, req.get('x-ra-locale'), cookies?.NEXT_LOCALE]) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function createAnnouncementsRouter(deps: AnnouncementsRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const service = () => deps.service ?? announcementsService();

  router.get(
    '/next',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { locale } = parseQuery(req, NextAnnouncementQuerySchema);
      return service().next(userId, getCurrentBrandOrDefault(), requestLocale(req, locale));
    }),
  );

  router.post(
    '/:id/seen',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, AnnouncementParamsSchema);
      const { locale } = parseQuery(req, NextAnnouncementQuerySchema);
      await service().markSeen(userId, getCurrentBrandOrDefault(), id, requestLocale(req, locale));
      return null;
    }),
  );

  return router;
}
