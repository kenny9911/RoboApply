// server/src/features/resume/routes.ts — resume suite router (FND-5 seam).
// Owners: WP-22 (check, fixes, keyword report) → WP-36a/36b (tailor
// sessions, layout) → WP-65.
//
// Mounted by features/index.ts at /api/v1/roboapply/v2/resumes AFTER the
// legacy V2 router, so every existing /v2/resumes path keeps its handler.
// Only new paths are declared here; none collides with a legacy pattern
// (legacy: '/', '/upload', '/import-linkedin*', '/:id', '/:id/{primary,
// original-file,export,rewrite,tailor-diff,tailor-apply,coach-tips}').
//
// WP-22 routes (ARCH §3.6):
//   POST /:id/grade                     { targetTitle? } → GradeStartResponse   (credit resume_check for the AI pass)
//   GET  /:id/grade/latest              → LatestGradeResponse
//   POST /grades/:gradeId/cancel        → CancelGradeResponse                  (releases the reserved credit)
//   POST /:id/issues/:issueId/fix       { variant, instruction? } → FixIssueResponse (credit rewrite; 503 ai_unavailable without AI consent)
//   POST /:id/issues/:issueId/apply     { text } → ApplyFixResponse
//   POST /:id/keyword-report            { jobId } | { jd } → KeywordReportResponse (deterministic; free)
// Credit-spending routes read the client's `Idempotency-Key` header.

import { Router, type Request, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getRequestLocale } from '../../roboapply/v2/lib/raLocale.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  ApplyFixBodySchema,
  ClaimParamsSchema,
  CreateTailorSessionBodySchema,
  FixIssueBodySchema,
  GradeBodySchema,
  GradeParamsSchema,
  IssueParamsSchema,
  KeywordReportBodySchema,
  PatchLayoutBodySchema,
  ResumeIdParamsSchema,
  TailorSessionParamsSchema,
  UpdateClaimBodySchema,
} from './contract.js';
import type { ResumeCheckService } from './ResumeCheckService.js';

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

export interface ResumeSuiteRouterOptions {
  /** Test seam; defaults to the process-wide service (lazily built). */
  service?: ResumeCheckService;
}

function idempotencyKey(req: Request): string | null {
  const key = req.get('Idempotency-Key')?.trim();
  return key && key.length <= 120 ? key : null;
}

export function createResumeSuiteRouter(deps: FeatureRouterDeps = {}, options: ResumeSuiteRouterOptions = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const rid = { params: ResumeIdParamsSchema };
  const svc = async (): Promise<ResumeCheckService> => options.service ?? (await import('./index.js')).getResumeCheckService();

  // Tailor sessions first (literal segment before the :id patterns). WP-36a.
  router.post('/tailor-sessions', ...auth, stub('resume.createTailorSession', { body: CreateTailorSessionBodySchema }));
  router.get('/tailor-sessions/:id', ...auth, stub('resume.getTailorSession', { params: TailorSessionParamsSchema }));
  router.patch('/tailor-sessions/:id/claims/:claimId', ...auth, stub('resume.updateClaim', { params: ClaimParamsSchema, body: UpdateClaimBodySchema }));
  router.post('/tailor-sessions/:id/finalize', ...auth, stub('resume.finalizeTailor', { params: TailorSessionParamsSchema }));

  router.post(
    '/grades/:gradeId/cancel',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { gradeId } = parseParams(req, GradeParamsSchema);
      return (await svc()).cancel(userId, gradeId);
    }),
  );

  router.post(
    '/:id/grade',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, ResumeIdParamsSchema);
      const body = parseBody(req, GradeBodySchema);
      return (await svc()).grade(userId, id, { targetTitle: body.targetTitle, idempotencyKey: idempotencyKey(req), locale: getRequestLocale(req) });
    }),
  );

  router.get(
    '/:id/grade/latest',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, ResumeIdParamsSchema);
      return (await svc()).latest(userId, id);
    }),
  );

  router.post(
    '/:id/issues/:issueId/fix',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id, issueId } = parseParams(req, IssueParamsSchema);
      const body = parseBody(req, FixIssueBodySchema);
      return (await svc()).fixIssue(userId, id, issueId, {
        variant: body.variant,
        instruction: body.instruction,
        idempotencyKey: idempotencyKey(req),
        locale: getRequestLocale(req),
      });
    }),
  );

  router.post(
    '/:id/issues/:issueId/apply',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id, issueId } = parseParams(req, IssueParamsSchema);
      const body = parseBody(req, ApplyFixBodySchema);
      return (await svc()).applyFix(userId, id, issueId, body.text);
    }),
  );

  router.post(
    '/:id/keyword-report',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, ResumeIdParamsSchema);
      const body = parseBody(req, KeywordReportBodySchema);
      return (await svc()).keywordReport(userId, id, body);
    }),
  );

  // WP-36b.
  router.patch('/:id/layout', ...auth, stub('resume.layout', { ...rid, body: PatchLayoutBodySchema }));

  return router;
}
