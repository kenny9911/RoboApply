// server/src/features/notify-cn/routes.ts — STUB (FND-5). Owner: WP-73.
//
// Mounted by features/index.ts:
//   createNotifyCnRouter()         at /api/v1/roboapply/notify-cn (seeker)
//   createWechatMpWebhookRouter()  at /api/v1/webhooks/wechat-mp (raw body)
// Capability `notify.wechat` per route. The POST stub answers 501 when it
// receives the raw Buffer and 422 when the body was parsed (mount-order bug).

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { HttpError, markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { JsSdkSignatureQuerySchema, SubscribeMessagesBodySchema, WechatServerMessageQuerySchema, WechatServerVerifyQuerySchema } from './contract.js';

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

export function createNotifyCnRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('notify.wechat', { env: deps.env });

  router.post('/subscribe-messages', ...auth, on, stub('notifyCn.subscribe', { body: SubscribeMessagesBodySchema }));
  router.get('/js-sdk-signature', ...auth, on, stub('notifyCn.jsSdkSignature', { query: JsSdkSignatureQuerySchema }));

  return router;
}

export function createWechatMpWebhookRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const on = requireFlag('notify.wechat', { env: deps.env });

  router.get('/', on, stub('notifyCn.serverVerify', { query: WechatServerVerifyQuerySchema }));
  router.post(
    '/',
    on,
    route(async (req) => {
      parseQuery(req, WechatServerMessageQuerySchema);
      if (!Buffer.isBuffer(req.body)) {
        throw new HttpError('invalid_request', 'The message body must arrive as raw bytes.', { where: 'body', expected: 'Buffer' });
      }
      throw new NotImplementedError('notifyCn.serverMessage');
    }),
  );

  return router;
}
