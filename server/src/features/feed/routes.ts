// server/src/features/feed/routes.ts — /api/v1/roboapply/feed (WP-32; ARCH §3.4).
//
// Every route: seeker session → `jobs.feed` capability (GoApply R-14 recruitment-
// info mode; off → 404 feature_disabled) → limits → handler.
//
//   POST /query                 60/min; a refresh (no cursor) also 20 per 10 min
//   GET  /counts
//   POST /jobs/:id/hide         → { proposedFilterDiff, editor }
//   POST /jobs/:id/unhide       → 204
//   POST /jobs/:id/report       → 204 · 20/day
//   POST /impressions           → 204 (beacon)
//   POST /rating                → 204 (one a day)
//   GET  /explore?locale        cached 10 min
//   POST /nl-query              AI: aiAllowed (503 ai_unavailable), GoApply phone binding
//   GET  /new-count?since&markVisited
//   GET  /skills-check

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { requireFlag } from '../../platform/flags.js';
import { parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import { DAY, MINUTE, rateLimit, type RateWindow } from '../../platform/ratelimit/index.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  ExploreQuerySchema,
  FeedQueryBodySchema,
  FeedRatingBodySchema,
  HideJobBodySchema,
  ImpressionsBodySchema,
  JobParamsSchema,
  NewCountQuerySchema,
  NlQueryBodySchema,
  ReportJobBodySchema,
} from './contract.js';
import type { FeedQueryService } from './FeedQueryService.js';
import type { FeedCtx } from './types.js';

export interface FeedRouterDeps extends FeatureRouterDeps {
  service?: FeedQueryService;
  /** Rate-limit middleware factory (tests pass a pass-through). */
  limiter?: (name: string, windows: RateWindow[]) => RequestHandler;
  /** GoApply AI gate: 403 phone_binding_required for WeChat accounts without a phone. */
  phoneGate?: RequestHandler;
}

const defaultLimiter = (name: string, windows: RateWindow[]): RequestHandler => rateLimit({ name, windows, by: 'user' });

let lazyPhoneGate: RequestHandler | null = null;
/** `requirePhoneBound()` from auth-cn, loaded on first use (RoboApply users pass straight through). */
const defaultPhoneGate: RequestHandler = async (req, res, next) => {
  if (getCurrentBrandOrDefault().market !== 'cn') return next();
  if (!lazyPhoneGate) lazyPhoneGate = (await import('../auth-cn/index.js')).requirePhoneBound();
  return lazyPhoneGate(req, res, next);
};

let lazyService: FeedQueryService | null = null;
async function defaultService(): Promise<FeedQueryService> {
  if (!lazyService) lazyService = (await import('./defaultService.js')).defaultFeedQueryService;
  return lazyService;
}

function noContent(res: Response): void {
  res.status(204).end();
}

function localeOf(req: Request, market: string): string {
  const q = typeof req.query.locale === 'string' ? req.query.locale : null;
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.robo_locale;
  return q || cookie || (market === 'cn' ? 'zh' : 'en');
}

export function createFeedRouter(deps: FeedRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const feed = requireFlag('jobs.feed', { env: deps.env });
  const limiter = deps.limiter ?? defaultLimiter;
  const phoneGate = deps.phoneGate ?? defaultPhoneGate;
  const svc = async () => deps.service ?? (await defaultService());

  async function ctxOf(req: Request): Promise<{ ctx: FeedCtx; service: FeedQueryService }> {
    const service = await svc();
    const brand = getCurrentBrandOrDefault();
    return { service, ctx: { userId: requireUserId(req), market: brand.market, brandId: brand.id, now: service.now() } };
  }

  router.post(
    '/query',
    ...auth,
    feed,
    limiter('feedQuery', [{ limit: 60, windowSec: MINUTE }]),
    route(async (req) => {
      const body = parseBody(req, FeedQueryBodySchema);
      const { ctx, service } = await ctxOf(req);
      return service.query(ctx, body);
    }),
  );

  router.get(
    '/counts',
    ...auth,
    feed,
    route(async (req) => {
      const { ctx, service } = await ctxOf(req);
      return service.counts(ctx);
    }),
  );

  router.post(
    '/jobs/:id/hide',
    ...auth,
    feed,
    route(async (req) => {
      const { id } = parseParams(req, JobParamsSchema);
      const body = parseBody(req, HideJobBodySchema);
      const { ctx, service } = await ctxOf(req);
      return service.hide(ctx, id, body);
    }),
  );

  router.post(
    '/jobs/:id/unhide',
    ...auth,
    feed,
    route(async (req, res) => {
      const { id } = parseParams(req, JobParamsSchema);
      const { ctx, service } = await ctxOf(req);
      await service.unhide(ctx, id);
      noContent(res);
    }),
  );

  router.post(
    '/jobs/:id/report',
    ...auth,
    feed,
    limiter('feedReport', [{ limit: 20, windowSec: DAY }]),
    route(async (req, res) => {
      const { id } = parseParams(req, JobParamsSchema);
      const body = parseBody(req, ReportJobBodySchema);
      const { ctx, service } = await ctxOf(req);
      await service.report(ctx, id, body);
      noContent(res);
    }),
  );

  router.post(
    '/impressions',
    ...auth,
    feed,
    route(async (req, res) => {
      const body = parseBody(req, ImpressionsBodySchema);
      const { ctx, service } = await ctxOf(req);
      await service.impressions(ctx, body);
      noContent(res);
    }),
  );

  router.post(
    '/rating',
    ...auth,
    feed,
    route(async (req, res) => {
      const body = parseBody(req, FeedRatingBodySchema);
      const { ctx, service } = await ctxOf(req);
      await service.rating(ctx, body);
      noContent(res);
    }),
  );

  router.get(
    '/explore',
    ...auth,
    feed,
    route(async (req) => {
      parseQuery(req, ExploreQuerySchema);
      const { ctx, service } = await ctxOf(req);
      return service.explore(ctx, localeOf(req, ctx.market));
    }),
  );

  router.post(
    '/nl-query',
    ...auth,
    feed,
    phoneGate,
    limiter('feedNlQuery', [{ limit: 10, windowSec: MINUTE }]),
    route(async (req) => {
      const body = parseBody(req, NlQueryBodySchema);
      const { ctx, service } = await ctxOf(req);
      return service.nlQuery(ctx, body, localeOf(req, ctx.market));
    }),
  );

  router.get(
    '/new-count',
    ...auth,
    feed,
    route(async (req) => {
      const q = parseQuery(req, NewCountQuerySchema);
      const { ctx, service } = await ctxOf(req);
      return service.newCount(ctx, { since: q.since, markVisited: q.markVisited === 'true' });
    }),
  );

  router.get(
    '/skills-check',
    ...auth,
    feed,
    route(async (req) => {
      const { ctx, service } = await ctxOf(req);
      return service.skillsCheck(ctx);
    }),
  );

  return router;
}
