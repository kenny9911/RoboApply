// server/src/features/billing-cn/routes.ts — STUB (FND-5). Owner: WP-62.
//
// Mounted by features/index.ts:
//   createWechatPayRouter()        at /api/v1/roboapply/billing-cn/wechatpay
//   createWechatPayNotifyRouter()  at /api/v1/webhooks/wechatpay
// Capability `pay.wechatpay` per route (GoApply with CN_PAYMENTS_ENABLED and
// the WECHATPAY_* credentials). The notify stub proves the raw-body contract:
// it answers 501 when it receives the raw Buffer and 422 invalid_request when
// the body was already parsed (a mount-order bug).

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { HttpError, markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { CreateWechatOrderBodySchema, OrderParamsSchema } from './contract.js';

function stub(what: string, s: { params?: ZodType; query?: ZodType; body?: ZodType } = {}): RequestHandler {
  return markStub(
    route(async (req) => {
      if (s.params) parseParams(req, s.params);
      if (s.query) parseQuery(req, s.query);
      if (s.body) parseBody(req, s.body);
      throw new NotImplementedError(what);
    }),
  );
}

export function createWechatPayRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('pay.wechatpay', { env: deps.env });

  router.post('/', ...auth, on, stub('billingCn.createOrder', { body: CreateWechatOrderBodySchema }));
  router.get('/orders/:orderId', ...auth, on, stub('billingCn.orderStatus', { params: OrderParamsSchema }));

  return router;
}

export function createWechatPayNotifyRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  router.post(
    '/',
    requireFlag('pay.wechatpay', { env: deps.env }),
    route(async (req) => {
      if (!Buffer.isBuffer(req.body)) {
        throw new HttpError('invalid_request', 'The notify body must arrive as raw bytes.', { where: 'body', expected: 'Buffer' });
      }
      throw new NotImplementedError('billingCn.notify');
    }),
  );
  return router;
}
