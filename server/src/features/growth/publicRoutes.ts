// server/src/features/growth/publicRoutes.ts — POST /api/v1/public/events (WP-23).
//
// First-party events: ≤50 per batch, 120 events/min per anonId (per IP
// without one) plus a 600 events/min ceiling per IP, so rotating anonIds
// cannot lift the limit. Token-route paths are stored as `:token`. Works with or without a session; optionalAuth supplies the
// user, and the consent rules (events.ts) decide whether the batch may be
// linked to the anonId and the account. Unknown event names are counted as
// `rejected`, not stored. Answers `{ accepted, rejected }`.

import { Router, type Request } from 'express';
import { optionalAuth } from '../../middleware/auth.js';
import { getCurrentBrand } from '../../platform/brand/index.js';
import { parseBody, route } from '../../platform/http.js';
import { clientIp } from '../../platform/ratelimit/index.js';
import type { FeatureRouterDeps } from '../index.js';
import { requestCountry } from './attribution.js';
import { EventsBatchBodySchema } from './contract.js';
import { ANALYTICS_CONSENT_COOKIE, parseConsentChoice } from './events.js';
import { growthServiceImpl, type GrowthService } from './service.js';

export interface EventsPublicRouterDeps extends FeatureRouterDeps {
  service?: Pick<GrowthService, 'ingestEvents'>;
}

function sessionUserId(req: Request): string | null {
  const id = (req as Request & { user?: { id?: unknown } }).user?.id;
  return typeof id === 'string' && id ? id : null;
}

export function createEventsPublicRouter(deps: EventsPublicRouterDeps = {}): Router {
  const router = Router();
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];
  const service = deps.service ?? growthServiceImpl;

  router.post(
    '/',
    ...maybeAuth,
    route(async (req) => {
      const body = parseBody(req, EventsBatchBodySchema);
      const brand = getCurrentBrand();
      return service.ingestEvents(body, {
        brand: brand.id,
        market: brand.market,
        userId: sessionUserId(req),
        country: requestCountry(req),
        consent: parseConsentChoice((req.cookies as Record<string, unknown> | undefined)?.[ANALYTICS_CONSENT_COOKIE]),
        ip: clientIp(req),
      });
    }),
  );
  return router;
}
