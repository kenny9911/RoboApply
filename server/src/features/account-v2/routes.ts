// server/src/features/account-v2/routes.ts — Account V2 routers (WP-79).
//
// Mounted by features/index.ts:
//   createTwoFactorRouter() at /api/v1/roboapply/account/2fa     (capability `totp`)
//   createStudentRouter()   at /api/v1/roboapply/account/student (capability `student`)
//
// Order on every route: session → capability → (rate limit) → handler, so a
// signed-out caller gets 401 and a disabled capability 404 before anything
// is counted or read.

import { Router, type Request, type RequestHandler } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getCurrentBrand } from '../../platform/brand/brandContext.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { requireFlag } from '../../platform/flags.js';
import { parseBody, requireUserId, route } from '../../platform/http.js';
import { rateLimit, MINUTE } from '../../platform/ratelimit/index.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  RegenerateRecoveryBodySchema,
  StudentEmailConfirmBodySchema,
  StudentEmailSendBodySchema,
  TotpDisableBodySchema,
  TotpVerifyBodySchema,
} from './contract.js';
import { StudentService, defaultStudentDeps } from './student.js';
import { TwoFactorService, defaultTwoFactorDeps, type SecondFactor } from './twoFactor.js';

export interface AccountV2RouterDeps extends FeatureRouterDeps {
  twoFactor?: TwoFactorService;
  student?: StudentService;
  /** false = no rate limiting (route tests). */
  rateLimits?: false;
}

let defaultTwoFactor: TwoFactorService | null = null;
let defaultStudent: StudentService | null = null;

export function twoFactorServiceInstance(): TwoFactorService {
  defaultTwoFactor ??= new TwoFactorService(defaultTwoFactorDeps());
  return defaultTwoFactor;
}

export function studentServiceInstance(): StudentService {
  defaultStudent ??= new StudentService(defaultStudentDeps());
  return defaultStudent;
}

function brandOf(req: Request): ProductBrand {
  return (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrand();
}

function sessionTokenOf(req: Request): string | null {
  const token = (req as Request & { sessionToken?: unknown }).sessionToken;
  return typeof token === 'string' && token ? token : null;
}

function localeOf(req: Request): string | null {
  const header = req.get('x-robo-locale');
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.robo_locale;
  return (header && header.trim()) || (cookie && cookie.trim()) || null;
}

/** 10 code checks per 15 minutes per user (enrol confirm, disable, new recovery codes). */
const CODE_CHECK_WINDOWS = [{ limit: 10, windowSec: 15 * MINUTE }] as const;

export function createTwoFactorRouter(deps: AccountV2RouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('totp', { env: deps.env });
  const svc = () => deps.twoFactor ?? twoFactorServiceInstance();
  const codeLimit: RequestHandler[] =
    deps.rateLimits === false ? [] : [rateLimit({ name: 'totpCodePerUser', windows: CODE_CHECK_WINDOWS, by: 'user', failMode: 'closed' })];

  router.get('/', ...auth, on, route(async (req) => svc().status(requireUserId(req), brandOf(req))));

  router.post(
    '/enrol',
    ...auth,
    on,
    route(async (req) => {
      const user = (req as Request & { user?: { email?: string } }).user;
      return svc().enrol(requireUserId(req), brandOf(req), user?.email ?? requireUserId(req));
    }),
  );

  router.post(
    '/verify',
    ...auth,
    on,
    ...codeLimit,
    route(async (req) => {
      const { code } = parseBody(req, TotpVerifyBodySchema);
      return svc().verify(requireUserId(req), brandOf(req), code, sessionTokenOf(req));
    }),
  );

  router.post(
    '/disable',
    ...auth,
    on,
    ...codeLimit,
    route(async (req, res) => {
      const body = parseBody(req, TotpDisableBodySchema);
      const factor: SecondFactor = body.code ? { code: body.code } : { recoveryCode: body.recoveryCode! };
      await svc().disable(requireUserId(req), brandOf(req), factor, sessionTokenOf(req));
      res.status(204).end();
    }),
  );

  router.post(
    '/recovery-codes',
    ...auth,
    on,
    ...codeLimit,
    route(async (req) => {
      const { code } = parseBody(req, RegenerateRecoveryBodySchema);
      return svc().regenerateRecoveryCodes(requireUserId(req), brandOf(req), code);
    }),
  );

  return router;
}

/** 10 confirmations per 15 minutes per user (codes also stop after 5 wrong tries). */
const CONFIRM_WINDOWS = [{ limit: 10, windowSec: 15 * MINUTE }] as const;

export function createStudentRouter(deps: AccountV2RouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('student', { env: deps.env });
  const svc = () => deps.student ?? studentServiceInstance();
  const confirmLimit: RequestHandler[] =
    deps.rateLimits === false ? [] : [rateLimit({ name: 'studentConfirmPerUser', windows: CONFIRM_WINDOWS, by: 'user', failMode: 'closed' })];

  router.get('/', ...auth, on, route(async (req) => svc().status(requireUserId(req))));

  router.post(
    '/verify-email/send',
    ...auth,
    on,
    route(async (req) => {
      const { schoolEmail } = parseBody(req, StudentEmailSendBodySchema);
      return svc().sendCode(requireUserId(req), brandOf(req), schoolEmail, localeOf(req));
    }),
  );

  router.post(
    '/verify-email/confirm',
    ...auth,
    on,
    ...confirmLimit,
    route(async (req) => {
      const { code } = parseBody(req, StudentEmailConfirmBodySchema);
      return svc().confirm(requireUserId(req), code);
    }),
  );

  return router;
}
