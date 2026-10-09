// server/src/features/extension/routes.ts — STUB (FND-5). Owner: WP-55a.
//
// Mounted by features/index.ts:
//   createExtensionRouter()       at /api/v1/roboapply/ext
//   createExtensionPublicRouter() at /api/v1/public/ext
//
// Device routes use `requireExtensionDevice`. Until WP-55a implements the
// token check (hash → RAExtensionDevice, brand match, lastSeenAt), the stub
// answers 401 without a `Bearer rax_…` token and 501 with one: no device
// route can be reached with a session cookie alone.

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag, type FlagKey } from '../../platform/flags.js';
import { fail, markStub, notImplemented, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  AnswerQuestionBodySchema,
  CreateAutofillRunBodySchema,
  CreateDeviceBodySchema,
  DeviceParamsSchema,
  EXT_TOKEN_RE,
  FileTokenParamsSchema,
  PageJobBodySchema,
  PatchAutofillRunBodySchema,
  RedeemPairCodeBodySchema,
  ResumeForJobBodySchema,
  RunParamsSchema,
  SaveJobBodySchema,
  SiteRequestBodySchema,
  UninstallSurveyBodySchema,
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

/** Stub device auth: 401 without a `Bearer rax_…` token; 501 with one (WP-55a fills it). */
export function requireExtensionDevice(req: Request, res: Response, _next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!EXT_TOKEN_RE.test(token)) {
    fail(res, 'unauthorized', 'Extension device token required.');
    return;
  }
  notImplemented(res, 'Extension device authentication');
}

export function createExtensionRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const session = [...(deps.seekerAuth ?? seekerAuth)];
  const device = [...(deps.extensionAuth ?? [requireExtensionDevice])];
  const flag = (key: FlagKey) => requireFlag(key, { env: deps.env });
  const ext = flag('extension');
  const autofill = flag('ext.autofill');

  // Session (web app) routes: pairing and device management.
  router.post('/devices', ...session, ext, stub('ext.createDevice', { body: CreateDeviceBodySchema }));
  router.get('/devices', ...session, ext, stub('ext.listDevices'));
  router.delete('/devices/:id', ...session, ext, stub('ext.revokeDevice', { params: DeviceParamsSchema }));
  router.post('/pair-codes', ...session, ext, stub('ext.createPairCode'));
  // Public: the extension popup redeems a code (10/h/IP).
  router.post('/pair-codes/redeem', ext, stub('ext.redeemPairCode', { body: RedeemPairCodeBodySchema }));

  // Device routes.
  router.get('/me', ...device, ext, stub('ext.me'));
  router.get('/autofill-profile', ...device, ext, autofill, stub('ext.autofillProfile'));
  router.post('/page-job', ...device, ext, stub('ext.pageJob', { body: PageJobBodySchema }));
  router.post('/jobs/save', ...device, ext, stub('ext.saveJob', { body: SaveJobBodySchema }));
  router.post('/autofill-runs', ...device, ext, autofill, stub('ext.createRun', { body: CreateAutofillRunBodySchema }));
  router.patch('/autofill-runs/:id', ...device, ext, autofill, stub('ext.patchRun', { params: RunParamsSchema, body: PatchAutofillRunBodySchema }));
  router.post('/answers', ...device, ext, autofill, stub('ext.answer', { body: AnswerQuestionBodySchema }));
  router.post('/resume-for-job', ...device, ext, autofill, stub('ext.resumeForJob', { body: ResumeForJobBodySchema }));
  router.get('/files/:signedToken', ...device, ext, stub('ext.file', { params: FileTokenParamsSchema }));
  router.post('/site-requests', ...device, ext, stub('ext.siteRequest', { body: SiteRequestBodySchema }));

  return router;
}

export function createExtensionPublicRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  router.post('/uninstall-survey', requireFlag('extension', { env: deps.env }), stub('ext.uninstallSurvey', { body: UninstallSurveyBodySchema }));
  return router;
}
