// server/src/features/credits/routes.ts — seeker + public credits routes (WP-21a).
//
// Mounted by features/index.ts:
//   createCreditsRouter()      at /api/v1/roboapply/credits
//     GET  /            → CreditsResponse (caps, usage, reset times, plan; practice balance)
//     GET  /history     → { items: CreditLedgerView[], cursor }   credit uses, newest first: metered actions and
//                         practice interviews (grants are not uses)
//     POST /cancel      → CancelResponse   one click; survey optional; confirmation email
//     POST /cancel/survey {reason?, note?} → 204   stores the answer only (no cancel, email or event)
//   createBillingPlansRouter() at /api/v1/roboapply/billing/plans (after the legacy
//                              /billing router, which has no /plans path)
//     GET  /            → PlansResponse    public; signed-in users also get `current`
//   createPublicCancelRouter() at /api/v1/public/cancel (no sign-in; §312k BGB)
//     POST /            {email} → 204 always; emails a single-use 30-minute link
//     POST /confirm     {token} → CancelResponse
// The admin router lives in adminRoutes.ts. Checkout stays on the legacy
// /billing/checkout route (roboapply/routes/billing.ts).

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { optionalAuth } from '../../middleware/auth.js';
import { parseBody, parseQuery, requireUserId, route } from '../../platform/http.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { BillingError, billingErrorBody } from '../../platform/billing/errors.js';
import { clientIp } from '../../platform/ratelimit/index.js';
import { buyerCountryFromRequest } from '../../platform/billing/buyerCountry.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  CancelSubscriptionBodySchema,
  CancelSurveyBodySchema,
  CreditHistoryQuerySchema,
  PublicCancelConfirmBodySchema,
  PublicCancelRequestBodySchema,
} from './contract.js';
import { CreditsAreaService, creditsAreaService } from './service.js';

export function brandOf(req: Request): ProductBrand {
  return (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();
}

/** `route()` plus the billing error envelope (codes like `no_subscription`, `cancel_token_invalid`). */
export function billingRoute<T>(fn: (req: Request, res: Response) => Promise<T>, options: { status?: number } = {}): RequestHandler {
  return route(async (req, res) => {
    try {
      return await fn(req, res);
    } catch (err) {
      if (err instanceof BillingError) {
        res.status(err.status).json(billingErrorBody(err));
        return undefined as T;
      }
      throw err;
    }
  }, options);
}

export function serviceFor(deps: FeatureRouterDeps & { service?: CreditsAreaService }): CreditsAreaService {
  if (deps.service) return deps.service;
  if (deps.env) {
    const env = deps.env;
    return new CreditsAreaService({ env: () => env });
  }
  return creditsAreaService;
}

export function createCreditsRouter(deps: FeatureRouterDeps & { service?: CreditsAreaService } = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const service = serviceFor(deps);

  router.get('/', ...auth, billingRoute(async (req) => service.getCredits(requireUserId(req), brandOf(req))));
  router.get(
    '/history',
    ...auth,
    billingRoute(async (req) => service.history(requireUserId(req), parseQuery(req, CreditHistoryQuerySchema))),
  );
  router.post(
    '/cancel',
    ...auth,
    billingRoute(async (req) => service.cancel(requireUserId(req), brandOf(req), parseBody(req, CancelSubscriptionBodySchema))),
  );
  router.post(
    '/cancel/survey',
    ...auth,
    billingRoute(async (req, res) => {
      await service.recordCancelSurvey(requireUserId(req), brandOf(req), parseBody(req, CancelSurveyBodySchema));
      res.status(204).end();
    }),
  );
  return router;
}

export function createBillingPlansRouter(deps: FeatureRouterDeps & { service?: CreditsAreaService } = {}): Router {
  const router = Router();
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];
  const service = serviceFor(deps);
  router.get(
    '/',
    ...maybeAuth,
    billingRoute(async (req) => {
      const userId = (req as Request & { user?: { id?: string } }).user?.id ?? null;
      return service.plans(brandOf(req), { userId, country: buyerCountryFromRequest(req) });
    }),
  );
  return router;
}

export function createPublicCancelRouter(deps: FeatureRouterDeps & { service?: CreditsAreaService } = {}): Router {
  const router = Router();
  const service = serviceFor(deps);
  router.post(
    '/',
    billingRoute(async (req, res) => {
      const { email } = parseBody(req, PublicCancelRequestBodySchema);
      await service.requestPublicCancel(brandOf(req), email, clientIp(req));
      res.status(204).end();
    }),
  );
  router.post(
    '/confirm',
    billingRoute(async (req) => {
      const { token } = parseBody(req, PublicCancelConfirmBodySchema);
      return service.confirmPublicCancel(brandOf(req), token);
    }),
  );
  return router;
}
