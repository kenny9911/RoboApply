// server/src/features/prep/routes.ts — the question bank (WP-59; ARCH §3.9).
// Mounted by features/index.ts at /api/v1/roboapply/interview-bank (seeker
// session). Capability `interviewBank` on every route (404 feature_disabled
// when off). The moderation router lives in adminRoutes.ts.
//
//   GET  /companies?q&cursor                       companies with moderated user reports (+ counts)
//   GET  /companies/:slug/questions?category&…     user reports about one company
//   GET  /questions?category&cursor                staff-written practice questions in the request
//                                                  language (English when there are none in it)
//   GET  /questions/:id                            one question (+ guide when written)
//   POST /questions/:id/guide                      write the AI guide (first view; 30/day)       AI
//   POST /questions/:id/report                     report a question (10/day)
//   POST /contributions                            share a question you were asked (10/day)    phone gate
//   GET  /jobs/:jobId/questions                    the AI set for a job + company reports (no model call)
//   POST /jobs/:jobId/questions                    write the AI set for a job (10/day)        AI
//
// AI routes pass the GoApply "bind a phone first" gate (403
// phone_binding_required, WP-11), and answer 503 ai_unavailable when the
// user's AI consent or the brand's text model is off (zero model calls).
// Sharing a question publishes user text after moderation, so it needs a
// bound phone on GoApply too.

import { Router, type RequestHandler } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getRequestLocale } from '../../roboapply/v2/lib/raLocale.js';
import { requireFlag } from '../../platform/flags.js';
import { parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import { requirePhoneBound } from '../auth-cn/index.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  CompaniesQuerySchema,
  CompanyQuestionsQuerySchema,
  CompanySlugParamsSchema,
  ContributionBodySchema,
  CuratedQuestionsQuerySchema,
  JobParamsSchema,
  QuestionParamsSchema,
  ReportQuestionBodySchema,
} from './contract.js';
import type { PrepService } from './service.js';

export interface InterviewBankRouterOptions {
  /** Test seam; defaults to the process-wide service. */
  service?: PrepService;
  /** Test seam for the GoApply phone-binding gate. */
  phoneGate?: RequestHandler;
}

export function createInterviewBankRouter(deps: FeatureRouterDeps = {}, options: InterviewBankRouterOptions = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('interviewBank', { env: deps.env });
  const bound = [...auth, on, options.phoneGate ?? requirePhoneBound()];
  const svc = async (): Promise<PrepService> => options.service ?? (await (await import('./index.js')).getPrepService());

  router.get(
    '/companies',
    ...auth,
    on,
    route(async (req) => {
      requireUserId(req);
      const q = parseQuery(req, CompaniesQuerySchema);
      return (await svc()).listCompanies(q);
    }),
  );

  router.get(
    '/companies/:slug/questions',
    ...auth,
    on,
    route(async (req) => {
      requireUserId(req);
      const { slug } = parseParams(req, CompanySlugParamsSchema);
      const q = parseQuery(req, CompanyQuestionsQuerySchema);
      return (await svc()).companyQuestions(slug, q);
    }),
  );

  router.get(
    '/questions',
    ...auth,
    on,
    route(async (req) => {
      requireUserId(req);
      const q = parseQuery(req, CuratedQuestionsQuerySchema);
      return (await svc()).curatedQuestions(q, getRequestLocale(req));
    }),
  );

  router.get(
    '/questions/:id',
    ...auth,
    on,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, QuestionParamsSchema);
      return (await svc()).getQuestion(userId, id);
    }),
  );

  router.post(
    '/questions/:id/guide',
    ...bound,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, QuestionParamsSchema);
      return (await svc()).generateGuide(userId, id, getRequestLocale(req));
    }),
  );

  router.post(
    '/questions/:id/report',
    ...auth,
    on,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, QuestionParamsSchema);
      const body = parseBody(req, ReportQuestionBodySchema);
      return (await svc()).report(userId, id, body);
    }),
  );

  router.post(
    '/contributions',
    ...bound,
    route(
      async (req) => {
        const userId = requireUserId(req);
        const body = parseBody(req, ContributionBodySchema);
        return (await svc()).contribute(userId, body);
      },
      { status: 201 },
    ),
  );

  router.get(
    '/jobs/:jobId/questions',
    ...auth,
    on,
    route(async (req) => {
      const userId = requireUserId(req);
      const { jobId } = parseParams(req, JobParamsSchema);
      return (await svc()).jobSet(userId, jobId, getRequestLocale(req));
    }),
  );

  router.post(
    '/jobs/:jobId/questions',
    ...bound,
    route(async (req) => {
      const userId = requireUserId(req);
      const { jobId } = parseParams(req, JobParamsSchema);
      return (await svc()).generateJobSet(userId, jobId, getRequestLocale(req));
    }),
  );

  return router;
}
