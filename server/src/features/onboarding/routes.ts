// server/src/features/onboarding/routes.ts — the onboarding API (WP-30; ARCHITECTURE.md §3.3 with R-06).
//
// Mounted by features/index.ts at /api/v1/roboapply/onboarding. Seeker session
// required on every route; no flag (onboarding exists on both brands).
// GoApply step bodies are validated by features/onboarding-cn (WP-31) through
// its index.ts seam; until WP-31 fills it those steps answer 501.
//
//   GET  /state                       → OnboardingStateView
//   PUT  /steps/:step                 step body (+ skip) → StepResponse (idempotent upsert)
//   GET  /title-suggest?q             → { items: TitleSuggestionView[] } · 60/min per user
//   GET  /market-snapshot?taxonomyId&country[&city] → MarketSnapshotResponse (Sourced; 6 h cache)
//   POST /resume  { resumeVariantId } → OnboardingResumeResponse · 10/day per user (409 once setup is finished)
//   POST /match                       → SSE: phase × 5 (each after its work), then done | error
//                                       only at matching/confirm/tour (409 otherwise) · 5/hour per user
//   POST /confirm                     ConfirmStep → OnboardingStageResponse
//   POST /complete                    → OnboardingStageResponse (tour → done)
//   POST /skip                        → OnboardingStageResponse (leave early; finish banner)
//
// The legacy /v2/onboarding/* router keeps working until WP-75 removes it.

import { Router, type Request } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { HttpError, mapError, parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import { getCurrentBrandOrDefault, type BrandedRequest } from '../../platform/brand/index.js';
import { isEnabledForBrand } from '../../platform/flags.js';
import { HOUR, MINUTE, rateLimit, type RateLimitDb } from '../../platform/ratelimit/index.js';
import { openSse } from '../../platform/sse.js';
import { getRequestLocale } from '../../roboapply/v2/lib/raLocale.js';
import { logger } from '../../services/LoggerService.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  ONBOARDING_EXTRA_ERROR_CODES,
  ONBOARDING_MATCH_RUNS_PER_HOUR,
  ONBOARDING_MATCH_STAGES,
  MarketSnapshotQuerySchema,
  OnboardingConfirmBodySchema,
  OnboardingResumeBodySchema,
  StepBodySchema,
  StepParamsSchema,
  TitleSuggestQuerySchema,
  type OnboardingMatchEvent,
} from './contract.js';
import type { OnboardingContext, OnboardingServiceImpl } from './service.js';
import type { MatchPipelineDeps } from './match.js';

export interface OnboardingRouterDeps extends FeatureRouterDeps {
  service?: OnboardingServiceImpl;
  /** O6 wiring per request (tests inject fakes). */
  matchDeps?: (ctx: OnboardingContext) => MatchPipelineDeps;
  /** Hard cap override (tests). */
  matchHardCapMs?: number;
  /** Skip the DB-backed per-user limiters (tests). */
  withoutRateLimit?: boolean;
  /** Counter store for the limiters (tests inject an in-memory one). */
  rateLimitDb?: RateLimitDb;
}

function headerCountry(req: Request): string | null {
  const raw = req.headers['x-vercel-ip-country'] ?? req.headers['cf-ipcountry'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null;
}

export function contextOf(req: Request): OnboardingContext {
  const brand = (req as Partial<BrandedRequest>).brand ?? getCurrentBrandOrDefault();
  let locale: string | null = null;
  try {
    locale = getRequestLocale(req);
  } catch {
    locale = null;
  }
  return {
    brand,
    country: headerCountry(req),
    locale,
    firstValue: {
      campusCalendar: isEnabledForBrand('jobs.campusCalendar', brand),
      jobsFeed: isEnabledForBrand('jobs.feed', brand),
    },
  };
}

export function createOnboardingRouter(deps: OnboardingRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  let lazy: OnboardingServiceImpl | null = null;
  const svc = async (): Promise<OnboardingServiceImpl> => {
    if (deps.service) return deps.service;
    if (!lazy) lazy = (await import('./defaults.js')).defaultOnboardingService();
    return lazy;
  };
  const limiter = (name: string, limit: number, windowSec: number) =>
    deps.withoutRateLimit ? [] : [rateLimit({ name, by: 'user', windows: [{ limit, windowSec }], ...(deps.rateLimitDb ? { db: deps.rateLimitDb } : {}) })];
  const titleLimit = limiter('onboardingTitleSuggest', 60, MINUTE);
  // Each O6 run ingests from providers and may queue AI scoring: persisted per-user cap.
  const matchLimit = limiter('onboardingMatch', ONBOARDING_MATCH_RUNS_PER_HOUR, HOUR);

  router.get('/state', ...auth, route(async (req) => (await svc()).getState(requireUserId(req), contextOf(req))));

  router.put(
    '/steps/:step',
    ...auth,
    route(async (req) => {
      const { step } = parseParams(req, StepParamsSchema);
      const body = parseBody(req, StepBodySchema);
      return (await svc()).saveStep(requireUserId(req), step, body, contextOf(req));
    }),
  );

  router.get(
    '/title-suggest',
    ...auth,
    ...titleLimit,
    route(async (req) => {
      const q = parseQuery(req, TitleSuggestQuerySchema);
      requireUserId(req);
      const ctx = contextOf(req);
      return { items: (await svc()).titleSuggest(q.q, q.locale ?? ctx.locale ?? 'en') };
    }),
  );

  router.get(
    '/market-snapshot',
    ...auth,
    route(async (req) => {
      requireUserId(req);
      const q = parseQuery(req, MarketSnapshotQuerySchema);
      return (await svc()).marketSnapshot(q, contextOf(req));
    }),
  );

  router.post(
    '/resume',
    ...auth,
    route(async (req) => {
      const body = parseBody(req, OnboardingResumeBodySchema);
      return (await svc()).resume(requireUserId(req), body.resumeVariantId, contextOf(req));
    }),
  );

  router.post(
    '/match',
    ...auth,
    ...matchLimit,
    route(async (req, res) => {
      const userId = requireUserId(req);
      const ctx = contextOf(req);
      // O6 runs only on its own screen (or a deliberate re-run from O7 / the tour), never after setup.
      const state = await (await svc()).getState(userId, ctx);
      if (!(ONBOARDING_MATCH_STAGES as readonly string[]).includes(state.stage)) {
        throw new HttpError('conflict', 'Finding jobs is not available at this step.', { reason: ONBOARDING_EXTRA_ERROR_CODES.matchNotAvailable });
      }
      const matchDeps = deps.matchDeps ? deps.matchDeps(ctx) : (await import('./defaults.js')).createDefaultMatchDeps(ctx.brand, await svc());
      const { runOnboardingMatch } = await import('./match.js');
      const sse = openSse(req, res);
      const emit = (e: OnboardingMatchEvent) => {
        sse.send(e.event, e.data);
      };
      try {
        await runOnboardingMatch(matchDeps, userId, { emit, signal: sse.signal, hardCapMs: deps.matchHardCapMs });
      } catch (err) {
        const mapped = mapError(err);
        if (mapped.unexpected) logger.error('ONBOARDING_MATCH', 'match failed', { userId, error: err instanceof Error ? err.message : String(err) });
        emit({ event: 'error', data: { code: mapped.body.code, message: 'Something went wrong while searching.' } });
      } finally {
        sse.close();
        if (!res.writableEnded) res.end();
      }
    }),
  );

  router.post(
    '/confirm',
    ...auth,
    route(async (req) => (await svc()).confirm(requireUserId(req), parseBody(req, OnboardingConfirmBodySchema), contextOf(req))),
  );

  router.post('/complete', ...auth, route(async (req) => (await svc()).complete(requireUserId(req), contextOf(req))));
  router.post('/skip', ...auth, route(async (req) => (await svc()).skip(requireUserId(req), contextOf(req))));
  return router;
}
