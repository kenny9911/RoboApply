// server/src/features/search/routes.ts — search profiles and the role taxonomy (WP-20).
//
// Mounted by features/index.ts:
//   createSearchProfilesRouter() at /api/v1/roboapply/search-profiles (seeker)
//   createTaxonomyRouter()       at /api/v1/roboapply/taxonomy        (S/P; /skills is seeker)
//
//   GET    /search-profiles              → SearchProfileListWire (first call migrates legacy prefs)
//   POST   /search-profiles              → 201 SearchProfileWire (cap = `saved_searches` entitlement)
//   POST   /search-profiles/count        → FeedCountResult ({count:null} until the feed counts, WP-32) · 30/min
//   PATCH  /search-profiles/:id          → SearchProfileWire, or 409 version_conflict { currentVersion, profile }
//   DELETE /search-profiles/:id          → null (never the last one, never the default)
//   POST   /search-profiles/:id/activate → SearchProfileWire
//   GET    /search-profiles/:id/limiting → LimitingFiltersResponse ({available:false} until WP-32) · 10/min
//   GET    /taxonomy?locale&q            → TaxonomyResponse (cached)
//   GET    /taxonomy/skills?q            → SkillSuggestionsResponse (market-scoped) · 60/min
//
// No capability flag: filters exist on every plan and brand (the
// recruiter-jobs filter included, F-FEED-04). Errors are platform codes with
// `details.reason` (contract SEARCH_ERROR_CODES).

import { Router, type Request, type RequestHandler } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { optionalAuth } from '../../middleware/auth.js';
import { NotImplementedError, parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/index.js';
import type { Market } from '../../platform/brand/registry.js';
import { MINUTE, rateLimit } from '../../platform/ratelimit/index.js';
import { logger } from '../../services/LoggerService.js';
import type { FeatureRouterDeps } from '../index.js';
import { feedService as defaultFeed, type FeedService } from '../feed/index.js';
import {
  TAXONOMY_AS_OF,
  TAXONOMY_NODES,
  TAXONOMY_SOURCES,
  TAXONOMY_VERSION,
  searchTaxonomy,
  taxonomyLabel,
} from '../jobs/taxonomy/index.js';
import {
  CountFiltersBodySchema,
  CreateSearchProfileBodySchema,
  SearchProfileParamsSchema,
  SkillsQuerySchema,
  TaxonomyQuerySchema,
  UpdateSearchProfileBodySchema,
  baseVersionOf,
  type LimitingFiltersResponse,
  type SkillSuggestionsResponse,
  type TaxonomyResponse,
} from './contract.js';
import { parseFilterSet } from './filterSet.js';
import { InvalidFiltersError, searchErrorToHttpError, searchProfileService, type SearchProfileService } from './SearchProfileService.js';
import { skillSuggestService, type SkillSuggestService } from './skills.js';

// Re-exported for callers that imported the route-only schemas from here (FND-5).
export { CountFiltersBodySchema, SearchProfileParamsSchema, SkillsQuerySchema, TaxonomyQuerySchema };

export interface SearchRouterDeps extends FeatureRouterDeps {
  service?: SearchProfileService;
  feed?: Pick<FeedService, 'countForFilters' | 'limitingFilters'>;
  skills?: SkillSuggestService;
  /** Rate-limit middleware factory (tests pass a no-op). */
  limiter?: (name: string, perMinute: number) => RequestHandler;
}

const defaultLimiter = (name: string, perMinute: number): RequestHandler =>
  rateLimit({ name, windows: [{ limit: perMinute, windowSec: MINUTE }] });

/** Run a search-service call, mapping its domain errors to platform HttpErrors. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw searchErrorToHttpError(err) ?? err;
  }
}

function requestMarket(): Market {
  return getCurrentBrandOrDefault().market;
}

export function createSearchProfilesRouter(deps: SearchRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const service = deps.service ?? searchProfileService;
  const feed = deps.feed ?? defaultFeed;
  const limiter = deps.limiter ?? defaultLimiter;

  router.get(
    '/',
    ...auth,
    route(async (req) => guarded(() => service.list(requireUserId(req)))),
  );

  router.post(
    '/',
    ...auth,
    route(
      async (req) => {
        const userId = requireUserId(req);
        const body = parseBody(req, CreateSearchProfileBodySchema);
        return guarded(() => service.create(userId, body));
      },
      { status: 201 },
    ),
  );

  router.post(
    '/count',
    ...auth,
    limiter('searchProfileCount', 30),
    route(async (req) => {
      const userId = requireUserId(req);
      const body = parseBody(req, CountFiltersBodySchema);
      const parsed = parseFilterSet(body.filters, { market: requestMarket() });
      if (!parsed.ok) throw searchErrorToHttpError(new InvalidFiltersError(parsed.issues));
      try {
        return await feed.countForFilters(userId, parsed.value);
      } catch (err) {
        // The feed seam answers once WP-32 lands; until then the drawer shows "Show jobs" with no number (D3).
        if (err instanceof NotImplementedError) return { count: null, capped: false };
        throw err;
      }
    }),
  );

  router.patch(
    '/:id',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, SearchProfileParamsSchema);
      const body = parseBody(req, UpdateSearchProfileBodySchema);
      return guarded(() =>
        service.update(userId, id, {
          version: baseVersionOf(body),
          name: body.name,
          filters: body.filters,
          filtersPatch: body.filtersPatch,
          alertInstantMax: body.alertInstantMax,
          alertDigest: body.alertDigest,
          makeDefault: body.makeDefault === true,
        }),
      );
    }),
  );

  router.delete(
    '/:id',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, SearchProfileParamsSchema);
      await guarded(() => service.remove(userId, id));
      return null;
    }),
  );

  router.post(
    '/:id/activate',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, SearchProfileParamsSchema);
      return guarded(() => service.activate(userId, id));
    }),
  );

  router.get(
    '/:id/limiting',
    ...auth,
    limiter('searchProfileLimiting', 10),
    route(async (req): Promise<LimitingFiltersResponse> => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, SearchProfileParamsSchema);
      await guarded(() => service.get(userId, id)); // 404 for someone else's profile
      try {
        return { items: await feed.limitingFilters(userId, id), available: true };
      } catch (err) {
        if (err instanceof NotImplementedError) return { items: [], available: false };
        throw err;
      }
    }),
  );

  return router;
}

// ── Taxonomy ──────────────────────────────────────────────────────────────

/** Labels: zh → Simplified; every other locale English until INT translates (zh-TW never shows Simplified). */
function labelLocale(raw: string | undefined): string {
  return raw === 'zh' ? 'zh' : 'en';
}

/** GET /taxonomy body (pure; exported for tests). */
export function taxonomyResponse(query: { locale?: string; q?: string }): TaxonomyResponse {
  const locale = labelLocale(query.locale);
  const q = query.q?.trim() ?? '';
  return {
    version: TAXONOMY_VERSION,
    asOf: TAXONOMY_AS_OF,
    locale,
    nodes: q
      ? []
      : TAXONOMY_NODES.map((n) => ({ id: n.id, level: n.level, parent: n.parent, label: taxonomyLabel(n.id, locale) ?? n.en })),
    suggestions: q ? searchTaxonomy(q, { locale, limit: 10 }).map(({ id, level, label, context }) => ({ id, level, label, context })) : [],
    sources: TAXONOMY_SOURCES.map((s) => ({ name: s.name, url: s.url, license: s.license })),
  };
}

function localeOf(req: Request, query: { locale?: string }): string | undefined {
  return query.locale ?? req.get('x-robo-locale') ?? undefined;
}

export function createTaxonomyRouter(deps: SearchRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];
  const skills = deps.skills ?? skillSuggestService;
  const limiter = deps.limiter ?? defaultLimiter;

  router.get(
    '/',
    ...maybeAuth,
    route(async (req, res) => {
      const query = parseQuery(req, TaxonomyQuerySchema);
      // Static per version: the tree is cacheable; typeahead answers are short-lived.
      res.setHeader('Cache-Control', query.q ? 'private, max-age=60' : 'public, max-age=3600');
      return taxonomyResponse({ q: query.q, locale: localeOf(req, query) });
    }),
  );

  router.get(
    '/skills',
    ...auth,
    // Each lookup scans the market's keyword JSON (skills.ts): cap the cost per user.
    limiter('taxonomySkills', 60),
    route(async (req): Promise<SkillSuggestionsResponse> => {
      const query = parseQuery(req, SkillsQuerySchema);
      const market = requestMarket();
      try {
        return { items: await skills.suggest(query.q, market) };
      } catch (err) {
        // A failed aggregate must not block typing a skill: the client still offers the typed text.
        logger.warn('SEARCH_SKILLS', 'skill suggestions failed', {
          market,
          brand: getCurrentBrandOrDefault().id,
          error: err instanceof Error ? err.message : String(err),
        });
        return { items: [] };
      }
    }),
  );

  return router;
}
