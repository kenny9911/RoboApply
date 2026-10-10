// server/src/features/offers/routes.ts — offer comparison router (WP-64).
// Mounted by features/index.ts at /api/v1/roboapply/offers (seeker session).
// Every route is behind the `offers` capability (404 feature_disabled when off).
//
//   GET    /                                   → { items: OfferView[], aiAvailable }
//   POST   /compare                            { trackerEntryIds } → OfferComparison
//   POST   /explain                            { trackerEntryIds } → OfferExplanation            AI · daily limit
//   PUT    /:trackerEntryId                    PutOfferBody → OfferView
//   DELETE /:trackerEntryId                    → { deleted: true }
//   GET    /:trackerEntryId/benchmark          → OfferBenchmark
//   POST   /:trackerEntryId/negotiation-draft  NegotiationDraftBody → NegotiationDraft          AI · daily limit
//
// The AI routes also pass the GoApply "bind a phone first" gate
// (403 phone_binding_required, WP-11). Validation (422), AI off (503) and
// ownership (404) are checked BEFORE the daily limit, so only a request that
// can reach the model uses one of the day's AI calls.

import { Router, type Request, type RequestHandler } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getRequestLocale } from '../../roboapply/v2/lib/raLocale.js';
import { requireFlag } from '../../platform/flags.js';
import { mapError, parseBody, parseParams, requireUserId, route } from '../../platform/http.js';
import { DAY, rateLimit, type RateWindow } from '../../platform/ratelimit/index.js';
import { requirePhoneBound } from '../auth-cn/index.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  CompareOffersBodySchema,
  ExplainOffersBodySchema,
  NegotiationDraftBodySchema,
  OFFERS_AI_DAILY_LIMIT,
  OfferEntryParamsSchema,
  PutOfferBodySchema,
  type OffersListResponse,
} from './contract.js';
import type { OffersService } from './service.js';

export const OFFERS_AI_LIMIT_NAME = 'offersAiPerUser';
export const OFFERS_AI_WINDOWS: readonly RateWindow[] = [{ limit: OFFERS_AI_DAILY_LIMIT, windowSec: DAY }];

export interface OffersRouterOptions {
  /** Test seam; defaults to the process-wide service. */
  service?: OffersService;
  /** Test seam for the GoApply phone-binding gate. */
  phoneGate?: RequestHandler;
  /** Rate-limit factory (tests inject a recorder). */
  limiter?: (name: string, windows: readonly RateWindow[]) => RequestHandler;
}

const defaultLimiter = (name: string, windows: readonly RateWindow[]): RequestHandler => rateLimit({ name, windows, by: 'user' });

/** Middleware form of `route()` for checks that must answer before a later middleware runs. */
function precheck(check: (req: Request) => Promise<void>): RequestHandler {
  return async (req, res, next) => {
    try {
      await check(req);
    } catch (err) {
      const mapped = mapError(err);
      if (mapped.unexpected) {
        // eslint-disable-next-line no-console
        console.error(`[offers] ${req.method} ${req.originalUrl} precheck failed:`, err);
      }
      if (res.headersSent) return;
      for (const [k, v] of Object.entries(mapped.headers)) res.setHeader(k, v);
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next();
  };
}

export function createOffersRouter(deps: FeatureRouterDeps = {}, options: OffersRouterOptions = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('offers', { env: deps.env });
  const limiter = options.limiter ?? defaultLimiter;
  const phoneGate = options.phoneGate ?? requirePhoneBound();
  const aiLimit = limiter(OFFERS_AI_LIMIT_NAME, OFFERS_AI_WINDOWS);
  const svc = async (): Promise<OffersService> => options.service ?? (await import('./index.js')).getOffersService();

  const explainCheck = precheck(async (req) => {
    const userId = requireUserId(req);
    const body = parseBody(req, ExplainOffersBodySchema);
    await (await svc()).precheckExplain(userId, body.trackerEntryIds);
  });
  const draftCheck = precheck(async (req) => {
    const userId = requireUserId(req);
    const { trackerEntryId } = parseParams(req, OfferEntryParamsSchema);
    const body = parseBody(req, NegotiationDraftBodySchema);
    await (await svc()).precheckDraft(userId, trackerEntryId, body.compareWith ?? []);
  });

  router.get(
    '/',
    ...auth,
    on,
    route(async (req): Promise<OffersListResponse> => {
      const userId = requireUserId(req);
      const s = await svc();
      const [items, aiAvailable] = await Promise.all([s.list(userId), s.aiAvailable(userId)]);
      return { items, aiAvailable };
    }),
  );

  router.post(
    '/compare',
    ...auth,
    on,
    route(async (req) => {
      const userId = requireUserId(req);
      const body = parseBody(req, CompareOffersBodySchema);
      return (await svc()).compare(userId, body.trackerEntryIds);
    }),
  );

  router.post(
    '/explain',
    ...auth,
    on,
    phoneGate,
    explainCheck,
    aiLimit,
    route(async (req) => {
      const userId = requireUserId(req);
      const body = parseBody(req, ExplainOffersBodySchema);
      return (await svc()).explain(userId, body.trackerEntryIds, getRequestLocale(req));
    }),
  );

  router.put(
    '/:trackerEntryId',
    ...auth,
    on,
    route(async (req) => {
      const userId = requireUserId(req);
      const { trackerEntryId } = parseParams(req, OfferEntryParamsSchema);
      const body = parseBody(req, PutOfferBodySchema);
      return (await svc()).put(userId, trackerEntryId, body);
    }),
  );

  router.delete(
    '/:trackerEntryId',
    ...auth,
    on,
    route(async (req) => {
      const userId = requireUserId(req);
      const { trackerEntryId } = parseParams(req, OfferEntryParamsSchema);
      return (await svc()).remove(userId, trackerEntryId);
    }),
  );

  router.get(
    '/:trackerEntryId/benchmark',
    ...auth,
    on,
    route(async (req) => {
      const userId = requireUserId(req);
      const { trackerEntryId } = parseParams(req, OfferEntryParamsSchema);
      return (await svc()).benchmark(userId, trackerEntryId);
    }),
  );

  router.post(
    '/:trackerEntryId/negotiation-draft',
    ...auth,
    on,
    phoneGate,
    draftCheck,
    aiLimit,
    route(async (req) => {
      const userId = requireUserId(req);
      const { trackerEntryId } = parseParams(req, OfferEntryParamsSchema);
      const body = parseBody(req, NegotiationDraftBodySchema);
      return (await svc()).negotiationDraft(userId, trackerEntryId, body, getRequestLocale(req));
    }),
  );

  return router;
}
