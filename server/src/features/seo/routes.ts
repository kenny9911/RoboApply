// server/src/features/seo/routes.ts — public SEO reads (WP-56).
// Mounted by features/index.ts at /api/v1/public/seo (public; no session).
//
//   GET /page?path&country   browse page data      flag `seo.browse`
//   GET /hub                 indexable browse pages flag `seo.browse`
//   GET /jobs/:id            public job page data   404 unknown / not public, 410 closed
//   GET /ticker              newest public jobs
//   GET /sitemap             sitemap partitions
//   GET /sitemap/:part       one partition (`roles-<n>`, `jobs-<n>`)
//
// Both brands run under the same gates (D5; plan §3.11): the `seo.browse`
// flag, PUBLIC_DISPLAY_PROVIDERS and `isPubliclyListable` (scope.ts). Each
// brand reads only its own market's rows. GoApply keeps one off switch:
// `CN_RECRUITMENT_INFO_MODE=off` shows no posting anywhere, so the page, hub
// and job routes answer 404 feature_disabled and the ticker and sitemaps
// answer empty (`publicListingsOpen` in service.ts).
//
// Every response carries Cache-Control (success: SEO_CACHE_CONTROL /
// SEO_SITEMAP_CACHE_CONTROL; 404 short; 410 longer; everything else
// no-store). Reads are rate limited per visitor IP in the database
// (F-TRUST-02; `seoPublicPerIp`, 120/min). The Next server renders the
// public pages and fetches this API from one IP, so for its requests
// (x-ra-internal = INTERNAL_API_SECRET) the limit is keyed on the visitor IP
// it forwards in x-ra-client-ip; that header is ignored without the secret.
// An internal request without a visitor IP (sitemaps, the cron) is not
// counted. A brand echo that disagrees with the host answers 404 no-store,
// so a crafted request cannot plant a cached miss under the web's CDN key.

import { timingSafeEqual } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { getCurrentBrandOrDefault, parseBrandId, type EnvSource, type ProductBrand } from '../../platform/brand/index.js';
import { requireFlag } from '../../platform/flags.js';
import { HttpError, httpError, parseParams, parseQuery, route } from '../../platform/http.js';
import { clientIp, consumeRateLimit, rateLimitKey, rateLimitWindows, type ConsumeOptions, type RateLimitResult } from '../../platform/ratelimit/index.js';
import { requireCnRecruitmentInfo } from '../cn/jobs/index.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  SEO_CACHE_CONTROL,
  SEO_GONE_CACHE_CONTROL,
  SEO_MISSING_CACHE_CONTROL,
  SEO_NO_STORE,
  SEO_SITEMAP_CACHE_CONTROL,
  SeoBrandQuerySchema,
  SeoJobParamsSchema,
  SeoPageQuerySchema,
  SitemapPartParamsSchema,
} from './contract.js';
import { SeoGoneError, defaultSeoService, type SeoService } from './service.js';

export const SEO_RATE_LIMIT_NAME = 'seoPublicPerIp';
const INTERNAL_HEADER = 'x-ra-internal';
/** The visitor IP the Next server forwards (trusted only with a valid x-ra-internal). */
export const CLIENT_IP_HEADER = 'x-ra-client-ip';
const IP_SHAPE = /^[0-9A-Fa-f:.]{2,64}$/;

export interface SeoRouterDeps extends FeatureRouterDeps {
  service?: SeoService;
  /** Per-request abuse guard (tests pass a no-op or a fake); throws HttpError('rate_limited'). */
  limit?: (req: Request) => Promise<void>;
}

/** True when the request carries the Next server's shared secret. */
export function isInternalRequest(req: Request, env: EnvSource = process.env): boolean {
  const secret = env.INTERNAL_API_SECRET;
  const sent = req.headers[INTERNAL_HEADER];
  const value = Array.isArray(sent) ? sent[0] : sent;
  if (!secret || !value) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(value);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The visitor IP a trusted internal request forwards, or null (absent / malformed). */
export function forwardedClientIp(req: Request): string | null {
  const sent = req.headers[CLIENT_IP_HEADER];
  const value = (Array.isArray(sent) ? sent[0] : sent)?.trim();
  return value && IP_SHAPE.test(value) ? value : null;
}

/** The IP a request is counted against, or null when it is not counted (the Next server without a visitor IP). */
export function seoLimitIp(req: Request, env: EnvSource = process.env): string | null {
  if (isInternalRequest(req, env)) return forwardedClientIp(req);
  return clientIp(req);
}

export interface SeoRateLimiterDeps {
  /** The persisted counter (default: platform consumeRateLimit). */
  consume?: (options: ConsumeOptions) => Promise<RateLimitResult>;
}

/**
 * The default guard: DB-backed fixed window per visitor IP. Fails open on a
 * database error (a public read must not go down with the counter table).
 */
export function seoRateLimiter(env: EnvSource = process.env, deps: SeoRateLimiterDeps = {}): (req: Request) => Promise<void> {
  const consume = deps.consume ?? consumeRateLimit;
  return async (req) => {
    const ip = seoLimitIp(req, env);
    if (!ip) return;
    let result: RateLimitResult;
    try {
      result = await consume({ key: rateLimitKey(SEO_RATE_LIMIT_NAME, 'ip', ip), windows: rateLimitWindows(SEO_RATE_LIMIT_NAME, env) });
    } catch {
      return;
    }
    if (!result.allowed) throw httpError('rate_limited', undefined, { retryAfterSec: result.retryAfterSec });
  };
}

function brandOf(req: Request): ProductBrand {
  return (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();
}

/**
 * The web adds `?brand=<id>` so shared preview hosts keep the brands in
 * separate CDN entries. A value that disagrees with the resolved brand is
 * refused (never cached under the wrong key).
 */
class BrandEchoMismatch extends HttpError {
  constructor() {
    super('not_found');
  }
}

function assertBrandEcho(req: Request, brand: ProductBrand): void {
  const { brand: echo } = parseQuery(req, SeoBrandQuerySchema);
  if (echo !== undefined && parseBrandId(echo) !== brand.id) throw new BrandEchoMismatch();
}

/** Success → `cacheControl`; 404 → short public (a brand-echo mismatch stays no-store); 410 → longer public; anything else → no-store. */
function seoRoute<T>(cacheControl: string, handler: (req: Request, res: Response) => Promise<T>): RequestHandler {
  return route(async (req, res) => {
    try {
      const data = await handler(req, res);
      res.setHeader('Cache-Control', cacheControl);
      return data;
    } catch (err) {
      if (err instanceof SeoGoneError) {
        res.setHeader('Cache-Control', SEO_GONE_CACHE_CONTROL);
        res.status(410).json({ success: false, code: 'gone', error: err.message });
        return undefined as T;
      }
      if (err instanceof HttpError && err.code === 'not_found' && !(err instanceof BrandEchoMismatch)) res.setHeader('Cache-Control', SEO_MISSING_CACHE_CONTROL);
      throw err;
    }
  });
}

export function createSeoPublicRouter(deps: SeoRouterDeps = {}): Router {
  const router = Router();
  const env = deps.env ?? process.env;
  const service = () => deps.service ?? defaultSeoService();
  const limit = deps.limit ?? seoRateLimiter(env);

  // Every answer starts as no-store; handlers widen it on success.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', SEO_NO_STORE);
    next();
  });

  // GoApply with the recruitment-info mode off: no posting on any public route.
  const postingsOn = requireCnRecruitmentInfo({ env });

  router.get(
    '/page',
    postingsOn,
    requireFlag('seo.browse', { env }),
    seoRoute(SEO_CACHE_CONTROL, async (req) => {
      const query = parseQuery(req, SeoPageQuerySchema);
      const brand = brandOf(req);
      assertBrandEcho(req, brand);
      await limit(req);
      return service().page(brand, query);
    }),
  );

  router.get(
    '/hub',
    postingsOn,
    requireFlag('seo.browse', { env }),
    seoRoute(SEO_CACHE_CONTROL, async (req) => {
      const brand = brandOf(req);
      assertBrandEcho(req, brand);
      await limit(req);
      return service().hub(brand);
    }),
  );

  router.get(
    '/jobs/:id',
    postingsOn,
    seoRoute(SEO_CACHE_CONTROL, async (req) => {
      const { id } = parseParams(req, SeoJobParamsSchema);
      const brand = brandOf(req);
      assertBrandEcho(req, brand);
      await limit(req);
      return { job: await service().job(brand, id) };
    }),
  );

  router.get(
    '/ticker',
    seoRoute(SEO_CACHE_CONTROL, async (req) => {
      const brand = brandOf(req);
      assertBrandEcho(req, brand);
      await limit(req);
      return service().ticker(brand);
    }),
  );

  router.get(
    '/sitemap',
    seoRoute(SEO_SITEMAP_CACHE_CONTROL, async (req) => {
      const brand = brandOf(req);
      assertBrandEcho(req, brand);
      await limit(req);
      return service().sitemapIndex(brand);
    }),
  );

  router.get(
    '/sitemap/:part',
    seoRoute(SEO_SITEMAP_CACHE_CONTROL, async (req) => {
      const { part } = parseParams(req, SitemapPartParamsSchema);
      const brand = brandOf(req);
      assertBrandEcho(req, brand);
      await limit(req);
      return service().sitemapPart(brand, part);
    }),
  );

  return router;
}
