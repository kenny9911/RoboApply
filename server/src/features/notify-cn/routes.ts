// server/src/features/notify-cn/routes.ts — WeChat 公众号 notices (WP-73).
//
// Mounted by features/index.ts:
//   createNotifyCnRouter()         at /api/v1/roboapply/notify-cn (seeker)
//     POST /subscribe-messages     store accepted one-time subscribe prompts
//     GET  /js-sdk-signature?url=  JS-SDK config for a GoApply page
//   createWechatMpWebhookRouter()  at /api/v1/webhooks/wechat-mp (raw body)
//     GET  /                       URL verification (echoes `echostr` after the signature check)
//     POST /                       server messages (raw XML; signature, timestamp
//                                  and, in 安全模式, msg_signature + AES checked)
// Capability `notify.wechat` on every route (GoApply with WECHAT_MP_APP_ID,
// WECHAT_MP_APP_SECRET and WECHAT_MP_TOKEN): without it the routes answer 404
// feature_disabled and the client shows nothing.
//
// Importing this module registers the `wechat_mp` delivery channel with
// WP-39a's `registerDeliveryChannel` (channel.ts).

import { Router, type Request, type Response } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { requireFlag } from '../../platform/flags.js';
import { HttpError, parseBody, parseQuery, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { registerWechatMpChannel } from './channel.js';
import { JsSdkSignatureQuerySchema, SubscribeMessagesBodySchema, WechatServerMessageQuerySchema, WechatServerVerifyQuerySchema } from './contract.js';
import { NotifyCnService, notifyCnService } from './service.js';

registerWechatMpChannel();

export type NotifyCnRouterDeps = FeatureRouterDeps & { service?: NotifyCnService };

function brandOf(req: Request): ProductBrand {
  return (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();
}

function serviceFor(deps: NotifyCnRouterDeps): () => NotifyCnService {
  if (deps.service) return () => deps.service!;
  if (deps.env) {
    let own: NotifyCnService | null = null;
    return () => (own ??= new NotifyCnService({ env: deps.env }));
  }
  return notifyCnService;
}

function sendText(res: Response, body: string): void {
  res.status(200).set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff').type('text/plain').send(body);
}

export function createNotifyCnRouter(deps: NotifyCnRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('notify.wechat', { env: deps.env });
  const service = serviceFor(deps);

  router.post(
    '/subscribe-messages',
    ...auth,
    on,
    route(async (req) => service().recordSubscribe(requireUserId(req), brandOf(req), parseBody(req, SubscribeMessagesBodySchema))),
  );
  router.get(
    '/js-sdk-signature',
    ...auth,
    on,
    route(async (req, res) => {
      const { url } = parseQuery(req, JsSdkSignatureQuerySchema);
      res.set('Cache-Control', 'no-store');
      return service().jsSdkConfig(requireUserId(req), brandOf(req), url);
    }),
  );

  return router;
}

export function createWechatMpWebhookRouter(deps: NotifyCnRouterDeps = {}): Router {
  const router = Router();
  const on = requireFlag('notify.wechat', { env: deps.env });
  const service = serviceFor(deps);

  router.get(
    '/',
    on,
    route(async (req, res) => {
      const q = parseQuery(req, WechatServerVerifyQuerySchema);
      sendText(res, service().verifyServerUrl(q));
    }),
  );
  router.post(
    '/',
    on,
    route(async (req, res) => {
      const q = parseQuery(req, WechatServerMessageQuerySchema);
      if (!Buffer.isBuffer(req.body)) {
        // A mount-order bug: the signature covers the raw bytes, so a parsed body can never be read.
        throw new HttpError('invalid_request', 'The message body must arrive as raw bytes.', { where: 'body', expected: 'Buffer' });
      }
      sendText(res, await service().handleServerMessage(q, req.body));
    }),
  );

  return router;
}
