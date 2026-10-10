// server/src/features/feed/publicRoutes.ts — the visitor job list (WP-78; F-FEED-16).
//
// GET /api/v1/public/feed?role&city&country → `VisitorFeedResponse`:
//   - capability `jobs.feed` (GoApply: off unless the recruitment-info mode
//     allows it, R-14) → 404 feature_disabled;
//   - 60 requests a minute per IP (DB counter, `publicFeedPerIp`) → 429;
//   - at most 20 items, NO fit (there is no profile), `publicDisplay` jobs only;
//   - every item is re-checked against the public-page predicate of ARCH §9.4
//     (seo `basePublicWhere`: not expired, no fraud flag, a provider still in
//     PUBLIC_DISPLAY_PROVIDERS or a consenting recruiter bank) when the list is
//     built, so removing a provider takes effect within the cache window below;
//   - each item carries its public job page (`/job/<id>-<slug>`), or null
//     where the brand has no public job pages (GoApply);
//   - cached 15 minutes per brand × query in process (behind the capability
//     check, so switching `jobs.feed` off is immediate there). At the CDN:
//     15 minutes on RoboApply; 60 seconds on market `cn`, so a GoApply
//     recruitment-info mode switched to `off` stops reaching visitors within
//     about a minute (CN_FEED_CDN_CACHE_SEC).
// Feed internals are reached only through feed/index.ts (`feedService.publicList`).

import { Router, type Request, type RequestHandler } from 'express';
import prisma from '../../lib/prisma.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { requireFlag } from '../../platform/flags.js';
import { parseQuery, route } from '../../platform/http.js';
import { rateLimit, type RateLimitDb } from '../../platform/ratelimit/index.js';
import { MINUTE } from '../../platform/ratelimit/defaults.js';
import type { FeatureRouterDeps } from '../index.js';
import { allowedPublicBoards, basePublicWhere, jobPath } from '../seo/index.js';
import type { VisitorFeedItem, VisitorFeedResponse } from '../visitor/contract.js';
import { PublicFeedQuerySchema, type PublicFeedItem } from './contract.js';

/** Mirrors visitor/contract.ts VISITOR_FEED_LIMIT (kept local: a value import would tie the two areas' module graphs). */
export const PUBLIC_FEED_LIMIT = 20;
export const PUBLIC_FEED_CACHE_MS = 15 * 60 * 1000;
/** How many rows to read before the public-page re-check drops some. */
const OVERFETCH = 50;
const CACHE_MAX_ENTRIES = 500;
/** CDN cache on market `cn`: short, so a legal mode switch is not outlived by cached postings. */
export const CN_FEED_CDN_CACHE_SEC = 60;
export const PUBLIC_FEED_RATE_LIMIT = { name: 'publicFeedPerIp', windows: [{ limit: 60, windowSec: MINUTE }] } as const;

export type PublicFeedQuery = { role?: string; city?: string; country?: string };

export interface PublicFeedDeps {
  /** `feedService.publicList` (default: lazy import of feed/index.ts). */
  publicList?: (input: PublicFeedQuery & { limit: number }) => Promise<PublicFeedItem[]>;
  /** The ids among `ids` that pass the public-page predicate now. */
  stillPublic?: (ids: string[], brand: ProductBrand, now: Date) => Promise<Set<string>>;
  now?: () => Date;
  /** DB for the per-IP limiter (tests pass a fake). */
  rateDb?: RateLimitDb;
  /** Replace the limiter (tests). */
  rateLimiter?: RequestHandler;
}

type RAJobIdDb = Pick<typeof prisma, 'rAJob'>;

/** The ids that a public page may show right now (ARCH §9.4, the seo predicate). */
export function prismaStillPublic(db: RAJobIdDb = prisma) {
  return async (ids: string[], brand: ProductBrand, now: Date): Promise<Set<string>> => {
    if (!ids.length) return new Set();
    const base = basePublicWhere({ market: brand.market, now, publicBoards: allowedPublicBoards() });
    const rows = await db.rAJob.findMany({ where: { ...base, id: { in: ids } }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  };
}

const defaultPublicList: NonNullable<PublicFeedDeps['publicList']> = async (input) => {
  const { feedService } = await import('./index.js');
  return feedService.publicList(input);
};

/** The public page of a job, or null where the brand has none (GoApply defers public job pages). */
export function publicPathFor(item: Pick<PublicFeedItem, 'jobId' | 'title' | 'company'>, brand: ProductBrand): string | null {
  if (brand.market === 'cn') return null;
  return jobPath(item.jobId, item.title, item.company.name);
}

function cacheKey(brand: ProductBrand, q: PublicFeedQuery): string {
  const norm = (s?: string) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return [brand.id, norm(q.role), norm(q.city), (q.country ?? '').toUpperCase()].join('|');
}

export interface PublicFeedService {
  list(query: PublicFeedQuery, brand: ProductBrand): Promise<VisitorFeedResponse>;
  /** Tests. */
  clearCache(): void;
}

export function createPublicFeedService(deps: PublicFeedDeps = {}): PublicFeedService {
  const publicList = deps.publicList ?? defaultPublicList;
  const stillPublic = deps.stillPublic ?? prismaStillPublic();
  const now = deps.now ?? (() => new Date());
  const cache = new Map<string, { at: number; value: VisitorFeedResponse }>();

  return {
    async list(query, brand) {
      const key = cacheKey(brand, query);
      const at = now();
      const hit = cache.get(key);
      if (hit && at.getTime() - hit.at < PUBLIC_FEED_CACHE_MS) return hit.value;

      const rows = await publicList({ ...query, limit: OVERFETCH });
      const allowed = await stillPublic(
        rows.map((r) => r.jobId),
        brand,
        at,
      );
      const items: VisitorFeedItem[] = [];
      for (const row of rows) {
        if (!allowed.has(row.jobId)) continue;
        // Never a fit or a tracker state on a visitor list, whatever the row carries.
        const { fit: _fit, tracker: _tracker, position: _position, ...rest } = row as PublicFeedItem & { fit?: unknown; tracker?: unknown };
        items.push({ ...rest, position: null, path: publicPathFor(row, brand) });
        if (items.length >= PUBLIC_FEED_LIMIT) break;
      }
      const value: VisitorFeedResponse = { items, asOf: at.toISOString() };
      if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: at.getTime(), value });
      return value;
    },
    clearCache() {
      cache.clear();
    },
  };
}

let defaultService: PublicFeedService | null = null;

function brandOf(req: Request): ProductBrand {
  return (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();
}

export function createPublicFeedRouter(deps: FeatureRouterDeps & { publicFeed?: PublicFeedDeps } = {}): Router {
  const router = Router();
  const service = deps.publicFeed ? createPublicFeedService(deps.publicFeed) : (defaultService ??= createPublicFeedService());
  const limiter =
    deps.publicFeed?.rateLimiter ??
    rateLimit({ name: PUBLIC_FEED_RATE_LIMIT.name, windows: PUBLIC_FEED_RATE_LIMIT.windows, by: 'ip', db: deps.publicFeed?.rateDb });

  router.get(
    '/',
    requireFlag('jobs.feed', { env: deps.env }),
    limiter,
    route(async (req, res) => {
      const query = parseQuery(req, PublicFeedQuerySchema);
      const brand = brandOf(req);
      const data = await service.list(query, brand);
      res.setHeader(
        'Cache-Control',
        brand.market === 'cn'
          ? `public, max-age=0, s-maxage=${CN_FEED_CDN_CACHE_SEC}`
          : `public, max-age=60, s-maxage=${PUBLIC_FEED_CACHE_MS / 1000}, stale-while-revalidate=60`,
      );
      res.setHeader('Vary', 'Host, X-Forwarded-Host');
      return data;
    }),
  );
  return router;
}
