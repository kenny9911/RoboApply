// server/src/features/billing-cn/routes.ts — GoApply WeChat Pay (WP-62).
//
// Mounted by features/index.ts:
//   createWechatPayRouter()        at /api/v1/roboapply/billing-cn/wechatpay
//     POST /                   CreateWechatOrderBody → CreateWechatOrderResponse
//     GET  /orders/:orderId    → CnOrderStatus (the buyer's own order only)
//   createWechatPayNotifyRouter()  at /api/v1/webhooks/wechatpay
//     POST /                   WeChat Pay v3 notify on the raw Buffer
// Capability `pay.wechatpay` per route (GoApply with CN_PAYMENTS_ENABLED and
// the WECHATPAY_* credentials); charging additionally needs the collecting
// entity to match the merchant (503 rail_not_configured otherwise).
//
// Importing this module registers the WeChat Pay rail with WP-21a's registry
// (`registerRail('wechatpay', …)`), so `resolveRail()` and `GET /billing/plans`
// see it.

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { BillingError, billingErrorBody } from '../../platform/billing/errors.js';
import { ensureWechatPayRail } from '../../platform/billing/rails/wechatpay.js';
import { HttpError, parseBody, parseParams, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { CreateWechatOrderBodySchema, OrderParamsSchema } from './contract.js';
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

export function createWechatPayRouter(deps: BillingCnRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('pay.wechatpay', { env: deps.env });
  // One instance per router: its per-order query throttle must outlive a request.
  const service = serviceFor(deps);

  router.post(
    '/',
    ...auth,
    on,
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
    on,
    billingCnRoute(async (req) => service.orderStatus(requireUserId(req), brandOf(req), parseParams(req, OrderParamsSchema).orderId)),
  );

  return router;
}

export function createWechatPayNotifyRouter(deps: BillingCnRouterDeps = {}): Router {
  const router = Router();
  const service = serviceFor(deps);
  router.post(
    '/',
    requireFlag('pay.wechatpay', { env: deps.env }),
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
