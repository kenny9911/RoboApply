// server/src/features/prep/adminRoutes.ts — question-bank moderation (WP-59).
// Mounted by features/index.ts at /api/v1/roboapply/admin/prep (admin only).
// Scoped to the current brand's market.
//
//   GET  /contributions?status&cursor          shared questions to review (oldest first)
//   POST /contributions/:id/approve            publish as a user report (staff pick a category,
//                                              may tidy the wording; flagged text needs confirmScreened)
//   POST /contributions/:id/reject             { reason, note? } — e.g. test content under NDA or copyright
//   GET  /questions?filter=reported|hidden|curated&cursor
//   POST /questions/:id/hide · /questions/:id/restore
//   POST /questions                            a staff-written practice question (never names a company)

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  AdminQuestionsQuerySchema,
  ApproveContributionBodySchema,
  ContributionParamsSchema,
  CreateCuratedQuestionBodySchema,
  ModerationQueueQuerySchema,
  QuestionParamsSchema,
  RejectContributionBodySchema,
} from './contract.js';
import type { PrepService } from './service.js';

export interface PrepAdminRouterOptions {
  /** Test seam; defaults to the process-wide service. */
  service?: PrepService;
}

export function createPrepAdminRouter(deps: FeatureRouterDeps = {}, options: PrepAdminRouterOptions = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const svc = async (): Promise<PrepService> => options.service ?? (await (await import('./index.js')).getPrepService());

  router.get(
    '/contributions',
    ...admin,
    route(async (req) => {
      const q = parseQuery(req, ModerationQueueQuerySchema);
      return (await svc()).listContributions(q);
    }),
  );

  router.post(
    '/contributions/:id/approve',
    ...admin,
    route(async (req) => {
      const adminId = requireUserId(req);
      const { id } = parseParams(req, ContributionParamsSchema);
      const body = parseBody(req, ApproveContributionBodySchema);
      return (await svc()).approve(adminId, id, body);
    }),
  );

  router.post(
    '/contributions/:id/reject',
    ...admin,
    route(async (req) => {
      const adminId = requireUserId(req);
      const { id } = parseParams(req, ContributionParamsSchema);
      const body = parseBody(req, RejectContributionBodySchema);
      return (await svc()).reject(adminId, id, body);
    }),
  );

  router.get(
    '/questions',
    ...admin,
    route(async (req) => {
      const q = parseQuery(req, AdminQuestionsQuerySchema);
      return (await svc()).adminQuestions(q);
    }),
  );

  router.post(
    '/questions/:id/hide',
    ...admin,
    route(async (req) => {
      const { id } = parseParams(req, QuestionParamsSchema);
      return (await svc()).setQuestionStatus(id, 'hidden');
    }),
  );

  router.post(
    '/questions/:id/restore',
    ...admin,
    route(async (req) => {
      const { id } = parseParams(req, QuestionParamsSchema);
      return (await svc()).setQuestionStatus(id, 'published');
    }),
  );

  router.post(
    '/questions',
    ...admin,
    route(
      async (req) => {
        const body = parseBody(req, CreateCuratedQuestionBodySchema);
        return (await svc()).createCurated(body);
      },
      { status: 201 },
    ),
  );

  return router;
}
