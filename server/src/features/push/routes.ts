// server/src/features/push/routes.ts — web push subscriptions (WP-61).
// Mounted by features/index.ts at /api/v1/roboapply/push. Capability `webPush` per route
// (404 feature_disabled on GoApply); the service also refuses GoApply on its
// own, so a flag override cannot turn push on there.
//
//   GET    /vapid-public-key     → { publicKey }   (501 provider_not_configured, reason push_not_configured)
//   POST   /subscriptions        body PushSubscription.toJSON() (+ userAgent) → PushSubscriptionView
//   POST   /subscriptions/lookup body { endpoint } → { subscription: PushSubscriptionView | null }
//                                (the caller's own row only; the opt-in shows "on" only for a match)
//   DELETE /subscriptions/:id    → null            (only the caller's own device)
//
// Importing this module registers the `web_push` delivery channel with
// alerts (features/index.ts imports the router at startup, so every process
// that serves the API or runs its crons has the channel).

import { Router } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { requireFlag } from '../../platform/flags.js';
import { parseBody, parseParams, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { registerWebPushChannel } from './channel.js';
import { CreatePushSubscriptionBodySchema, LookupPushSubscriptionBodySchema, PushSubscriptionParamsSchema } from './contract.js';
import { PushService, pushService } from './service.js';

registerWebPushChannel();

export interface PushRouterDeps extends FeatureRouterDeps {
  service?: PushService;
}

export function createPushRouter(deps: PushRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('webPush', { env: deps.env });
  const service = () => deps.service ?? (deps.env ? new PushService({ env: deps.env }) : pushService());

  router.get(
    '/vapid-public-key',
    ...auth,
    on,
    route(async () => service().vapidPublicKey(getCurrentBrandOrDefault())),
  );

  router.post(
    '/subscriptions',
    ...auth,
    on,
    route(
      async (req) => {
        const userId = requireUserId(req);
        const body = parseBody(req, CreatePushSubscriptionBodySchema);
        return service().subscribe(userId, getCurrentBrandOrDefault(), body);
      },
      { status: 201 },
    ),
  );

  router.post(
    '/subscriptions/lookup',
    ...auth,
    on,
    route(async (req) => {
      const userId = requireUserId(req);
      const { endpoint } = parseBody(req, LookupPushSubscriptionBodySchema);
      return service().lookup(userId, getCurrentBrandOrDefault(), endpoint);
    }),
  );

  router.delete(
    '/subscriptions/:id',
    ...auth,
    on,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, PushSubscriptionParamsSchema);
      await service().unsubscribe(userId, id);
      return null;
    }),
  );

  return router;
}
