// server/src/features/extension/routes.ts — the extension API (WP-55a;
// ARCHITECTURE.md §3.8, §6).
//
// Mounted by features/index.ts:
//   createExtensionRouter()       at /api/v1/roboapply/ext
//   createExtensionPublicRouter() at /api/v1/public/ext
//
// Session routes (the web app):        POST/GET /devices, DELETE /devices/:id,
//                                      GET /status, POST /pair-codes
// Public (the extension popup):        POST /pair-codes/redeem (10/h/IP)
// Device routes (Bearer rax_…):        GET /me, GET /autofill-profile,
//   POST /page-job, POST /jobs/save, POST /autofill-runs,
//   PATCH /autofill-runs/:id, POST /answers, POST /resume-for-job,
//   GET /files/:signedToken, POST /site-requests
// Order on every route: auth → capability (`extension`, plus `ext.autofill`
// on the autofill routes) → rate limit → handler.

import { Router, type Request, type RequestHandler } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag, type FlagKey } from '../../platform/flags.js';
import { DAY, HOUR, RATE_LIMITS, rateLimit, type RateLimitDb, type RateWindow } from '../../platform/ratelimit/index.js';
import { HttpError, parseBody, parseParams, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { createRequireExtensionDevice, type ExtRequest } from './auth.js';
import {
  AnswerQuestionBodySchema,
  CreateAutofillRunBodySchema,
  CreateDeviceBodySchema,
  DeviceParamsSchema,
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
import { createPrismaExtensionRepo, type ExtensionRepo } from './repository.js';
import { createExtensionService, type ExtensionService } from './service.js';
import { registerSupportedAtsTypes } from './supported.js';

/** Abuse guards of this area (ARCHITECTURE.md §3.8); per-user credit caps are separate. */
export const EXT_RATE_LIMITS = {
  extDeviceCreate: [{ limit: 5, windowSec: DAY }],
  extPairCode: [{ limit: 10, windowSec: HOUR }],
  extPairRedeemPerIp: [{ limit: 10, windowSec: HOUR }],
  extPageJob: [{ limit: 120, windowSec: DAY }],
  extSaveJob: [{ limit: 100, windowSec: DAY }],
  extSiteRequest: [{ limit: 10, windowSec: DAY }],
  extUninstallSurveyPerIp: [{ limit: 5, windowSec: DAY }],
  extensionDevice: RATE_LIMITS.extensionDevice,
} as const satisfies Record<string, readonly RateWindow[]>;

export interface ExtensionRouterDeps extends FeatureRouterDeps {
  service?: ExtensionService;
  /** Rate-limit counters (tests pass an in-memory double). */
  rateLimitDb?: RateLimitDb;
}

let defaultRepo: ExtensionRepo | null = null;
const repo = (): ExtensionRepo => (defaultRepo ??= createPrismaExtensionRepo());

let defaultService: ExtensionService | null = null;
async function productionService(): Promise<ExtensionService> {
  if (!defaultService) {
    const { defaultExtensionDeps } = await import('./defaultDeps.js');
    defaultService = createExtensionService(defaultExtensionDeps());
  }
  return defaultService;
}

/** Device auth: `Bearer rax_…` → the paired device's owner (auth.ts). */
export const requireExtensionDevice: RequestHandler = createRequireExtensionDevice({ repo });

function limit(name: keyof typeof EXT_RATE_LIMITS, by: 'user' | 'ip', db?: RateLimitDb): RequestHandler {
  return rateLimit({ name, windows: EXT_RATE_LIMITS[name], by, ...(db ? { db } : {}) });
}

function idempotencyKey(req: Request): string | null {
  const v = req.get('Idempotency-Key');
  return v && v.trim() ? v.trim().slice(0, 200) : null;
}

function deviceId(req: Request): string {
  const id = (req as ExtRequest).extDevice?.id;
  if (!id) throw new HttpError('unauthorized', 'Extension device token required.');
  return id;
}

/** The public origin of this API, as the extension reached it. */
function apiOrigin(req: Request): string {
  const host = req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host') || 'localhost';
  const proto = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol || 'https';
  return `${proto}://${host}`;
}

/** RFC 6266 attachment header with an ASCII fallback and the UTF-8 name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function createExtensionRouter(deps: ExtensionRouterDeps = {}): Router {
  registerSupportedAtsTypes();
  const router = Router();
  const session = [...(deps.seekerAuth ?? seekerAuth)];
  const deviceLimit = rateLimit({
    name: 'extensionDevice',
    windows: EXT_RATE_LIMITS.extensionDevice,
    key: (req) => (req as ExtRequest).extDevice?.id ?? null,
    ...(deps.rateLimitDb ? { db: deps.rateLimitDb } : {}),
  });
  const device = [...(deps.extensionAuth ?? [requireExtensionDevice])];
  const flag = (key: FlagKey) => requireFlag(key, { env: deps.env });
  const ext = flag('extension');
  const autofill = flag('ext.autofill');
  const svc = async (): Promise<ExtensionService> => deps.service ?? (await productionService());
  const lim = (name: keyof typeof EXT_RATE_LIMITS, by: 'user' | 'ip' = 'user') => limit(name, by, deps.rateLimitDb);

  // ── Session (web app): pairing and device management ──────────────────
  router.post(
    '/devices',
    ...session,
    ext,
    lim('extDeviceCreate'),
    route(async (req) => (await svc()).createDevice(requireUserId(req), parseBody(req, CreateDeviceBodySchema)), { status: 201 }),
  );
  router.get(
    '/devices',
    ...session,
    ext,
    route(async (req) => ({ items: await (await svc()).listDevices(requireUserId(req)), cursor: null })),
  );
  router.get('/status', ...session, ext, route(async (req) => (await svc()).status(requireUserId(req))));
  router.delete(
    '/devices/:id',
    ...session,
    ext,
    route(async (req, res) => {
      const { id } = parseParams(req, DeviceParamsSchema);
      await (await svc()).revokeDevice(requireUserId(req), id);
      res.status(204).end();
    }),
  );
  router.post('/pair-codes', ...session, ext, lim('extPairCode'), route(async (req) => (await svc()).createPairCode(requireUserId(req)), { status: 201 }));

  // ── Public: the extension popup redeems a code ─────────────────────────
  router.post(
    '/pair-codes/redeem',
    ext,
    lim('extPairRedeemPerIp', 'ip'),
    route(async (req) => (await svc()).redeemPairCode(parseBody(req, RedeemPairCodeBodySchema)), { status: 201 }),
  );

  // ── Device routes ──────────────────────────────────────────────────────
  router.get('/me', ...device, ext, deviceLimit, route(async (req) => (await svc()).me(requireUserId(req))));
  router.get('/autofill-profile', ...device, ext, autofill, deviceLimit, route(async (req) => (await svc()).autofillProfile(requireUserId(req))));
  // Fit runs only when the user clicks "Check fit" in the extension (never on page load).
  router.post(
    '/page-job',
    ...device,
    ext,
    deviceLimit,
    lim('extPageJob'),
    route(async (req) => (await svc()).pageJob(requireUserId(req), parseBody(req, PageJobBodySchema))),
  );
  router.post(
    '/jobs/save',
    ...device,
    ext,
    deviceLimit,
    lim('extSaveJob'),
    route(async (req) => (await svc()).saveJob(requireUserId(req), parseBody(req, SaveJobBodySchema), idempotencyKey(req)), { status: 201 }),
  );
  router.post(
    '/autofill-runs',
    ...device,
    ext,
    autofill,
    deviceLimit,
    route(async (req) => (await svc()).createRun(requireUserId(req), deviceId(req), parseBody(req, CreateAutofillRunBodySchema), idempotencyKey(req)), { status: 201 }),
  );
  router.patch(
    '/autofill-runs/:id',
    ...device,
    ext,
    autofill,
    deviceLimit,
    route(async (req) => {
      const { id } = parseParams(req, RunParamsSchema);
      return (await svc()).patchRun(requireUserId(req), id, parseBody(req, PatchAutofillRunBodySchema));
    }),
  );
  router.post(
    '/answers',
    ...device,
    ext,
    autofill,
    deviceLimit,
    route(async (req) => (await svc()).answer(requireUserId(req), parseBody(req, AnswerQuestionBodySchema), idempotencyKey(req))),
  );
  router.post(
    '/resume-for-job',
    ...device,
    ext,
    autofill,
    deviceLimit,
    route(async (req) => (await svc()).resumeForJob(requireUserId(req), parseBody(req, ResumeForJobBodySchema), apiOrigin(req))),
  );
  router.get(
    '/files/:signedToken',
    ...device,
    ext,
    deviceLimit,
    route(async (req, res) => {
      const { signedToken } = parseParams(req, FileTokenParamsSchema);
      const file = await (await svc()).file(requireUserId(req), signedToken);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', contentDisposition(file.fileName));
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).end(file.buffer);
    }),
  );
  router.post(
    '/site-requests',
    ...device,
    ext,
    deviceLimit,
    lim('extSiteRequest'),
    route(async (req, res) => {
      await (await svc()).siteRequest(requireUserId(req), parseBody(req, SiteRequestBodySchema));
      res.status(204).end();
    }),
  );

  return router;
}

export function createExtensionPublicRouter(deps: ExtensionRouterDeps = {}): Router {
  const router = Router();
  const svc = async (): Promise<ExtensionService> => deps.service ?? (await productionService());
  router.post(
    '/uninstall-survey',
    requireFlag('extension', { env: deps.env }),
    limit('extUninstallSurveyPerIp', 'ip', deps.rateLimitDb),
    route(async (req, res) => {
      await (await svc()).uninstallSurvey(parseBody(req, UninstallSurveyBodySchema));
      res.status(204).end();
    }),
  );
  return router;
}
