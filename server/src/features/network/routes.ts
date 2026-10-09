// server/src/features/network/routes.ts — STUB (FND-5). Owner: WP-54.
//
// Mounted by features/index.ts at /api/v1/roboapply/network.
// Contact routes (/contacts*) require the `hiringContacts` mode to be `on`
// (`hiringContactsGate`, per route); email lookup additionally needs
// `contactEmailLookup`. Connections (deep links) and drafts are not gated.

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { hiringContactsMode, loadUserFlagOverrides, requireFlag } from '../../platform/flags.js';
import { fail, markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  ContactParamsSchema,
  CreateContactBodySchema,
  CreateOutreachDraftBodySchema,
  DraftParamsSchema,
  ListContactsQuerySchema,
  NetworkJobParamsSchema,
  PatchOutreachDraftBodySchema,
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

export function createNetworkRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const contacts = requireHiringContactsOn(deps.env);
  const lookup = requireFlag('contactEmailLookup', { env: deps.env });

  router.get('/jobs/:id/connections', ...auth, stub('network.connectionsForJob', { params: NetworkJobParamsSchema }));

  router.post('/imports/linkedin-connections', ...auth, stub('network.importConnections'));
  router.delete('/imports/linkedin-connections', ...auth, stub('network.deleteImportedConnections'));

  router.get('/contacts', ...auth, contacts, stub('network.listContacts', { query: ListContactsQuerySchema }));
  router.post('/contacts', ...auth, contacts, stub('network.createContact', { body: CreateContactBodySchema }));
  router.delete('/contacts/:id', ...auth, contacts, stub('network.deleteContact', { params: ContactParamsSchema }));
  router.post('/contacts/:id/lookup-email', ...auth, contacts, lookup, stub('network.lookupEmail', { params: ContactParamsSchema }));

  router.post('/outreach-drafts', ...auth, stub('network.createDraft', { body: CreateOutreachDraftBodySchema }));
  router.patch('/outreach-drafts/:id', ...auth, stub('network.patchDraft', { params: DraftParamsSchema, body: PatchOutreachDraftBodySchema }));
  router.post('/outreach-drafts/:id/copied', ...auth, stub('network.draftCopied', { params: DraftParamsSchema }));
  router.post('/outreach-drafts/:id/sent', ...auth, stub('network.draftSent', { params: DraftParamsSchema }));

  return router;
}
