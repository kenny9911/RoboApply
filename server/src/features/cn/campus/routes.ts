// server/src/features/cn/campus/routes.ts — GoApply 校招日历 routes (WP-58).
//
// Mounted by features/index.ts:
//   createCampusEventsRouter()  at /api/v1/roboapply/cn/campus-events (S/P; `jobs.campusCalendar`)
//     GET    /                    programmes (class, company, role, city, openNow, cursor) + `subscribed`
//     GET    /subscriptions       my deadline reminders and followed companies
//     POST   /subscriptions       {kind:'event', eventId} | {kind:'company', companyName, graduationClass}
//     DELETE /subscriptions/:id
//     GET    /:id                 one programme
//   createCampusPublicRouter()  at /api/v1/public/campus (`jobs.campusCalendar`; CDN-cacheable)
//     GET    /                    same list, no personal fields (SEO pages, GoApply home preview)
//     GET    /companies/:slug     one company's programmes
//   createCampusAdminRouter()   at /api/v1/roboapply/admin/cn/campus (admin; not gated, so
//                               staff can prepare entries before the capability turns on)
//     GET    /events              ?status=draft|published|archived
//     POST   /events/extract      {officialUrl} → proposal (writes nothing)
//     POST   /events              save a draft (never published here)
//     PATCH  /events/:id          edit (a changed fact clears the verification)
//     POST   /events/:id/verify   "checked against the official page"
//     POST   /events/:id/publish  409 campus_event_not_verified unless verified
//     DELETE /events/:id          drafts removed, published entries archived

import { Router, type Request, type Response } from 'express';
import { seekerAuth } from '../../../roboapply/engine/middleware/seekerAuth.js';
import { optionalAuth, requireAuth } from '../../../middleware/auth.js';
import { requireAdmin } from '../../../middleware/admin.js';
import { requireFlag } from '../../../platform/flags.js';
import { getCurrentBrandOrDefault, getBrand, type ProductBrand } from '../../../platform/brand/index.js';
import { parseBody, parseParams, parseQuery, requireUserId, route } from '../../../platform/http.js';
import type { FeatureRouterDeps } from '../../index.js';
import {
  AdminCampusEventsQuerySchema,
  CampusCompanyParamsSchema,
  CampusEventDraftBodySchema,
  CampusEventParamsSchema,
  CampusSubscriptionParamsSchema,
  CreateCampusSubscriptionBodySchema,
  ExtractCampusEventBodySchema,
  ListCampusEventsQuerySchema,
  PatchCampusEventBodySchema,
} from './contract.js';
import {
  adminCreate,
  adminDelete,
  adminExtract,
  adminList,
  adminPublish,
  adminUpdate,
  adminVerify,
  companyEvents,
  defaultCampusDeps,
  filterOf,
  getEvent,
  listEvents,
  listSubscriptions,
  subscribe,
  unsubscribe,
  type CampusServiceDeps,
} from './service.js';
import { notifyFollowers } from './notify.js';

export interface CampusRouterDeps extends FeatureRouterDeps {
  /** Test seam (default: Prisma, the CN LLM and a plain single-page fetch). */
  service?: CampusServiceDeps;
}

/** CDN cache of the public reads (per host: the brand is in the URL's host). */
export const CAMPUS_PUBLIC_CACHE = 'public, s-maxage=300, stale-while-revalidate=3600';

/** The admin console curates the mainland calendar whatever host it is opened on. */
const CURATED_MARKET = getBrand('goapply').market;

const brandOf = (req: Request): ProductBrand => (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();
const userIdOf = (req: Request): string | null => {
  const id = (req as Request & { user?: { id?: unknown } }).user?.id;
  return typeof id === 'string' && id ? id : null;
};
const requestIdOf = (req: Request): string | undefined => (req as Request & { requestId?: string }).requestId;

function lazyDeps(deps: CampusRouterDeps): () => CampusServiceDeps {
  let svc: CampusServiceDeps | null = deps.service ?? null;
  return () =>
    (svc ??= defaultCampusDeps({
      ...(deps.env ? { env: deps.env } : {}),
      onPublished: (event) => notifyFollowers(event, 'goapply'),
    }));
}

export function createCampusEventsRouter(deps: CampusRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];
  const on = requireFlag('jobs.campusCalendar', { env: deps.env });
  const svc = lazyDeps(deps);

  router.get(
    '/',
    ...maybeAuth,
    on,
    route(async (req) => {
      const q = parseQuery(req, ListCampusEventsQuerySchema);
      return listEvents(svc(), brandOf(req).market, filterOf(q), q.cursor, userIdOf(req));
    }),
  );
  router.get(
    '/subscriptions',
    ...auth,
    on,
    route(async (req) => listSubscriptions(svc(), brandOf(req).market, requireUserId(req))),
  );
  router.post(
    '/subscriptions',
    ...auth,
    on,
    route(
      async (req) => {
        const body = parseBody(req, CreateCampusSubscriptionBodySchema);
        return subscribe(svc(), brandOf(req).market, requireUserId(req), body);
      },
      { status: 201 },
    ),
  );
  router.delete(
    '/subscriptions/:id',
    ...auth,
    on,
    route(async (req) => unsubscribe(svc(), requireUserId(req), parseParams(req, CampusSubscriptionParamsSchema).id)),
  );
  router.get(
    '/:id',
    ...maybeAuth,
    on,
    route(async (req) => getEvent(svc(), brandOf(req).market, parseParams(req, CampusEventParamsSchema).id, userIdOf(req))),
  );

  return router;
}

function cacheable(res: Response): void {
  res.setHeader('Cache-Control', CAMPUS_PUBLIC_CACHE);
  res.setHeader('Vary', 'Host, X-Forwarded-Host');
}

export function createCampusPublicRouter(deps: CampusRouterDeps = {}): Router {
  const router = Router();
  const on = requireFlag('jobs.campusCalendar', { env: deps.env });
  const svc = lazyDeps(deps);

  router.get(
    '/',
    on,
    route(async (req, res) => {
      const q = parseQuery(req, ListCampusEventsQuerySchema);
      const list = await listEvents(svc(), brandOf(req).market, filterOf(q), q.cursor, null);
      cacheable(res);
      return list;
    }),
  );
  router.get(
    '/companies/:slug',
    on,
    route(async (req, res) => {
      const { slug } = parseParams(req, CampusCompanyParamsSchema);
      const out = await companyEvents(svc(), brandOf(req).market, slug);
      cacheable(res);
      return out;
    }),
  );
  return router;
}

export function createCampusAdminRouter(deps: CampusRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const svc = lazyDeps(deps);

  router.get(
    '/events',
    ...admin,
    route(async (req) => {
      const { status, cursor } = parseQuery(req, AdminCampusEventsQuerySchema);
      return adminList(svc(), CURATED_MARKET, status, cursor);
    }),
  );
  router.post(
    '/events/extract',
    ...admin,
    route(async (req) => {
      const { officialUrl } = parseBody(req, ExtractCampusEventBodySchema);
      return adminExtract(svc(), officialUrl, requestIdOf(req));
    }),
  );
  router.post(
    '/events',
    ...admin,
    route(async (req) => adminCreate(svc(), CURATED_MARKET, requireUserId(req), parseBody(req, CampusEventDraftBodySchema)), { status: 201 }),
  );
  router.patch(
    '/events/:id',
    ...admin,
    route(async (req) => {
      const { id } = parseParams(req, CampusEventParamsSchema);
      return adminUpdate(svc(), CURATED_MARKET, id, parseBody(req, PatchCampusEventBodySchema));
    }),
  );
  router.post(
    '/events/:id/verify',
    ...admin,
    route(async (req) => adminVerify(svc(), CURATED_MARKET, parseParams(req, CampusEventParamsSchema).id, requireUserId(req))),
  );
  router.post(
    '/events/:id/publish',
    ...admin,
    route(async (req) => adminPublish(svc(), CURATED_MARKET, parseParams(req, CampusEventParamsSchema).id)),
  );
  router.delete(
    '/events/:id',
    ...admin,
    route(async (req) => adminDelete(svc(), CURATED_MARKET, parseParams(req, CampusEventParamsSchema).id)),
  );

  return router;
}
