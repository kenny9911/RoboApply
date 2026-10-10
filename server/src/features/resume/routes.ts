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
//   GET  /:id/grade/latest[?opened=1]   → LatestGradeResponse                  (opened=1, sent by the report page only: stamps viewedAt on a finished check, first view only)
//   POST /grades/:gradeId/cancel        → CancelGradeResponse                  (releases the reserved credit)
//   POST /:id/issues/:issueId/fix       { variant, instruction? } → FixIssueResponse (credit rewrite; 503 ai_unavailable without AI consent)
//   POST /:id/issues/:issueId/apply     { text } → ApplyFixResponse           (AI text lands in the resume: stamps aiAssistedAt once)
//   POST /:id/keyword-report            { jobId } | { jd } → KeywordReportResponse (deterministic; free)
// WP-36a routes (tailor sessions; ruling C12):
//   POST  /tailor-sessions                      CreateTailorSessionBody → TailorSessionView (credit tailor; Idempotency-Key;
//                                               503 ai_unavailable without AI consent; GoApply WeChat accounts
//                                               without a phone → 403 phone_binding_required)
//   GET   /tailor-sessions/:id                  → TailorSessionView
//   PATCH /tailor-sessions/:id/claims/:claimId  { status, text? } → TailorSessionView (Verify details)
//   POST  /tailor-sessions/:id/finalize         → TailorSessionView; 409 unverified_claims { pending }
// WP-36b / WP-65 layout (the legacy router answers PATCH /:id/layout first; this
// twin uses the same LayoutService and response shape):
//   PATCH /:id/layout                   { layout } → { resume }
//   POST  /:id/fit-to-page              { pages: 1|2, photo? } → FitToPageResponse (spacing, margins, sizes only)
// WP-65 guided builder (declared before the :id patterns):
//   GET   /builder/config               → BuilderConfigView
//   POST  /builder/suggest              BuilderSuggestBody → BuilderSuggestResponse (credit rewrite;
//                                       503 ai_unavailable without AI consent; GoApply phone gate)
//   POST  /builder                      BuilderDraft → BuilderCreateResponse (409 resume_limit_reached)
// Credit-spending routes read the client's `Idempotency-Key` header.

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getRequestLocale } from '../../roboapply/v2/lib/raLocale.js';
import { parseBody, parseParams, requireUserId, route } from '../../platform/http.js';
import { AuthCnError, requirePhoneBound } from '../auth-cn/index.js';
import type { FeatureRouterDeps } from '../index.js';
import { defaultPageFor } from '../../roboapply/v2/lib/resumeExport.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import {
  ApplyFixBodySchema,
  BuilderDraftSchema,
  BuilderSuggestBodySchema,
  ClaimParamsSchema,
  FitToPageBodySchema,
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
import type { BuilderService } from './builder/BuilderService.js';
import type { LayoutService } from './layout/LayoutService.js';

/** The visitor's country from the edge (Vercel), when present. */
function requestCountry(req: Request): string | null {
  const raw = req.headers['x-vercel-ip-country'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null;
}

/** Letter or A4 for this request when the resume sets none (same rule as the legacy router). */
export function requestDefaultPage(req: Request): 'letter' | 'a4' {
  return defaultPageFor({ market: getCurrentBrandOrDefault().market, country: requestCountry(req), locale: getRequestLocale(req) });
}

export interface ResumeSuiteRouterOptions {
  /** Test seam; defaults to the process-wide service (lazily built). */
  service?: ResumeCheckService;
  /** Test seam; defaults to the process-wide tailor service. */
  tailor?: TailorService;
  /** Test seam for the GoApply phone-binding gate (defaults to auth-cn `requirePhoneBound()`). */
  phoneGate?: RequestHandler;
  /** Test seam; defaults to the process-wide builder service (WP-65). */
  builder?: BuilderService;
  /** Test seam; defaults to the process-wide layout service (WP-65). */
  layout?: LayoutService;
  /** Test seam: the hub view of a variant after a layout save (defaults to RAResumeService.getById). */
  loadView?: (userId: string, id: string) => Promise<Record<string, unknown>>;
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
  const svc = async (): Promise<ResumeCheckService> => options.service ?? (await import('./index.js')).getResumeCheckService();

  const tailor = async (): Promise<TailorService> => options.tailor ?? (await import('./index.js')).getTailorService();
  const phoneGate = options.phoneGate ?? requirePhoneBound();
  const builder = async (): Promise<BuilderService> => options.builder ?? (await import('./index.js')).getBuilderService();
  const layouts = async (): Promise<LayoutService> => options.layout ?? (await import('./index.js')).getLayoutService();
  const loadView =
    options.loadView ??
    (async (userId: string, id: string) => {
      const { loadLegacyResumeModule } = await import('./legacyResumeService.js');
      return (await loadLegacyResumeModule()).raResumeService.getById(userId, id);
    });

  // Guided builder first (literal segments before the :id patterns). WP-65.
  router.get(
    '/builder/config',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      return (await builder()).config(userId, { locale: getRequestLocale(req), page: requestDefaultPage(req) });
    }),
  );
  router.post(
    '/builder/suggest',
    ...auth,
    phoneGate,
    route(async (req) => {
      const userId = requireUserId(req);
      const body = parseBody(req, BuilderSuggestBodySchema);
      return (await builder()).suggest(userId, body, { idempotencyKey: idempotencyKey(req) });
    }),
  );
  router.post(
    '/builder',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const body = parseBody(req, BuilderDraftSchema);
      return (await builder()).create(userId, body, { locale: getRequestLocale(req) });
    }),
  );

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
      // Only the report page sends `?opened=1` (the owner has the finished
      // check on screen): that stamps RAResumeGrade.viewedAt once. The editor
      // summary, the tailor flow and the onboarding dock read this endpoint
      // too, and must not count as opening the check.
      return (await svc()).latest(userId, id, { opened: req.query.opened === '1' });
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

  // WP-36b layout, WP-65 keys (the legacy router answers first; same service).
  router.patch(
    '/:id/layout',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, ResumeIdParamsSchema);
      const body = parseBody(req, PatchLayoutBodySchema);
      await (await layouts()).patch(userId, id, body.layout as Record<string, unknown>);
      const resume = await loadView(userId, id);
      return { resume: { ...resume, defaultPage: requestDefaultPage(req) } };
    }),
  );

  // WP-65: fit to one page (GoApply: up to 2). Spacing, margins and sizes only.
  router.post(
    '/:id/fit-to-page',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, ResumeIdParamsSchema);
      const body = parseBody(req, FitToPageBodySchema);
      return (await layouts()).fit(userId, id, {
        pages: body.pages,
        photo: body.photo === true,
        defaultPage: requestDefaultPage(req),
        locale: getRequestLocale(req),
      });
    }),
  );

  return router;
}
