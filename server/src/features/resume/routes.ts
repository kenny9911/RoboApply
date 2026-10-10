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
// WP-36a routes (tailor sessions; ruling C12):
//   POST  /tailor-sessions                      CreateTailorSessionBody → TailorSessionView (credit tailor; Idempotency-Key;
//                                               503 ai_unavailable without AI consent; GoApply WeChat accounts
//                                               without a phone → 403 phone_binding_required)
//   GET   /tailor-sessions/:id                  → TailorSessionView
//   PATCH /tailor-sessions/:id/claims/:claimId  { status, text? } → TailorSessionView (Verify details)
//   POST  /tailor-sessions/:id/finalize         → TailorSessionView; 409 unverified_claims { pending }
// Credit-spending routes read the client's `Idempotency-Key` header.

import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getRequestLocale } from '../../roboapply/v2/lib/raLocale.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import { AuthCnError, requirePhoneBound } from '../auth-cn/index.js';
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
import { UnverifiedClaimsError, type TailorService } from './tailor/TailorService.js';

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
  /** Test seam; defaults to the process-wide tailor service. */
  tailor?: TailorService;
  /** Test seam for the GoApply phone-binding gate (defaults to auth-cn `requirePhoneBound()`). */
  phoneGate?: RequestHandler;
}

/**
 * `route()` plus the 409 `unverified_claims` envelope (not a platform code;
 * ARCH §3.6, ruling C12) and the auth-cn 403 `phone_binding_required` that
 * TailorService.create raises itself (the seam is gated, not only this route).
 */
function tailorRoute<T>(handler: (req: Request, res: Response) => Promise<T>): RequestHandler {
  return route(async (req, res) => {
    try {
      return await handler(req, res);
    } catch (err) {
      if (err instanceof UnverifiedClaimsError) {
        res.status(err.status).json({ success: false, code: err.code, error: err.message, details: err.details });
        return undefined;
      }
      if (err instanceof AuthCnError) {
        res.status(err.status).json({ success: false, code: err.code, error: err.message, ...(err.details ? { details: err.details } : {}) });
        return undefined;
      }
      throw err;
    }
  });
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

  const tailor = async (): Promise<TailorService> => options.tailor ?? (await import('./index.js')).getTailorService();
  const phoneGate = options.phoneGate ?? requirePhoneBound();

  // Tailor sessions first (literal segment before the :id patterns). WP-36a.
  router.post(
    '/tailor-sessions',
    ...auth,
    phoneGate,
    tailorRoute(async (req) => {
      const userId = requireUserId(req);
      const body = parseBody(req, CreateTailorSessionBodySchema);
      return (await tailor()).create(userId, body, { idempotencyKey: idempotencyKey(req), locale: getRequestLocale(req) });
    }),
  );
  router.get(
    '/tailor-sessions/:id',
    ...auth,
    tailorRoute(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, TailorSessionParamsSchema);
      return (await tailor()).get(userId, id);
    }),
  );
  router.patch(
    '/tailor-sessions/:id/claims/:claimId',
    ...auth,
    tailorRoute(async (req) => {
      const userId = requireUserId(req);
      const { id, claimId } = parseParams(req, ClaimParamsSchema);
      const body = parseBody(req, UpdateClaimBodySchema);
      return (await tailor()).updateClaim(userId, id, claimId, body);
    }),
  );
  router.post(
    '/tailor-sessions/:id/finalize',
    ...auth,
    tailorRoute(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, TailorSessionParamsSchema);
      return (await tailor()).finalize(userId, id, { locale: getRequestLocale(req) });
    }),
  );

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
