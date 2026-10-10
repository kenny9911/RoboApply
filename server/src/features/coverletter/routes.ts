// server/src/features/coverletter/routes.ts — cover letters router (WP-37; ARCH §3.6).
// Mounted by features/index.ts at /api/v1/roboapply/cover-letters (seeker session).
//
//   GET    /                  ?jobId&cursor → ListLettersResponse
//   POST   /                  CreateLetterBody → CoverLetterView        credit cover_letter (Idempotency-Key)
//   GET    /:id               → CoverLetterView
//   PATCH  /:id               PatchLetterBody → CoverLetterView
//   DELETE /:id               → { deleted: true }
//   POST   /:id/rewrite       { instruction } → CoverLetterView         20/day/letter
//   POST   /:id/regenerate    { tone?, length?, locale? } → CoverLetterView  credit cover_letter (Idempotency-Key)
//   POST   /:id/restore       { versionIndex } → CoverLetterView
//   GET    /:id/export        ?format=pdf|docx[&trackerEntryId] → the file
//
// The AI routes (create, regenerate, rewrite) also pass the GoApply
// "bind a phone first" gate (403 phone_binding_required, WP-11).

import { Router, type Request, type RequestHandler } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getRequestLocale } from '../../roboapply/v2/lib/raLocale.js';
import { parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import { requirePhoneBound } from '../auth-cn/index.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  CreateLetterBodySchema,
  ExportLetterQuerySchema,
  LetterParamsSchema,
  ListLettersQuerySchema,
  PatchLetterBodySchema,
  RegenerateLetterBodySchema,
  RestoreLetterBodySchema,
  RewriteLetterBodySchema,
} from './contract.js';
import type { CoverLetterService } from './service.js';

export interface CoverLetterRouterOptions {
  /** Test seam; defaults to the process-wide service. */
  service?: CoverLetterService;
  /** Test seam for the GoApply phone-binding gate. */
  phoneGate?: RequestHandler;
}

function idempotencyKey(req: Request): string | null {
  const key = req.get('Idempotency-Key')?.trim();
  return key && key.length <= 120 ? key : null;
}

export function createCoverLetterRouter(deps: FeatureRouterDeps = {}, options: CoverLetterRouterOptions = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const ai = [...auth, options.phoneGate ?? requirePhoneBound()];
  const svc = async (): Promise<CoverLetterService> => options.service ?? (await (await import('./index.js')).getCoverLetterService());

  router.get(
    '/',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const q = parseQuery(req, ListLettersQuerySchema);
      return (await svc()).list(userId, q);
    }),
  );

  router.post(
    '/',
    ...ai,
    route(
      async (req) => {
        const userId = requireUserId(req);
        const body = parseBody(req, CreateLetterBodySchema);
        return (await svc()).create(userId, body, { idempotencyKey: idempotencyKey(req), requestLocale: getRequestLocale(req) });
      },
      { status: 201 },
    ),
  );

  router.get(
    '/:id',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, LetterParamsSchema);
      return (await svc()).get(userId, id);
    }),
  );

  router.patch(
    '/:id',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, LetterParamsSchema);
      const body = parseBody(req, PatchLetterBodySchema);
      return (await svc()).patch(userId, id, body);
    }),
  );

  router.delete(
    '/:id',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, LetterParamsSchema);
      return (await svc()).remove(userId, id);
    }),
  );

  router.post(
    '/:id/rewrite',
    ...ai,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, LetterParamsSchema);
      const body = parseBody(req, RewriteLetterBodySchema);
      return (await svc()).rewrite(userId, id, body.instruction);
    }),
  );

  router.post(
    '/:id/regenerate',
    ...ai,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, LetterParamsSchema);
      const body = parseBody(req, RegenerateLetterBodySchema);
      return (await svc()).regenerate(userId, id, body, { idempotencyKey: idempotencyKey(req) });
    }),
  );

  router.post(
    '/:id/restore',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, LetterParamsSchema);
      const body = parseBody(req, RestoreLetterBodySchema);
      return (await svc()).restore(userId, id, body.versionIndex);
    }),
  );

  router.get(
    '/:id/export',
    ...auth,
    route(async (req, res) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, LetterParamsSchema);
      const query = parseQuery(req, ExportLetterQuerySchema);
      const file = await (await svc()).exportFile(userId, id, query);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', file.contentDisposition);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Sha256', file.sha256);
      res.status(200).send(file.buffer);
    }),
  );

  return router;
}
