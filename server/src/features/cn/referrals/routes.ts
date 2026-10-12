// server/src/features/cn/referrals/routes.ts — GoApply 内推码 hub (WP-54).
//
//   createCnReferralsRouter()       at /api/v1/roboapply/cn/referrals (seeker; capability `cn.referralCodes` per route)
//     GET    /              ?company&classYear&cursor → ListReferralCodesResponse
//     POST   /              CreateReferralCodeBody → ReferralCodeView (pending review)    + phone bound
//     POST   /:id/report    { reason, note? } → { reported: true }                        + phone bound
//     DELETE /:id           own code → { deleted: true }
//   createCnReferralsAdminRouter()  at /api/v1/roboapply/admin/cn/referrals (admin; not gated so staff can review early)
//     GET    /queue         → ReferralQueueResponse
//     POST   /:id/moderate  { decision, reason? } → { id, status } (one RAAdminAuditLog row per moderation)
//
// The console moderates through /admin/referrals/:id/moderate (features/admin);
// this router's moderate route stays mounted for scripts and old clients, so
// it writes the same audit row (event 'admin_referral_moderated', subject =
// the person who shared the code). An audit failure never fails the decision.
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
import { logger } from '../../../services/LoggerService.js';
import { ADMIN_AUDIT_EVENTS } from '../../admin/contract.js';
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
import type { ReferralStore } from './store.js';

/** The slice of features/admin this router needs (its index.ts; loaded on first use). */
export interface ModerationAudit {
  write(input: { adminId: string; subjectUserId: string | null; eventType: string; payload: Record<string, unknown> }): Promise<unknown>;
}

export interface CnReferralsRouterOptions {
  /** Test seam; defaults to the process-wide service. */
  service?: CnReferralService;
  /** Test seam for the phone-binding (real-name) gate. */
  phoneGate?: RequestHandler;
  /** Admin router: where the moderated code's owner and status are read before the decision (default: the Prisma store). */
  store?: Pick<ReferralStore, 'available' | 'find'>;
  /** Admin router: the audit writer (default: features/admin `writeAdminAudit` on RAAdminAuditLog). */
  audit?: ModerationAudit;
}

async function defaultService(): Promise<CnReferralService> {
  return (await import('./index.js')).getCnReferralService();
}

async function defaultStore(): Promise<Pick<ReferralStore, 'available' | 'find'>> {
  return (await import('./index.js')).createPrismaReferralStore();
}

async function defaultAudit(): Promise<ModerationAudit> {
  const admin = await import('../../admin/index.js');
  const store = admin.createPrismaAuditStore();
  return { write: (input) => admin.writeAdminAudit(store, input) };
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
      const body = parseBody(req, ModerateReferralCodeBodySchema);
      // Owner and status before the decision (for the audit row). A read problem never blocks moderation.
      let before: { userId: string; status: string } | null = null;
      try {
        const store = options.store ?? (await defaultStore());
        const row = store.available() ? await store.find(id) : null;
        before = row ? { userId: row.userId, status: row.status } : null;
      } catch {
        before = null;
      }
      const result = await (await svc()).moderate(moderatorId, id, body);
      try {
        const audit = options.audit ?? (await defaultAudit());
        await audit.write({
          adminId: moderatorId,
          subjectUserId: before?.userId ?? null,
          eventType: ADMIN_AUDIT_EVENTS.referralModerated,
          payload: { referralCodeId: id, decision: body.decision, reason: body.reason ?? null, before: { status: before?.status ?? null }, after: { status: result.status }, via: 'admin/cn/referrals' },
        });
      } catch (err) {
        logger.error('CN_REFERRALS', 'audit row failed', { referralCodeId: id, error: err instanceof Error ? err.message : String(err) });
      }
      return result;
    }),
  );

  return router;
}
