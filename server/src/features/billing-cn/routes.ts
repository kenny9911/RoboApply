// server/src/features/billing-cn/routes.ts — GoApply WeChat Pay (WP-62).
//
// Mounted by features/index.ts:
//   createWechatPayRouter()        at /api/v1/roboapply/billing-cn/wechatpay
//     POST /                   CreateWechatOrderBody → CreateWechatOrderResponse
//     GET  /orders/:orderId    → CnOrderStatus (the buyer's own order only)
//   createWechatPayNotifyRouter()  at /api/v1/webhooks/wechatpay
//     POST /                   WeChat Pay v3 notify on the raw Buffer
//
// WeChat Pay is GoApply's second, optional rail (Alipay is the first; D6).
// Two gates, and they are different on purpose:
//   - NEW ORDERS (POST /) need the capability `pay.wechatpay`: the merchant
//     credentials, the collecting entity matching the merchant, and payments
//     not switched off. There is no master switch to turn on (D5). Under the
//     kill switch (CN_PAYMENTS_ENABLED=false) a configured deployment answers
//     503 `payments_disabled`; a deployment where WeChat Pay is not set up
//     answers 404 `feature_disabled` (no UI entry).
//   - THE NOTIFY AND THE ORDER STATUS stay open whenever WeChat Pay is set up
//     (`wechatPayReadiness`), kill switch or not. The switch stops new orders
//     only: a payment that was already in flight must still be fulfilled, and
//     its buyer must still be able to read the result, as the Alipay callback
//     stays open (MARKET_STRATEGY §5.2 rule A1). A 404 here would make WeChat
//     Pay retry and then give up on money that was taken.
//
// Importing this module registers the WeChat Pay rail with WP-21a's registry
// (`registerRail('wechatpay', …)`), so `resolveRail()` and `GET /billing/plans`
// see it. It does not touch the Alipay rail's registration (rule A12).

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { cnPaymentsKilled, requireFlag } from '../../platform/flags.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { BillingError, billingErrorBody } from '../../platform/billing/errors.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { ensureWechatPayRail, wechatPayReadiness } from '../../platform/billing/rails/wechatpay.js';
import { HttpError, parseBody, parseParams, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { BILLING_CN_ERROR_CODES, CreateWechatOrderBodySchema, OrderParamsSchema } from './contract.js';
import { BillingCnError, BillingCnService, billingCnService } from './service.js';

ensureWechatPayRail();

export type BillingCnRouterDeps = FeatureRouterDeps & { service?: BillingCnService };

function brandOf(req: Request): ProductBrand {
  return (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();
}

function serviceFor(deps: BillingCnRouterDeps): BillingCnService {
  if (deps.service) return deps.service;
  return deps.env ? new BillingCnService({ env: deps.env }) : billingCnService;
}

/** `route()` plus the billing envelopes (`plan_not_sellable`, `rail_not_configured`, `wechat_openid_missing`, …). */
function billingCnRoute<T>(fn: (req: Request, res: Response) => Promise<T>): RequestHandler {
  return route(async (req, res) => {
    try {
      return await fn(req, res);
    } catch (err) {
      if (err instanceof BillingError) {
        res.status(err.status).json(billingErrorBody(err));
        return undefined as T;
      }
      if (err instanceof BillingCnError) {
        res.status(err.status).json(
          err.details ? { success: false, code: err.code, error: err.message, details: err.details } : { success: false, code: err.code, error: err.message },
        );
        return undefined as T;
      }
      throw err;
    }
  });
}

/**
 * Open while WeChat Pay is set up on the request's brand: merchant
 * credentials, the key that verifies notifies, and the collecting entity
 * matching the merchant. Deliberately NOT the kill switch and not the
 * `pay.wechatpay` on/off flag: this gates the notify and the status read of
 * an order that already exists.
 */
function whenSetUp(env: EnvSource | undefined): RequestHandler {
  return (req, res, next) => {
    if (wechatPayReadiness(brandOf(req), env ?? process.env).ready) {
      next();
      return;
    }
    res.status(404).json({ success: false, code: 'feature_disabled', error: 'This feature is not available.' });
  };
}

/**
 * The gate for a NEW order: the `pay.wechatpay` capability. When WeChat Pay
 * is set up and only the kill switch stands in the way, the answer says so
 * (503 `payments_disabled`) instead of pretending the rail does not exist.
 */
function whenSelling(env: EnvSource | undefined): RequestHandler {
  const capability = requireFlag('pay.wechatpay', { env });
  return (req, res, next) => {
    const e = env ?? process.env;
    if (cnPaymentsKilled(e) && wechatPayReadiness(brandOf(req), e).ready) {
      res.status(503).json({ success: false, code: BILLING_CN_ERROR_CODES.paymentsDisabled, error: 'Payments are switched off right now.' });
      return;
    }
    void capability(req, res, next);
  };
}

export function createWechatPayRouter(deps: BillingCnRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const selling = whenSelling(deps.env);
  const setUp = whenSetUp(deps.env);
  // One instance per router: its per-order query throttle must outlive a request.
  const service = serviceFor(deps);

  router.post(
    '/',
    ...auth,
    selling,
    billingCnRoute(async (req) =>
      service.createOrder(requireUserId(req), brandOf(req), parseBody(req, CreateWechatOrderBodySchema), {
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }),
    ),
  );
  router.get(
    '/orders/:orderId',
    ...auth,
    setUp,
    billingCnRoute(async (req) => service.orderStatus(requireUserId(req), brandOf(req), parseParams(req, OrderParamsSchema).orderId)),
  );

  return router;
}

export function createWechatPayNotifyRouter(deps: BillingCnRouterDeps = {}): Router {
  const router = Router();
  const service = serviceFor(deps);
  router.post(
    '/',
    // Open under the kill switch (see the header): only a deployment where
    // WeChat Pay is not set up answers 404.
    whenSetUp(deps.env),
    route(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        // A mount-order bug: the signature covers the raw bytes, so a parsed
        // body can never be verified.
        throw new HttpError('invalid_request', 'The notify body must arrive as raw bytes.', { where: 'body', expected: 'Buffer' });
      }
      const outcome = await service.handleNotify({ rawBody: req.body, headers: req.headers });
      res.status(outcome.httpStatus).json(outcome.body);
    }),
  );
  return router;
}
