// server/src/features/tools/routes.ts — free tools without an account (WP-57).
// Mounted by features/index.ts at /api/v1/public/tools (public: no route
// requires a session; the claim reads an optional one and answers 401 without).
//
//   GET  /config                  ToolsConfigView
//   POST /resume-check            multipart `resume` (+ `consent` on GoApply) → ResumeCheckReport
//   POST /resume-job-match        multipart `resume`, `postingTitle`, `postingText` (+ `consent`) → ResumeJobMatchReport
//   GET  /results/:id             the short view again (24 h, same browser)
//   POST /results/:id/claim       signed in, same browser → ClaimToolResultResponse
//
// A run sets (or refreshes) the HttpOnly visitor cookie; result reads and the
// claim pass it to the service, which answers 404 without the cookie of the
// browser that ran the check. Both result routes are rate-limited per IP.

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { buildCookieOptions } from '../../lib/cookieOptions.js';
import { optionalAuth } from '../../middleware/auth.js';
import { HOUR, clientIp, rateLimit } from '../../platform/ratelimit/index.js';
import { HttpError, fail, parseParams, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  TOOLS_ERROR_REASONS,
  TOOLS_LIMITS,
  TOOLS_UPLOAD_FIELDS,
  TOOLS_VISITOR_COOKIE,
  TOOLS_VISITOR_COOKIE_PATH,
  ToolResultParamsSchema,
  type ToolKind,
} from './contract.js';
import { getToolsService } from './defaultService.js';
import { isVisitorId, newVisitorId, type ToolsService, type UploadedFile } from './service.js';

/** Result reads and claims per IP (GET /results/:id + POST /results/:id/claim): cheap index lookups, but unauthenticated. */
export const RESULT_LOOKUPS_PER_IP = [{ limit: 60, windowSec: HOUR }] as const;
export const RESULT_LOOKUPS_KEY_NAME = 'publicToolResultsPerIp';

/** The visitor cookie of this request, or null. */
export function visitorOf(req: Request): string | null {
  const v = (req as Request & { cookies?: Record<string, unknown> }).cookies?.[TOOLS_VISITOR_COOKIE];
  return isVisitorId(v) ? v : null;
}

/** The visitor cookie of this request, minting one when missing; (re)set for 24 h either way. */
function ensureVisitor(req: Request, res: Response): string {
  const visitor = visitorOf(req) ?? newVisitorId();
  res.cookie(
    TOOLS_VISITOR_COOKIE,
    visitor,
    buildCookieOptions(req, { httpOnly: true, sameSite: 'lax', path: TOOLS_VISITOR_COOKIE_PATH, maxAge: TOOLS_LIMITS.cacheHours * 3600_000 }),
  );
  return visitor;
}

/** Longest a run may take before the parse is abandoned (the route answers 422 file_unreadable). */
export const RUN_TIMEOUT_MS = 80_000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TOOLS_LIMITS.maxFileBytes, files: 1, fields: 8, fieldSize: 256 * 1024 },
});

/** Multer errors → the platform envelope (422 with a reason). Nothing touches disk. */
function readUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single(TOOLS_UPLOAD_FIELDS.resume)(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    const code = (err as { code?: string }).code;
    if (code === 'LIMIT_FILE_SIZE') {
      fail(res, 'invalid_request', 'The file is larger than 15 MB.', { reason: TOOLS_ERROR_REASONS.tooLarge });
      return;
    }
    fail(res, 'invalid_request', 'The upload could not be read.', { reason: TOOLS_ERROR_REASONS.missingFile });
  });
}

function uploadedFile(req: Request): UploadedFile | null {
  const f = (req as Request & { file?: Express.Multer.File }).file;
  return f ? { buffer: f.buffer, originalname: f.originalname, mimetype: f.mimetype, size: f.size } : null;
}

/** Abort the parse when the visitor goes away (the response closes unfinished) or the run overstays. */
function abortOnClose(res: Response): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      res.off('close', onClose);
    },
  };
}

export interface ToolsRouterOverrides {
  service?: ToolsService;
  /** Per-IP guard on the result routes (tests). Default: the platform limiter, RESULT_LOOKUPS_PER_IP. */
  resultLookupLimit?: RequestHandler;
}

export function createToolsPublicRouter(deps: FeatureRouterDeps = {}, overrides: ToolsRouterOverrides = {}): Router {
  const router = Router();
  const maybeAuth: RequestHandler[] = [...(deps.optionalAuth ?? [optionalAuth])];
  const service = () => overrides.service ?? getToolsService();
  const lookupLimit =
    overrides.resultLookupLimit ?? rateLimit({ name: RESULT_LOOKUPS_KEY_NAME, windows: RESULT_LOOKUPS_PER_IP, by: 'ip', failMode: 'open' });

  const run = (kind: ToolKind) =>
    route(async (req, res) => {
      const abort = abortOnClose(res);
      try {
        return await service().run(kind, {
          ip: clientIp(req),
          visitor: ensureVisitor(req, res),
          file: uploadedFile(req),
          fields: (req.body ?? {}) as Record<string, unknown>,
          requestId: (req as Request & { requestId?: string }).requestId,
          signal: abort.signal,
        });
      } finally {
        abort.done();
      }
    });

  router.get(
    '/config',
    route(async (req) => service().config(clientIp(req))),
  );
  router.post('/resume-check', readUpload, run('resume_check'));
  router.post('/resume-job-match', readUpload, run('resume_job_match'));
  router.get(
    '/results/:id',
    lookupLimit,
    route(async (req) => {
      const { id } = parseParams(req, ToolResultParamsSchema);
      return service().getResult(id, visitorOf(req));
    }),
  );
  router.post(
    '/results/:id/claim',
    lookupLimit,
    ...maybeAuth,
    route(async (req) => {
      const user = (req as Request & { user?: { id?: string; brand?: string | null } }).user;
      if (!user?.id) throw new HttpError('unauthorized', 'Sign in to keep this resume.');
      const { id } = parseParams(req, ToolResultParamsSchema);
      return service().claim({ id: user.id, brand: user.brand ?? null }, id, visitorOf(req));
    }),
  );

  return router;
}
