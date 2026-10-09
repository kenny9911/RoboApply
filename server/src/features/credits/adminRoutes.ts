// server/src/features/credits/adminRoutes.ts — admin credits routes (WP-21a).
// Mounted by features/index.ts at /api/v1/roboapply/admin/credits (admin only):
//   GET/PUT /catalog            caps editor (AppConfig credits.catalog.v1; validated, 30 s cache dropped on save)
//   GET/POST /overrides         entitlement overrides (bucket:<b> | entitlement:<k> | flag:<key>)
//   DELETE /overrides/:id
//   GET/PUT /fx-reference       TWD reference rate with source and as-of (hidden from users after 45 days)
//   GET /tw-revenue             Stripe TW-card revenue YTD vs NT$600k (70 % warning)
//   GET /refund-quote?userId    F-BILL-08 decision for the user's latest charge (quote only; refunds are issued in Stripe)

import { Router, type Request } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { parseBody, parseParams, parseQuery, requireUserId } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  CreateOverrideBodySchema,
  ListOverridesQuerySchema,
  OverrideParamsSchema,
  PutCatalogBodySchema,
  PutFxReferenceBodySchema,
  RefundQuoteQuerySchema,
} from './contract.js';
import { billingRoute, serviceFor } from './routes.js';
import type { CreditsAreaService } from './service.js';

function adminIdOf(req: Request): string | null {
  try {
    return requireUserId(req);
  } catch {
    return null;
  }
}

export function createCreditsAdminRouter(deps: FeatureRouterDeps & { service?: CreditsAreaService } = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const service = serviceFor(deps);

  router.get('/catalog', ...admin, billingRoute(async () => service.getCatalog()));
  router.put(
    '/catalog',
    ...admin,
    billingRoute(async (req) => service.putCatalog(parseBody(req, PutCatalogBodySchema).override, adminIdOf(req))),
  );
  router.get('/overrides', ...admin, billingRoute(async (req) => service.listOverrides(parseQuery(req, ListOverridesQuerySchema))));
  router.post(
    '/overrides',
    ...admin,
    billingRoute(async (req) => service.createOverride(parseBody(req, CreateOverrideBodySchema), adminIdOf(req)), { status: 201 }),
  );
  router.delete(
    '/overrides/:id',
    ...admin,
    billingRoute(async (req, res) => {
      await service.deleteOverride(parseParams(req, OverrideParamsSchema).id, adminIdOf(req));
      res.status(204).end();
    }),
  );
  router.get('/fx-reference', ...admin, billingRoute(async () => service.getFx()));
  router.put('/fx-reference', ...admin, billingRoute(async (req) => service.putFx(parseBody(req, PutFxReferenceBodySchema), adminIdOf(req))));
  router.get('/tw-revenue', ...admin, billingRoute(async () => service.twRevenue()));
  router.get('/refund-quote', ...admin, billingRoute(async (req) => service.refundQuote(parseQuery(req, RefundQuoteQuerySchema).userId)));

  return router;
}
