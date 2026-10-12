// server/src/features/credits/adminRoutes.ts — admin credits routes (WP-21a).
// Mounted by features/index.ts at /api/v1/roboapply/admin/credits (admin only):
//   GET/PUT /catalog            caps editor (AppConfig credits.catalog.v1; validated, 30 s cache dropped on save)
//   GET/POST /overrides         entitlement overrides (bucket:<b> | entitlement:<k> | flag:<key>);
//   DELETE /overrides/:id       each create and delete writes one admin audit row (adminId + the user it is about)
//   GET/PUT /fx-reference       TWD reference rate with source and as-of (hidden from users after 45 days)
//   GET /tw-revenue             Stripe TW-card revenue YTD vs NT$600k (70 % warning)
//   GET /refund-quote?userId    F-BILL-08 decision for the user's latest charge (quote only; read it before refunding)
//
// Admin billing (adminBilling.ts; shapes in adminBillingTypes.ts):
//   POST /refunds               { userId, target: { invoiceId } | { checkoutSessionId }, amountMinor?, reason, attemptKey }
//                               → { refundId, amountMinor, currency, full }. One Stripe refund and one admin audit row.
//                               Entitlements are NOT changed here: the `charge.refunded` webhook does it. The attempt
//                               key (one per refund dialog; body field, else the `Idempotency-Key` header) is required.
//                               404 not_found, 409 refund_not_available, 422 invalid_request, 503 rail_not_configured,
//                               502 payment_provider_error.
//   GET  /refunds?userId=&cursor=      → { items, cursor }: refunds, withdrawals, disputes and manual CN records,
//                               newest first, 50 a page.
//   GET  /cn-orders?userId=     → { items }: the user's completed CN orders with their refunded marker.
//   POST /cn-orders/:orderId/refund    { reason, confirmMoneyReturned: true, refundedAmountMinor? }
//                               → { status: 'recorded' | 'already_recorded', orderId, entitlement }. Records a refund
//                               that staff already made in the merchant console and, for the whole amount, reverses
//                               what the order bought, once. Audited. 404 not_found, 409 order_not_completed, 422.
//   GET  /practice-cost         → { brands: { roboapply, goapply } }: average cost of the last 50 practice sessions.
//   GET  /stripe-health         → key mode, guard, webhook secrets, missing endpoint events, pinned plans.
//                               `?prices=1` adds `prices`: pinned and synced prices against the catalog (by plan
//                               and amount, never a price id). Read-only at Stripe.

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { parseBody, parseParams, parseQuery, requireUserId } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { AdminBillingService, adminBillingService } from './adminBilling.js';
import {
  AdminBillingError,
  AdminCnOrderParamsSchema,
  AdminCnOrdersQuerySchema,
  AdminRefundBodySchema,
  AdminRefundListQuerySchema,
  REFUND_ATTEMPT_KEY_PATTERN,
  RecordCnRefundBodySchema,
  StripeHealthQuerySchema,
} from './adminBillingTypes.js';
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

/** `billingRoute()` plus the admin billing refusals (`order_not_completed`). */
function adminBillingRoute<T>(fn: (req: Request, res: Response) => Promise<T>): RequestHandler {
  return billingRoute(async (req, res) => {
    try {
      return await fn(req, res);
    } catch (err) {
      if (err instanceof AdminBillingError) {
        res.status(err.status).json({ success: false, code: err.code, error: err.message, ...(err.details ? { details: err.details } : {}) });
        return undefined as T;
      }
      throw err;
    }
  });
}

/** The refund's attempt key when the body carries none: a well-formed `Idempotency-Key` header. */
function headerAttemptKey(req: Request): string | undefined {
  const value = req.get('idempotency-key')?.trim() ?? '';
  return REFUND_ATTEMPT_KEY_PATTERN.test(value) ? value : undefined;
}

function billingFor(deps: FeatureRouterDeps & { billing?: AdminBillingService }): AdminBillingService {
  if (deps.billing) return deps.billing;
  if (deps.env) {
    const env = deps.env;
    return new AdminBillingService({ env: () => env });
  }
  return adminBillingService;
}

export function createCreditsAdminRouter(deps: FeatureRouterDeps & { service?: CreditsAreaService; billing?: AdminBillingService } = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const service = serviceFor(deps);
  const billing = billingFor(deps);

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
    billingRoute(async (req) => service.createOverrideAudited(parseBody(req, CreateOverrideBodySchema), adminIdOf(req)), { status: 201 }),
  );
  router.delete(
    '/overrides/:id',
    ...admin,
    billingRoute(async (req, res) => {
      await service.deleteOverrideAudited(parseParams(req, OverrideParamsSchema).id, adminIdOf(req));
      res.status(204).end();
    }),
  );
  router.get('/fx-reference', ...admin, billingRoute(async () => service.getFx()));
  router.put('/fx-reference', ...admin, billingRoute(async (req) => service.putFx(parseBody(req, PutFxReferenceBodySchema), adminIdOf(req))));
  router.get('/tw-revenue', ...admin, billingRoute(async () => service.twRevenue()));
  router.get('/refund-quote', ...admin, billingRoute(async (req) => service.refundQuote(parseQuery(req, RefundQuoteQuerySchema).userId)));

  // ── Admin billing: money actions name the admin who made them (401 without one) ──
  router.post(
    '/refunds',
    ...admin,
    adminBillingRoute(async (req) => {
      const body = parseBody(req, AdminRefundBodySchema);
      return billing.refund(requireUserId(req), { ...body, attemptKey: body.attemptKey ?? headerAttemptKey(req) });
    }),
  );
  router.get('/refunds', ...admin, adminBillingRoute(async (req) => billing.listRefunds(parseQuery(req, AdminRefundListQuerySchema))));
  router.get('/cn-orders', ...admin, adminBillingRoute(async (req) => billing.cnOrders(parseQuery(req, AdminCnOrdersQuerySchema).userId)));
  router.post(
    '/cn-orders/:orderId/refund',
    ...admin,
    adminBillingRoute(async (req) =>
      billing.recordCnRefund(requireUserId(req), parseParams(req, AdminCnOrderParamsSchema).orderId, parseBody(req, RecordCnRefundBodySchema)),
    ),
  );
  router.get('/practice-cost', ...admin, adminBillingRoute(async () => billing.practiceCost()));
  router.get('/stripe-health', ...admin, adminBillingRoute(async (req) => billing.stripeHealth({ prices: parseQuery(req, StripeHealthQuerySchema).prices })));

  return router;
}
