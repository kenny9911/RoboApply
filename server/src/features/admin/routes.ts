// server/src/features/admin/routes.ts — STUB (FND-5). Owner: WP-74.
// Mounted by features/index.ts at /api/v1/roboapply/admin (admin only; per-route auth,
// so other areas' /admin/<area> routers are unaffected).

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  AdminCreateOverrideBodySchema,
  AdminOverridesQuerySchema,
  CopilotFeedbackQuerySchema,
  OverrideParamsSchema,
  QueueListQuerySchema,
  ReportParamsSchema,
  ReportsQuerySchema,
  ResolveReportBodySchema,
  WorkItemParamsSchema,
} from './contract.js';

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

export function createAdminConsoleRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];

  router.get('/system', ...admin, stub('admin.system'));
  router.get('/system/queue', ...admin, stub('admin.queue', { query: QueueListQuerySchema }));
  router.post('/system/queue/:id/retry', ...admin, stub('admin.retryWorkItem', { params: WorkItemParamsSchema }));

  router.get('/reports', ...admin, stub('admin.reports', { query: ReportsQuerySchema }));
  router.post('/reports/:id/resolve', ...admin, stub('admin.resolveReport', { params: ReportParamsSchema, body: ResolveReportBodySchema }));

  router.get('/overrides', ...admin, stub('admin.overrides', { query: AdminOverridesQuerySchema }));
  router.post('/overrides', ...admin, stub('admin.createOverride', { body: AdminCreateOverrideBodySchema }));
  router.delete('/overrides/:id', ...admin, stub('admin.deleteOverride', { params: OverrideParamsSchema }));

  router.get('/copilot-feedback', ...admin, stub('admin.copilotFeedback', { query: CopilotFeedbackQuerySchema }));

  return router;
}
