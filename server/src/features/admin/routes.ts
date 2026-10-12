// server/src/features/admin/routes.ts — the admin console router (WP-74).
// Mounted by features/index.ts at /api/v1/roboapply/admin (per-route auth:
// requireAuth + requireAdmin on every route here, so other areas'
// /admin/<area> routers are unaffected).

import { Router, type Request } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { allowedBrands, type BrandId } from '../../platform/brand/index.js';
import { parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { createPrismaAuditStore, listAdminAudit, writeAdminAudit, type AuditStore } from './audit.js';
import {
  AdminAuditQuerySchema,
  AdminCreateOverrideBodySchema,
  AdminOverridesQuerySchema,
  CopilotFeedbackQuerySchema,
  CostsQuerySchema,
  DeleteOverrideQuerySchema,
  OverrideParamsSchema,
  QueueListQuerySchema,
  ReportParamsSchema,
  ReportsQuerySchema,
  ResolveReportBodySchema,
  SafetyQuerySchema,
  SystemQuerySchema,
  WorkItemParamsSchema,
  ADMIN_AUDIT_EVENTS,
} from './contract.js';
import { createAdminOverride, deleteAdminOverride, listAdminOverrides, type OverridesService } from './overrides.js';
import type { CostStore } from './costs.js';
import type { FeedbackStore } from './feedback.js';
import { ModerateReferralCodeBodySchema, ReferralCodeParamsSchema } from '../cn/referrals/contract.js';
import { defaultReferralModeration, moderateReferral, type ReferralModeration } from './moderation.js';
import type { QueueStore } from './queue.js';
import type { ReportsStore } from './reports.js';
import type { SafetyStore } from './safety.js';
import type { SystemStore } from './system.js';

// The panels' modules (and the areas they read: alerts, copilot, cn/jobs,
// jobs/enrich, content safety) load on the first admin request, not when
// mountFeatures builds every router at startup.
const lazy = {
  costs: () => import('./costs.js'),
  feedback: () => import('./feedback.js'),
  queue: () => import('./queue.js'),
  reports: () => import('./reports.js'),
  safety: () => import('./safety.js'),
  system: () => import('./system.js'),
};

/** Test seams: every store defaults to its Prisma implementation. */
export interface AdminConsoleDeps extends FeatureRouterDeps {
  system?: SystemStore;
  queue?: QueueStore;
  costs?: CostStore;
  safety?: SafetyStore;
  reports?: ReportsStore;
  feedback?: FeedbackStore;
  audit?: AuditStore;
  overrides?: OverridesService;
  referrals?: ReferralModeration;
  now?: () => Date;
}

async function defaultOverrides(): Promise<OverridesService> {
  const { creditsAreaService } = await import('../credits/index.js');
  return creditsAreaService;
}

export function createAdminConsoleRouter(deps: AdminConsoleDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const env = deps.env ?? process.env;
  const now = () => (deps.now ?? (() => new Date()))();
  const audit = () => deps.audit ?? createPrismaAuditStore();
  const overrides = async () => deps.overrides ?? (await defaultOverrides());
  const adminId = (req: Request) => requireUserId(req);

  // ── System ─────────────────────────────────────────────────────────────
  router.get(
    '/system',
    ...admin,
    route(async (req) => {
      const q = parseQuery(req, SystemQuerySchema);
      const served = allowedBrands(env);
      const brands: BrandId[] = q.brand ? [q.brand] : served;
      const m = await lazy.system();
      return m.buildSystemStatus(deps.system ?? m.createPrismaSystemStore(), { brands, brandsServed: served, now: now(), env });
    }),
  );
  router.get(
    '/system/queue',
    ...admin,
    route(async (req) => {
      const m = await lazy.queue();
      return m.listWorkItems(deps.queue ?? m.createPrismaQueueStore(), parseQuery(req, QueueListQuerySchema));
    }),
  );
  router.post(
    '/system/queue/:id/retry',
    ...admin,
    route(async (req) => {
      const { id } = parseParams(req, WorkItemParamsSchema);
      const m = await lazy.queue();
      const result = await m.retryWorkItem(deps.queue ?? m.createPrismaQueueStore(), id);
      await writeAdminAudit(audit(), { adminId: adminId(req), eventType: ADMIN_AUDIT_EVENTS.workItemRetried, payload: { workItemId: id, kind: result.kind } });
      return { id: result.id, status: result.status };
    }),
  );

  // Admin actions, newest first (RAAdminAuditLog).
  router.get(
    '/system/audit',
    ...admin,
    route(async (req) => listAdminAudit(audit(), parseQuery(req, AdminAuditQuerySchema))),
  );

  // ── Costs (SKU × brand × day) ───────────────────────────────────────────
  router.get(
    '/costs',
    ...admin,
    route(async (req) => {
      const m = await lazy.costs();
      return m.getCosts(deps.costs ?? m.createPrismaCostStore(), parseQuery(req, CostsQuerySchema), now());
    }),
  );
  router.get(
    '/costs.csv',
    ...admin,
    route(async (req, res) => {
      const m = await lazy.costs();
      const data = await m.getCosts(deps.costs ?? m.createPrismaCostStore(), parseQuery(req, CostsQuerySchema), now());
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="costs-${data.from}-to-${data.to}.csv"`);
      res.send(m.costsCsv(data));
    }),
  );

  // ── Content safety (GoApply) ────────────────────────────────────────────
  router.get(
    '/safety',
    ...admin,
    route(async (req) => {
      const m = await lazy.safety();
      return m.getSafety(deps.safety ?? m.createPrismaSafetyStore(), parseQuery(req, SafetyQuerySchema), { now: now(), env });
    }),
  );

  // ── Reports to review ───────────────────────────────────────────────────
  router.get(
    '/reports',
    ...admin,
    route(async (req) => {
      const m = await lazy.reports();
      return m.listReports(deps.reports ?? m.createPrismaReportsStore(), parseQuery(req, ReportsQuerySchema));
    }),
  );
  router.post(
    '/reports/:id/resolve',
    ...admin,
    route(async (req) => {
      const { id } = parseParams(req, ReportParamsSchema);
      const body = parseBody(req, ResolveReportBodySchema);
      const m = await lazy.reports();
      return m.resolveReport({ store: deps.reports ?? m.createPrismaReportsStore(), audit: audit(), now }, id, body, adminId(req));
    }),
  );

  // ── Per-user overrides ──────────────────────────────────────────────────
  router.get(
    '/overrides',
    ...admin,
    route(async (req) => listAdminOverrides({ service: await overrides(), audit: audit() }, parseQuery(req, AdminOverridesQuerySchema))),
  );
  router.post(
    '/overrides',
    ...admin,
    route(async (req) => createAdminOverride({ service: await overrides(), audit: audit() }, parseBody(req, AdminCreateOverrideBodySchema), adminId(req)), { status: 201 }),
  );
  router.delete(
    '/overrides/:id',
    ...admin,
    route(async (req, res) => {
      const { id } = parseParams(req, OverrideParamsSchema);
      const { userId } = parseQuery(req, DeleteOverrideQuerySchema);
      await deleteAdminOverride({ service: await overrides(), audit: audit() }, id, adminId(req), userId);
      res.status(204).end();
    }),
  );

  // ── Referral-code moderation (GoApply; WP-54 service + audit row) ───────
  router.post(
    '/referrals/:id/moderate',
    ...admin,
    route(async (req) => {
      const { id } = parseParams(req, ReferralCodeParamsSchema);
      const body = parseBody(req, ModerateReferralCodeBodySchema);
      const referrals = deps.referrals ?? (await defaultReferralModeration());
      return moderateReferral({ referrals, audit: audit() }, id, body, adminId(req));
    }),
  );

  // ── Assistant feedback ──────────────────────────────────────────────────
  router.get(
    '/copilot-feedback',
    ...admin,
    route(async (req) => {
      const m = await lazy.feedback();
      return m.listAdminFeedback(deps.feedback ?? m.createPrismaFeedbackStore(), parseQuery(req, CopilotFeedbackQuerySchema));
    }),
  );

  return router;
}
