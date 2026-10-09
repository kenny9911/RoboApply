// server/src/features/resume/routes.ts — STUB (FND-5). Owners: WP-22 → WP-36a/36b → WP-65.
//
// Mounted by features/index.ts at /api/v1/roboapply/v2/resumes AFTER the
// legacy V2 router, so every existing /v2/resumes path keeps its handler.
// Only new paths are declared here; none collides with a legacy pattern
// (legacy: '/', '/upload', '/import-linkedin*', '/:id', '/:id/{primary,
// original-file,export,rewrite,tailor-diff,tailor-apply,coach-tips}').

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
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

export function createResumeSuiteRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const rid = { params: ResumeIdParamsSchema };

  // Tailor sessions first (literal segment before the :id patterns).
  router.post('/tailor-sessions', ...auth, stub('resume.createTailorSession', { body: CreateTailorSessionBodySchema }));
  router.get('/tailor-sessions/:id', ...auth, stub('resume.getTailorSession', { params: TailorSessionParamsSchema }));
  router.patch('/tailor-sessions/:id/claims/:claimId', ...auth, stub('resume.updateClaim', { params: ClaimParamsSchema, body: UpdateClaimBodySchema }));
  router.post('/tailor-sessions/:id/finalize', ...auth, stub('resume.finalizeTailor', { params: TailorSessionParamsSchema }));

  router.post('/grades/:gradeId/cancel', ...auth, stub('resume.cancelGrade', { params: GradeParamsSchema }));

  router.post('/:id/grade', ...auth, stub('resume.grade', { ...rid, body: GradeBodySchema }));
  router.get('/:id/grade/latest', ...auth, stub('resume.latestGrade', rid));
  router.post('/:id/issues/:issueId/fix', ...auth, stub('resume.fixIssue', { params: IssueParamsSchema, body: FixIssueBodySchema }));
  router.post('/:id/keyword-report', ...auth, stub('resume.keywordReport', { ...rid, body: KeywordReportBodySchema }));
  router.patch('/:id/layout', ...auth, stub('resume.layout', { ...rid, body: PatchLayoutBodySchema }));

  return router;
}
