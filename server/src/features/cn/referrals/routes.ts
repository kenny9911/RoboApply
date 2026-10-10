// server/src/features/cn/referrals/routes.ts — GoApply 内推码 hub (WP-54).
//
//   createCnReferralsRouter()       at /api/v1/roboapply/cn/referrals (seeker; capability `cn.referralCodes` per route)
//     GET    /              ?company&classYear&cursor → ListReferralCodesResponse
//     POST   /              CreateReferralCodeBody → ReferralCodeView (pending review)    + phone bound
//     POST   /:id/report    { reason, note? } → { reported: true }                        + phone bound
//     DELETE /:id           own code → { deleted: true }
//   createCnReferralsAdminRouter()  at /api/v1/roboapply/admin/cn/referrals (admin; not gated so staff can review early)
//     GET    /queue         → ReferralQueueResponse
//     POST   /:id/moderate  { decision, reason? } → { id, status }
//
// Publishing to the public list and reporting need a verified mobile number
// (CN_TW_LAUNCH_PLAN L-8 real-name rule): WP-11's requirePhoneBound answers
// 403 phone_binding_required for a WeChat-only account. Reading and deleting
// one's own code do not.

import { Router, type RequestHandler } from 'express';
import { seekerAuth } from '../../../roboapply/engine/middleware/seekerAuth.js';
import { requireAuth } from '../../../middleware/auth.js';
import { requireAdmin } from '../../../middleware/admin.js';
import { requireFlag } from '../../../platform/flags.js';
import { parseBody, parseParams, parseQuery, requireUserId, route } from '../../../platform/http.js';
import { requirePhoneBound } from '../../auth-cn/index.js';
import type { FeatureRouterDeps } from '../../index.js';
import {
  CreateReferralCodeBodySchema,
  ListReferralCodesQuerySchema,
  ModerateReferralCodeBodySchema,
  ReferralCodeParamsSchema,
  ReferralQueueQuerySchema,
  ReportReferralCodeBodySchema,
} from './contract.js';
import type { CnReferralService } from './service.js';

export interface CnReferralsRouterOptions {
  /** Test seam; defaults to the process-wide service. */
  service?: CnReferralService;
  /** Test seam for the phone-binding (real-name) gate. */
  phoneGate?: RequestHandler;
}

async function defaultService(): Promise<CnReferralService> {
  return (await import('./index.js')).getCnReferralService();
}

export function createCnReferralsRouter(deps: FeatureRouterDeps = {}, options: CnReferralsRouterOptions = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('cn.referralCodes', { env: deps.env });
  const phone = options.phoneGate ?? requirePhoneBound();
  const svc = async () => options.service ?? (await defaultService());

  router.get(
    '/',
    ...auth,
    on,
    route(async (req) => {
      const userId = requireUserId(req);
      return (await svc()).list(userId, parseQuery(req, ListReferralCodesQuerySchema));
    }),
  );

  router.post(
    '/',
    ...auth,
    on,
    phone,
    route(
      async (req) => {
        const userId = requireUserId(req);
        return (await svc()).create(userId, parseBody(req, CreateReferralCodeBodySchema));
      },
      { status: 201 },
    ),
  );

  router.post(
    '/:id/report',
    ...auth,
    on,
    phone,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, ReferralCodeParamsSchema);
      return (await svc()).report(userId, id, parseBody(req, ReportReferralCodeBodySchema));
    }),
  );

  router.delete(
    '/:id',
    ...auth,
    on,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, ReferralCodeParamsSchema);
      return (await svc()).remove(userId, id);
    }),
  );

  return router;
}

export function createCnReferralsAdminRouter(deps: FeatureRouterDeps = {}, options: CnReferralsRouterOptions = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const svc = async () => options.service ?? (await defaultService());

  router.get(
    '/queue',
    ...admin,
    route(async (req) => (await svc()).queue(parseQuery(req, ReferralQueueQuerySchema))),
  );

  router.post(
    '/:id/moderate',
    ...admin,
    route(async (req) => {
      const moderatorId = requireUserId(req);
      const { id } = parseParams(req, ReferralCodeParamsSchema);
      return (await svc()).moderate(moderatorId, id, parseBody(req, ModerateReferralCodeBodySchema));
    }),
  );

  return router;
}
