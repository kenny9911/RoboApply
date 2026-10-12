// server/src/features/auth-cn/adminRoutes.ts — admin invite codes (WP-11).
//
// Mounted at /api/v1/roboapply/admin/auth-cn behind requireAuth + requireAdmin.
//   GET  /invites   newest first, `?status=active|used|expired&cursor=`
//   POST /invites   creates codes for the request's brand; the raw codes are
//                   in this response only (stored hashed).
//
// Invite codes exist only for a mainland-market brand (GoApply). They are
// asked for at sign-up only with `CN_SIGNUP_MODE=invite`; the default is open. On any other host both routes answer 404 feature_disabled (R-04).

import { Router, type Request } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { getCurrentBrandOrDefault, type BrandedRequest } from '../../platform/brand/brandContext.js';
import { HttpError, parseBody, parseQuery } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { CreateInvitesBodySchema, ListInvitesQuerySchema, type InviteView } from './contract.js';
import { cnRoute } from './errors.js';
import { createAuthCnServices, type AuthCnServices } from './services.js';

/** The request's brand id; 404 feature_disabled unless it is a mainland-market brand. */
function brandIdOf(req: Request) {
  const brand = (req as Partial<BrandedRequest>).brand ?? getCurrentBrandOrDefault();
  if (brand.market !== 'cn') throw new HttpError('feature_disabled');
  return brand.id;
}

export function createAuthCnAdminRouter(deps: FeatureRouterDeps = {}, overrides?: Partial<AuthCnServices>): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  let svc: AuthCnServices | null = null;
  const s = () => (svc ??= { ...createAuthCnServices({ env: deps.env, ...(overrides?.db ? { db: overrides.db } : {}) }), ...overrides });

  router.get(
    '/invites',
    ...admin,
    cnRoute(async (req): Promise<{ items: InviteView[]; cursor: string | null }> => {
      const brand = brandIdOf(req);
      return s().invites.list(brand, parseQuery(req, ListInvitesQuerySchema));
    }),
  );

  router.post(
    '/invites',
    ...admin,
    cnRoute(
      async (req): Promise<{ items: InviteView[] }> => {
        const brand = brandIdOf(req);
        const body = parseBody(req, CreateInvitesBodySchema);
        const adminId = (req as Request & { user?: { id?: string } }).user?.id ?? null;
        return s().invites.create(brand, adminId, body);
      },
      { status: 201 },
    ),
  );

  return router;
}
