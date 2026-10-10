// server/src/features/notifications/routes.ts — message center, settings and public unsubscribe (WP-39b).
//
// Mounted by features/index.ts:
//   createNotificationsRouter()  at /api/v1/roboapply/notifications (seeker)
//     GET    /                    ?cursor&limit → NotificationsResponse (newest first)
//     GET    /unread-count        → { count }   (the bell polls it every 60 s while visible;
//                                    the first call also stores the edge country for the tips default)
//     POST   /read-all            → { updated }
//     GET    /preferences         → NotificationPreferencesView
//     PATCH  /preferences         body NotificationPreferencesPatch → NotificationPreferencesView
//     POST   /:id/read            → null
//     POST   /:id/respond         body { interested, form? } → NotificationView   (flag `invitations`)
//   createEmailPublicRouter()    at /api/v1/public/email (no login)
//     GET    /unsubscribe?token=  → UnsubscribePreview (JSON), or 303 to /unsubscribe/<token> for a browser
//     POST   /unsubscribe?token=  → UnsubscribeResponse (RFC 8058 one-click; form or JSON body)
//     POST   /unsubscribe/survey  body { token, reason, note? } → null (20/h per IP)

import express, { Router, type Request, type RequestHandler } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { HOUR, rateLimit } from '../../platform/ratelimit/index.js';
import { HttpError, parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  ListNotificationsQuerySchema,
  NotificationParamsSchema,
  PatchNotificationPreferencesBodySchema,
  RespondInvitationBodySchema,
  UnsubscribeBodySchema,
  UnsubscribeQuerySchema,
  UnsubscribeSurveyBodySchema,
} from './contract.js';
import { NotificationCenterService, type ProfileRef } from './service.js';
import { UnsubscribeService } from './unsubscribe.js';

export interface NotificationsRouterDeps extends FeatureRouterDeps {
  service?: NotificationCenterService;
  unsubscribe?: UnsubscribeService;
  /** Rate-limit guard for the survey (tests pass a no-op). */
  surveyLimiter?: RequestHandler;
}

const COUNTRY_HEADERS = ['x-vercel-ip-country', 'cf-ipcountry'] as const;

function requestCountry(req: Request): string | null {
  for (const name of COUNTRY_HEADERS) {
    const v = req.get(name);
    if (v && /^[a-z]{2}$/i.test(v.trim())) return v.trim().toUpperCase();
  }
  return null;
}

function brandOf(req: Request): ProductBrand {
  return (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();
}

async function profileOf(req: Request, service: NotificationCenterService): Promise<ProfileRef> {
  const userId = requireUserId(req);
  const attached = req.seekerProfile;
  if (attached?.id) return { id: attached.id, userId };
  const profile = await service.profileFor(userId);
  if (!profile) throw new HttpError('forbidden', 'No seeker profile for this account.');
  return profile;
}

function localeOf(req: Request): string | null {
  const v = req.get('x-ra-locale') ?? req.cookies?.NEXT_LOCALE;
  return typeof v === 'string' && v ? v : null;
}

let defaultService: NotificationCenterService | null = null;
function serviceFrom(deps: NotificationsRouterDeps): NotificationCenterService {
  if (deps.service) return deps.service;
  if (deps.env) return new NotificationCenterService({ env: deps.env });
  defaultService ??= new NotificationCenterService();
  return defaultService;
}

export function createNotificationsRouter(deps: NotificationsRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const service = serviceFrom(deps);

  router.get(
    '/',
    ...auth,
    route(async (req) => {
      const query = parseQuery(req, ListNotificationsQuerySchema);
      return service.list(await profileOf(req, service), brandOf(req), query);
    }),
  );

  router.get(
    '/unread-count',
    ...auth,
    route(async (req) => {
      const profile = await profileOf(req, service);
      // The first poll stores the edge country, so the "Tips and reminders"
      // default applies before the person ever opens Settings (once per process).
      await service.rememberRegionOnce(profile, requestCountry(req));
      return { count: await service.unreadCountForProfile(profile.id, brandOf(req), profile.userId) };
    }),
  );

  router.post(
    '/read-all',
    ...auth,
    route(async (req) => service.markAllRead(await profileOf(req, service), brandOf(req))),
  );

  router.get(
    '/preferences',
    ...auth,
    route(async (req) => {
      const profile = await profileOf(req, service);
      return service.getPreferences({ ...profile, brand: brandOf(req), requestCountry: requestCountry(req), locale: localeOf(req) });
    }),
  );

  router.patch(
    '/preferences',
    ...auth,
    route(async (req) => {
      const patch = parseBody(req, PatchNotificationPreferencesBodySchema);
      const profile = await profileOf(req, service);
      return service.patchPreferences({ ...profile, brand: brandOf(req), requestCountry: requestCountry(req), locale: localeOf(req) }, patch);
    }),
  );

  router.post(
    '/:id/read',
    ...auth,
    route(async (req) => {
      const { id } = parseParams(req, NotificationParamsSchema);
      await service.markRead(await profileOf(req, service), brandOf(req), id);
      return null;
    }),
  );

  router.post(
    '/:id/respond',
    ...auth,
    requireFlag('invitations', { env: deps.env }),
    route(async (req) => {
      const { id } = parseParams(req, NotificationParamsSchema);
      const body = parseBody(req, RespondInvitationBodySchema);
      return service.respond(await profileOf(req, service), brandOf(req), id, body);
    }),
  );

  return router;
}

export function createEmailPublicRouter(deps: NotificationsRouterDeps = {}): Router {
  const router = Router();
  const center = serviceFrom(deps);
  const unsubscribe = deps.unsubscribe ?? new UnsubscribeService({ db: center.db, center, env: deps.env });
  const surveyLimiter = deps.surveyLimiter ?? rateLimit({ name: 'unsubscribeSurveyPerIp', windows: [{ limit: 20, windowSec: HOUR }], by: 'ip' });

  // RFC 8058 one-click POSTs are `application/x-www-form-urlencoded`.
  router.use(express.urlencoded({ extended: false, limit: '4kb' }));

  router.get(
    '/unsubscribe',
    route(async (req, res) => {
      const { token } = parseQuery(req, UnsubscribeQuerySchema);
      // A person who opened the header URL in a browser gets the page, which asks before changing anything.
      if (req.accepts(['json', 'html']) === 'html') {
        res.redirect(303, `/unsubscribe/${encodeURIComponent(token)}`);
        return undefined;
      }
      return unsubscribe.preview(token, brandOf(req));
    }),
  );

  router.post(
    '/unsubscribe',
    route(async (req) => {
      const { token } = parseQuery(req, UnsubscribeQuerySchema);
      parseBody(req, UnsubscribeBodySchema);
      return unsubscribe.unsubscribe(token, brandOf(req));
    }),
  );

  router.post(
    '/unsubscribe/survey',
    surveyLimiter,
    route(async (req) => {
      const body = parseBody(req, UnsubscribeSurveyBodySchema);
      await unsubscribe.survey(body, brandOf(req));
      return null;
    }),
  );

  return router;
}
