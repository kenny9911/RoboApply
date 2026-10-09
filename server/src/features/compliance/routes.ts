// server/src/features/compliance/routes.ts — compliance routers (WP-13).
//
// Mounted by features/index.ts:
//   createComplianceRouter()       at /api/v1/roboapply/compliance (seeker)
//     GET  /disclosures             AI models, processors, filings
//     GET  /retention               the published retention schedule
//     GET  /consents                consent catalog + the user's answers (?locale)
//     POST /consents                record a grant/withdrawal (prose hash stored)
//     GET  /pi-requests             the user's personal-information requests
//     POST /pi-requests             file one (copy/portability start an export)
//     POST /export                  start a data export
//     GET  /exports/:id/download    the finished export file (owner only)
//   createLegalPublicRouter()      at /api/v1/public/legal (no session)
//     GET  /footer, /disclosures, /retention, /consents (catalog only), /:doc
//   createComplianceAdminRouter()  at /api/v1/roboapply/admin/compliance
//     GET  /pi-requests  (?status, ?overdue, ?cursor)    PATCH /pi-requests/:id
//
// No capability flag: legal surfaces exist on every brand and deployment.

import { Router, type Request } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/index.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { clampLocaleToBrand } from '../../platform/brand/registry.js';
import { parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  AdminPiRequestParamsSchema,
  AdminPiRequestsQuerySchema,
  AdminUpdatePiRequestBodySchema,
  ConsentsQuerySchema,
  CreatePiRequestBodySchema,
  ExportDownloadParamsSchema,
  LegalDocQuerySchema,
  RecordConsentBodySchema,
} from './contract.js';
import {
  consentDefinitionsFor,
  isConsentApplicable,
  isConsentRequired,
  listConsents,
  recordConsent,
  resolveConsentProse,
  type ConsentContext,
} from './consents.js';
import { readExportForOwner, requestDataExport } from './dataExport.js';
import { buildDisclosures, buildLegalFooter } from './disclosures.js';
import { loadLegalDoc } from './legalDocs.js';
import { adminListPiRequests, adminUpdatePiRequest, createPiRequest, listUserPiRequests, toPiRequestView } from './piRequests.js';
import { retentionSchedule } from './retention.js';
import { z } from 'zod';

const COUNTRY_HEADERS = ['x-vercel-ip-country', 'cf-ipcountry'];

function requestCountry(req: Request): string | null {
  for (const h of COUNTRY_HEADERS) {
    const v = req.get(h);
    if (v && /^[a-z]{2}$/i.test(v.trim())) return v.trim().toUpperCase();
  }
  return null;
}

function localeFor(req: Request, brand: ProductBrand, asked?: string): string {
  const profileLocale = (req as Request & { seekerProfile?: { locale?: string | null } }).seekerProfile?.locale ?? null;
  return clampLocaleToBrand(brand, asked ?? profileLocale ?? brand.defaultLocale);
}

function consentCtx(req: Request, brand: ProductBrand, locale: string, env?: FeatureRouterDeps['env']): ConsentContext {
  return { env: env ?? process.env, country: requestCountry(req), locale };
}

export function createComplianceRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const env = deps.env ?? process.env;

  router.get('/disclosures', ...auth, route(async () => buildDisclosures(getCurrentBrandOrDefault(), env)));
  router.get('/retention', ...auth, route(async () => ({ items: retentionSchedule(env) })));

  router.get(
    '/consents',
    ...auth,
    route(async (req) => {
      const q = parseQuery(req, ConsentsQuerySchema);
      const brand = getCurrentBrandOrDefault();
      const locale = localeFor(req, brand, q.locale);
      return { items: await listConsents(requireUserId(req), brand, consentCtx(req, brand, locale, env), { env }) };
    }),
  );

  router.post(
    '/consents',
    ...auth,
    route(async (req) => {
      const body = parseBody(req, RecordConsentBodySchema);
      const brand = getCurrentBrandOrDefault();
      return recordConsent(
        {
          userId: requireUserId(req),
          brand,
          type: body.type,
          granted: body.granted,
          proseVersion: body.proseVersion,
          locale: localeFor(req, brand, body.locale),
          country: requestCountry(req),
        },
        { env },
      );
    }),
  );

  router.get('/pi-requests', ...auth, route(async (req) => ({ items: await listUserPiRequests(requireUserId(req)), cursor: null })));

  router.post(
    '/pi-requests',
    ...auth,
    route(
      async (req) => {
        const body = parseBody(req, CreatePiRequestBodySchema);
        const userId = requireUserId(req);
        const brand = getCurrentBrandOrDefault();
        if (body.kind === 'copy' || body.kind === 'portability') {
          const started = await requestDataExport(userId, brand.id, {}, body.kind);
          const rows = await listUserPiRequests(userId);
          const view = rows.find((r) => r.id === started.requestId);
          if (view) return view;
        }
        const row = await createPiRequest({ userId, brand: brand.id, kind: body.kind, userNote: body.detail });
        return toPiRequestView(row);
      },
      { status: 201 },
    ),
  );

  router.post(
    '/export',
    ...auth,
    route(async (req) => requestDataExport(requireUserId(req), getCurrentBrandOrDefault().id), { status: 202 }),
  );

  router.get(
    '/exports/:id/download',
    ...auth,
    route(async (req, res) => {
      const { id } = parseParams(req, ExportDownloadParamsSchema);
      const file = await readExportForOwner(requireUserId(req), id);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).send(file.buffer);
    }),
  );

  return router;
}

const PUBLIC_CACHE = 'public, max-age=300';

export function createLegalPublicRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const env = deps.env ?? process.env;

  router.get(
    '/footer',
    route(async (_req, res) => {
      res.setHeader('Cache-Control', PUBLIC_CACHE);
      return buildLegalFooter(getCurrentBrandOrDefault(), env);
    }),
  );
  router.get(
    '/disclosures',
    route(async (_req, res) => {
      res.setHeader('Cache-Control', PUBLIC_CACHE);
      return buildDisclosures(getCurrentBrandOrDefault(), env);
    }),
  );
  router.get(
    '/retention',
    route(async (_req, res) => {
      res.setHeader('Cache-Control', PUBLIC_CACHE);
      return { items: retentionSchedule(env) };
    }),
  );
  // Signup / onboarding screens show the prose before an account exists.
  router.get(
    '/consents',
    route(async (req) => {
      const q = parseQuery(req, ConsentsQuerySchema);
      const brand = getCurrentBrandOrDefault();
      const locale = clampLocaleToBrand(brand, q.locale ?? brand.defaultLocale);
      const ctx = consentCtx(req, brand, locale, env);
      const items = consentDefinitionsFor(brand.id)
        .filter((d) => d.stage === 'signup' && isConsentApplicable(d, ctx))
        .map((d) => {
          const prose = resolveConsentProse(d, brand, locale);
          return {
            type: d.type,
            required: isConsentRequired(d, ctx),
            stage: d.stage,
            control: d.control,
            withdrawable: d.withdrawable,
            onWithdraw: d.onWithdraw,
            defaultGranted: false as const,
            prose: prose.text,
            proseVersion: prose.version,
            proseHash: prose.hash,
            proseLocale: prose.locale,
            granted: null,
            answeredAt: null,
          };
        });
      return { items };
    }),
  );
  router.get(
    '/:doc',
    route(async (req, res) => {
      // Aliases (`agreement`, `personal-info-list`, …) resolve inside loadLegalDoc;
      // validate the slug shape here, the catalog there.
      const { doc } = parseParams(req, z.object({ doc: z.string().regex(/^[a-z0-9-]{1,40}$/) }));
      const q = parseQuery(req, LegalDocQuerySchema);
      const result = loadLegalDoc(getCurrentBrandOrDefault(), doc, { env, locale: q.locale });
      res.setHeader('Cache-Control', result.draft ? 'no-store' : PUBLIC_CACHE);
      return result;
    }),
  );
  return router;
}

export function createComplianceAdminRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];

  router.get(
    '/pi-requests',
    ...admin,
    route(async (req) => {
      const q = parseQuery(req, AdminPiRequestsQuerySchema);
      return adminListPiRequests({ status: q.status, overdue: q.overdue === 'true', cursor: q.cursor });
    }),
  );
  router.patch(
    '/pi-requests/:id',
    ...admin,
    route(async (req) => {
      const { id } = parseParams(req, AdminPiRequestParamsSchema);
      const body = parseBody(req, AdminUpdatePiRequestBodySchema);
      return adminUpdatePiRequest(id, body, { id: requireUserId(req) });
    }),
  );
  return router;
}
