// server/src/features/network/routes.ts — People at {company} router (WP-54; ARCH §3.7).
// Mounted by features/index.ts at /api/v1/roboapply/network (seeker session).
//
//   GET    /jobs/:id/connections                 → ConnectionsForJobResponse
//   GET    /imports/linkedin-connections         → ConnectionsImportStatus
//   POST   /imports/linkedin-connections         multipart `file` → ConnectionsImportResponse   mode `on`, 3/day
//   DELETE /imports/linkedin-connections         → { deleted }                                  every mode
//   GET    /contacts · POST /contacts · DELETE /contacts/:id                                    mode `on`
//   POST   /contacts/:id/lookup-email            501 provider_not_configured                    mode `on` + contactEmailLookup
//   GET    /outreach-drafts?jobId|trackerEntryId → { items }
//   POST   /outreach-drafts                      → OutreachDraftView     credit `outreach` (Idempotency-Key), AI gate
//   PATCH  /outreach-drafts/:id                  edit
//   POST   /outreach-drafts/:id/copied           the user copied it / opened it in their mail app
//   POST   /outreach-drafts/:id/sent             the user says they sent it
//
// There is no send route: the product never sends a message (D1).
// Gates run right after auth, before any body parsing, so a disabled route
// answers 404 feature_disabled without reading the upload.

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getRequestLocale } from '../../roboapply/v2/lib/raLocale.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { hiringContactsMode, loadUserFlagOverrides, requireFlag } from '../../platform/flags.js';
import { fail, HttpError, parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import { requirePhoneBound } from '../auth-cn/index.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  ContactParamsSchema,
  CreateContactBodySchema,
  CreateOutreachDraftBodySchema,
  DraftParamsSchema,
  LINKEDIN_IMPORT_FIELD,
  LINKEDIN_IMPORT_MAX_BYTES,
  ListContactsQuerySchema,
  ListOutreachDraftsQuerySchema,
  NETWORK_ERROR_CODES as E,
  NetworkJobParamsSchema,
  PatchOutreachDraftBodySchema,
} from './contract.js';
import type { NetworkService } from './service.js';

/** 404 feature_disabled unless the `hiringContacts` mode resolves to `on` for this brand and user. */
export function requireHiringContactsOn(env?: EnvSource): RequestHandler {
  return async function hiringContactsGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as Request & { user?: { id?: string } }).user?.id ?? null;
      const brand = (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();
      const mode = hiringContactsMode(brand, env ?? process.env, await loadUserFlagOverrides(userId));
      if (mode === 'on') {
        next();
        return;
      }
      fail(res, 'feature_disabled');
    } catch (err) {
      next(err);
    }
  };
}

export interface NetworkRouterOptions {
  /** Test seam; defaults to the process-wide service. */
  service?: NetworkService;
  /** Test seam for the GoApply phone-binding gate. */
  phoneGate?: RequestHandler;
}

function idempotencyKey(req: Request): string | null {
  const key = req.get('Idempotency-Key')?.trim();
  return key && key.length <= 120 ? key : null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LINKEDIN_IMPORT_MAX_BYTES, files: 1 },
});

/** Read the one CSV upload; multer errors become platform errors (never a 500). */
function csvUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single(LINKEDIN_IMPORT_FIELD)(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    const code = (err as { code?: string }).code;
    if (code === 'LIMIT_FILE_SIZE') {
      fail(res, 'invalid_request', 'This file is too large for a connections export.', { reason: E.fileTooLarge, maxBytes: LINKEDIN_IMPORT_MAX_BYTES });
      return;
    }
    fail(res, 'invalid_request', 'Upload one Connections.csv file.', { reason: E.fileMissing });
  });
}

function uploadedCsv(req: Request): { text: string; fileName: string } {
  const file = (req as Request & { file?: { buffer: Buffer; originalname: string; mimetype: string } }).file;
  if (!file || !file.buffer?.length) throw new HttpError('invalid_request', 'Upload one Connections.csv file.', { reason: E.fileMissing });
  const name = file.originalname ?? '';
  const csvLike = /\.csv$/i.test(name) || /csv|text\/plain|vnd\.ms-excel/i.test(file.mimetype ?? '');
  if (!csvLike) throw new HttpError('invalid_request', 'Upload the Connections.csv file from your LinkedIn data export.', { reason: E.badCsv });
  return { text: file.buffer.toString('utf8'), fileName: name };
}

export function createNetworkRouter(deps: FeatureRouterDeps = {}, options: NetworkRouterOptions = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const contacts = requireHiringContactsOn(deps.env);
  const lookup = requireFlag('contactEmailLookup', { env: deps.env });
  const ai = options.phoneGate ?? requirePhoneBound();
  const svc = async (): Promise<NetworkService> => options.service ?? (await (await import('./index.js')).getNetworkService());

  router.get(
    '/jobs/:id/connections',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, NetworkJobParamsSchema);
      return (await svc()).connectionsForJob(userId, id);
    }),
  );

  router.get(
    '/imports/linkedin-connections',
    ...auth,
    route(async (req) => (await svc()).importStatus(requireUserId(req))),
  );

  router.post(
    '/imports/linkedin-connections',
    ...auth,
    contacts,
    csvUpload,
    route(
      async (req) => {
        const userId = requireUserId(req);
        return (await svc()).importConnections(userId, uploadedCsv(req));
      },
      { status: 201 },
    ),
  );

  router.delete(
    '/imports/linkedin-connections',
    ...auth,
    route(async (req) => (await svc()).deleteImported(requireUserId(req))),
  );

  router.get(
    '/contacts',
    ...auth,
    contacts,
    route(async (req) => {
      const userId = requireUserId(req);
      return (await svc()).listContacts(userId, parseQuery(req, ListContactsQuerySchema));
    }),
  );

  router.post(
    '/contacts',
    ...auth,
    contacts,
    route(
      async (req) => {
        const userId = requireUserId(req);
        return (await svc()).createContact(userId, parseBody(req, CreateContactBodySchema));
      },
      { status: 201 },
    ),
  );

  router.delete(
    '/contacts/:id',
    ...auth,
    contacts,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, ContactParamsSchema);
      return (await svc()).deleteContact(userId, id);
    }),
  );

  router.post(
    '/contacts/:id/lookup-email',
    ...auth,
    contacts,
    lookup,
    route(async (req) => {
      requireUserId(req);
      parseParams(req, ContactParamsSchema);
      return (await svc()).lookupEmail();
    }),
  );

  router.get(
    '/outreach-drafts',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      return (await svc()).listDrafts(userId, parseQuery(req, ListOutreachDraftsQuerySchema));
    }),
  );

  router.post(
    '/outreach-drafts',
    ...auth,
    ai,
    route(
      async (req) => {
        const userId = requireUserId(req);
        const body = parseBody(req, CreateOutreachDraftBodySchema);
        return (await svc()).createDraft(userId, body, { idempotencyKey: idempotencyKey(req), requestLocale: getRequestLocale(req) });
      },
      { status: 201 },
    ),
  );

  router.patch(
    '/outreach-drafts/:id',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, DraftParamsSchema);
      return (await svc()).patchDraft(userId, id, parseBody(req, PatchOutreachDraftBodySchema));
    }),
  );

  router.post(
    '/outreach-drafts/:id/copied',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, DraftParamsSchema);
      return (await svc()).markCopied(userId, id);
    }),
  );

  router.post(
    '/outreach-drafts/:id/sent',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, DraftParamsSchema);
      return (await svc()).markSent(userId, id);
    }),
  );

  return router;
}
