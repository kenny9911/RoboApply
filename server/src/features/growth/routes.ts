// server/src/features/growth/routes.ts — seeker and admin routers of the growth area.
//
//   createGrowthRouter (WP-23) at /api/v1/roboapply/growth — getting-started checklist:
//     GET  /checklist          → ChecklistView (also: a friend who joined with an
//                                invite link gets their invite checked, WP-60)
//     POST /checklist/dismiss  → ChecklistView (the card stays hidden)
//     Read and dismiss only: steps complete solely through
//     `markChecklistStep()` on the server (WP-34, WP-36a, WP-43). Answers 404
//     feature_disabled while the checklist table (SR-23-1) is not available.
//
//   createInvitesRouter (WP-60) at /api/v1/roboapply/invites — invite friends
//   (seeker; capability `invites` per route, separate from GoApply's `cn.referralCodes`):
//     GET  /         → InvitesResponse (creates the code once the account is verified)
//     POST /shared   { channel } → { ok } (notes the inviter's browser for the risk check;
//                    rate limited per user: INVITE_SHARED_LIMITS, 429 rate_limited)
//     Nothing here sends a message: the person shares the link themselves
//     (copy, the device share sheet, their own mail app, WeChat).
//
//   createInvitesAdminRouter (WP-60) — held invite rewards (mounted at /admin/growth/referrals).
//
// The public events router lives in publicRoutes.ts.

import { Router, type Request } from 'express';
import { waitUntil } from '@vercel/functions';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { getCurrentBrand } from '../../platform/brand/index.js';
import { requireFlag } from '../../platform/flags.js';
import { parseBody, parseParams, requireUserId, route } from '../../platform/http.js';
import { HOUR, MINUTE, clientIp, rateLimit, type RateLimitDb, type RateWindow } from '../../platform/ratelimit/index.js';
import type { FeatureRouterDeps } from '../index.js';
import { InviteSharedBodySchema, ReferralReviewBodySchema, ReferralReviewParamsSchema, type InviteSharedResponse } from './contract.js';
import { ANON_ID_COOKIE } from './events.js';
import type { RawSignals } from './referralRisk.js';
import { referralServiceImpl, type ReferralService } from './referrals.js';
import { growthServiceImpl, type GrowthService } from './service.js';

/** What this request says about the browser and network (hashed before storage). */
export function requestSignals(req: Request): RawSignals {
  const ua = req.headers['user-agent'];
  const anon = (req.cookies as Record<string, unknown> | undefined)?.[ANON_ID_COOKIE];
  return {
    ip: clientIp(req),
    userAgent: typeof ua === 'string' ? ua : null,
    deviceId: typeof anon === 'string' ? anon : null,
  };
}

/** Run after the response on Vercel (`waitUntil`), in-process elsewhere. Never throws. */
function afterResponse(work: Promise<unknown>): void {
  const safe = work.catch(() => undefined);
  try {
    waitUntil(safe);
  } catch {
    // Not inside a Vercel request context: the promise already runs.
  }
}

export interface GrowthRouterDeps extends FeatureRouterDeps {
  service?: Pick<GrowthService, 'getChecklist' | 'dismissChecklist'>;
  referrals?: Pick<ReferralService, 'noteActivity'>;
}

export function createGrowthRouter(deps: GrowthRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const service = deps.service ?? growthServiceImpl;
  const referrals = deps.referrals ?? referralServiceImpl;

  router.get(
    '/checklist',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      // A friend who joined with an invite link (or an inviter whose friends
      // are still being checked): note this visit and check whether an invite
      // reward is due (never blocks the card).
      afterResponse(referrals.noteActivity(userId, { brand: getCurrentBrand().id, signals: requestSignals(req) }));
      return service.getChecklist(userId);
    }),
  );
  router.post('/checklist/dismiss', ...auth, route(async (req) => service.dismissChecklist(requireUserId(req))));

  return router;
}

/** POST /invites/shared per user: 10/min, 60/h (a person shares a few times; spam cannot grow the signal table). */
export const INVITE_SHARED_LIMITS: readonly RateWindow[] = [
  { limit: 10, windowSec: MINUTE },
  { limit: 60, windowSec: HOUR },
];

export interface InvitesRouterDeps extends FeatureRouterDeps {
  referrals?: Pick<ReferralService, 'getInvites' | 'noteShared' | 'noteActivity'>;
  /** RARateCounter for the share limit (tests pass an in-memory one). */
  rateLimitDb?: RateLimitDb;
}

export function createInvitesRouter(deps: InvitesRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('invites', { env: deps.env });
  const referrals = deps.referrals ?? referralServiceImpl;
  const sharedLimit = rateLimit({
    name: 'inviteSharedPerUser',
    by: 'user',
    windows: INVITE_SHARED_LIMITS,
    ...(deps.rateLimitDb ? { db: deps.rateLimitDb } : {}),
  });

  router.get(
    '/',
    ...auth,
    on,
    route(async (req) => {
      const userId = requireUserId(req);
      const ctx = { brand: getCurrentBrand().id, signals: requestSignals(req) };
      afterResponse(referrals.noteActivity(userId, ctx));
      return referrals.getInvites(userId, ctx);
    }),
  );
  router.post(
    '/shared',
    ...auth,
    on,
    sharedLimit,
    route(async (req): Promise<InviteSharedResponse> => {
      parseBody(req, InviteSharedBodySchema);
      await referrals.noteShared(requireUserId(req), { brand: getCurrentBrand().id, signals: requestSignals(req) });
      return { ok: true };
    }),
  );

  return router;
}

export interface InvitesAdminRouterDeps extends FeatureRouterDeps {
  referrals?: Pick<ReferralService, 'listHeld' | 'reviewReferral'>;
}

/**
 * Held invite rewards for staff review. Mount requested from INT:
 *   { id: 'growth.referrals.admin', area: 'growth', path: a('/growth/referrals'), kind: 'admin', owner: 'WP-60', build: createInvitesAdminRouter }
 *   GET  /held           → HeldReferralsResponse (this brand, oldest first)
 *   POST /:id/review     { decision: 'approve' | 'reject' } → ReferralReviewResponse
 */
export function createInvitesAdminRouter(deps: InvitesAdminRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const referrals = deps.referrals ?? referralServiceImpl;

  router.get('/held', ...admin, route(async () => ({ items: await referrals.listHeld(getCurrentBrand().id) })));
  router.post(
    '/:id/review',
    ...admin,
    route(async (req) => {
      const { id } = parseParams(req, ReferralReviewParamsSchema);
      const { decision } = parseBody(req, ReferralReviewBodySchema);
      return referrals.reviewReferral(id, decision, getCurrentBrand().id);
    }),
  );
  return router;
}
