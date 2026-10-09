// server/src/features/coverletter/routes.ts — STUB (FND-5). Owner: WP-37.
// Mounted by features/index.ts at /api/v1/roboapply/cover-letters (seeker session).

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  CreateLetterBodySchema,
  ExportLetterQuerySchema,
  LetterParamsSchema,
  ListLettersQuerySchema,
  PatchLetterBodySchema,
  RestoreLetterBodySchema,
  RewriteLetterBodySchema,
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

export function createCoverLetterRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const p = { params: LetterParamsSchema };

  router.get('/', ...auth, stub('coverLetter.list', { query: ListLettersQuerySchema }));
  router.post('/', ...auth, stub('coverLetter.create', { body: CreateLetterBodySchema }));
  router.get('/:id', ...auth, stub('coverLetter.get', p));
  router.patch('/:id', ...auth, stub('coverLetter.patch', { ...p, body: PatchLetterBodySchema }));
  router.delete('/:id', ...auth, stub('coverLetter.delete', p));
  router.post('/:id/rewrite', ...auth, stub('coverLetter.rewrite', { ...p, body: RewriteLetterBodySchema }));
  router.post('/:id/restore', ...auth, stub('coverLetter.restore', { ...p, body: RestoreLetterBodySchema }));
  router.get('/:id/export', ...auth, stub('coverLetter.export', { ...p, query: ExportLetterQuerySchema }));

  return router;
}
