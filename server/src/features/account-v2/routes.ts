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
import { SESSION_COOKIE_NAME } from '../../lib/cookieOptions.js';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getCurrentBrand } from '../../platform/brand/brandContext.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { requireFlag } from '../../platform/flags.js';
import { parseBody, requireUserId, route } from '../../platform/http.js';
import { rateLimit, rateLimitWindows } from '../../platform/ratelimit/index.js';
import { logger } from '../../services/LoggerService.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  RegenerateRecoveryBodySchema,
  StudentEmailConfirmBodySchema,
  StudentEmailSendBodySchema,
  TotpDisableBodySchema,
  TotpVerifyBodySchema,
} from './contract.js';
import { StudentService, defaultStudentDeps } from './student.js';
import { totpKeyProblems, totpKeyWarning } from './sealing.js';
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

/**
 * The caller's own session, kept when every other one is signed out. The
 * auth middleware records it only when the request was authenticated by the
 * session itself; a browser that also sends a bearer JWT is authenticated by
 * the JWT, so the session cookie (or `X-Session-Token`) is read directly.
 * The value is only ever used as "do not delete this one".
 */
function sessionTokenOf(req: Request): string | null {
  const token = (req as Request & { sessionToken?: unknown }).sessionToken;
  if (typeof token === 'string' && token) return token;
  const cookie = (req as Request & { cookies?: Record<string, unknown> }).cookies?.[SESSION_COOKIE_NAME];
  if (typeof cookie === 'string' && cookie) return cookie;
  const header = req.get('x-session-token');
  return header && header.trim() ? header.trim() : null;
}

function localeOf(req: Request): string | null {
  const header = req.get('x-robo-locale');
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.robo_locale;
  return (header && header.trim()) || (cookie && cookie.trim()) || null;
}

/** 10 code checks per 15 minutes per user (enrol confirm, disable, new recovery codes). */

/** Key warnings already logged in this process (the router is built once at boot, and again by tests). */
const loggedKeyWarnings = new Set<string>();

/** A sealing-key variable that is set but unusable is skipped, never fatal; say so once in the boot log. */
function logTotpKeyProblems(env: FeatureRouterDeps['env']): void {
  const source = env ?? process.env;
  for (const name of totpKeyProblems(source)) {
    const warning = totpKeyWarning(name, source);
    if (loggedKeyWarnings.has(warning)) continue;
    loggedKeyWarnings.add(warning);
    logger.warn('ACCOUNT_2FA', warning);
  }
}

export function createTwoFactorRouter(deps: AccountV2RouterDeps = {}): Router {
  logTotpKeyProblems(deps.env);
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('totp', { env: deps.env });
  const svc = () => deps.twoFactor ?? twoFactorServiceInstance();
  const codeLimit: RequestHandler[] =
    deps.rateLimits === false ? [] : [rateLimit({ name: 'totpCodePerUser', windows: rateLimitWindows('totpCodePerUser'), by: 'user', failMode: 'closed' })];

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

export function createStudentRouter(deps: AccountV2RouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('student', { env: deps.env });
  const svc = () => deps.student ?? studentServiceInstance();
  const confirmLimit: RequestHandler[] =
    deps.rateLimits === false ? [] : [rateLimit({ name: 'studentConfirmPerUser', windows: rateLimitWindows('studentConfirmPerUser'), by: 'user', failMode: 'closed' })];

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
