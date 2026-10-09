// server/src/features/auth/routes.ts — the NEW auth and account paths (WP-10;
// ARCHITECTURE.md §3.2). Mounted by features/index.ts AFTER the legacy
// routers, so nothing here shadows /auth/{signup,login,me,logout} or the
// existing /account/* paths.
//
//   createAuthRouter()    at /api/v1/roboapply/auth
//     GET  /methods                       P   methods for this brand ∩ configured
//     POST /password/forgot               P   204 always; 5/h per email, 20/h per IP
//     POST /password/reset                P   new session; revokes all others; 10/h per IP
//     GET  /email/status                  S   { email, verified, canResend }
//     POST /email/verify/send             S   204; 3/h per user
//     GET  /email/verify?token=           P   JSON (Accept: json) or 302
//     GET  /oauth/{google,line}/start     P   302 to the provider (JSON { url } on request);
//                                             sets the browser-binding cookie; 30/h per IP
//     GET  /oauth/{google,line}/callback  P   JSON OAuthCallbackResult or 302; needs that cookie
//     POST /oauth/complete                P   new OAuth user accepts the signup terms
//     POST /oauth/email                   P   provider gave no verified email: verify one first
//   createAccountRouter() at /api/v1/roboapply/account
//     GET/DELETE /identities[/:id]        S
//     GET/POST   /consents                S
//     GET/DELETE /sessions[/:id]          S
//
// Capabilities per route (R-04): Google/LINE need `auth.google`/`auth.line`
// (credentials present; /oauth/email checks the pending token's provider);
// reset needs `auth.passwordReset` (email transport configured). Off → 404
// feature_disabled, and the method is not listed.

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag, type FlagKey } from '../../platform/flags.js';
import { getCurrentBrand } from '../../platform/brand/brandContext.js';
import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { parseBody, parseParams, parseQuery, requireUserId } from '../../platform/http.js';
import { assertRateLimit, clientIp, HOUR, rateLimit } from '../../platform/ratelimit/index.js';
import { buildCookieOptions, SESSION_COOKIE_NAME } from '../../lib/cookieOptions.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  ForgotPasswordBodySchema,
  IdentityParamsSchema,
  OAuthCallbackQuerySchema,
  OAuthCompleteBodySchema,
  OAuthEmailBodySchema,
  OAuthStartQuerySchema,
  RecordConsentBodySchema,
  ResetPasswordBodySchema,
  SessionParamsSchema,
  VerifyEmailQuerySchema,
} from './contract.js';
import { authRoute, isAuthError } from './errors.js';
import { authService as defaultService, type AuthFeatureServiceImpl, type OAuthSignupContext } from './service.js';
import type { OAuthProviderId } from './oauth/providers.js';

export interface AuthRouterDeps extends FeatureRouterDeps {
  /** Test seam: the service instance (default: production dependencies). */
  service?: AuthFeatureServiceImpl;
  /** Test seam: skip the DB-backed rate limits. */
  rateLimits?: boolean;
}

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Browser binding for an OAuth attempt: /start sets it, the callback must
 * send it back (its sha256 is stored with the state) and clears it. Lax, so
 * it rides the provider's top-level redirect back to this site.
 */
export const OAUTH_BINDER_COOKIE = 'ra_oauth_state';
const OAUTH_BINDER_MAX_AGE_MS = 15 * 60 * 1000;
/** /oauth/{provider}/start per IP (each start stores a state row). */
const OAUTH_START_WINDOWS = [{ limit: 30, windowSec: HOUR }];

function setBinder(req: Request, res: Response, binder: string): void {
  res.cookie(OAUTH_BINDER_COOKIE, binder, buildCookieOptions(req, { maxAge: OAUTH_BINDER_MAX_AGE_MS, sameSite: 'lax' }));
}

function takeBinder(req: Request, res: Response): string | null {
  const value = (req as Request & { cookies?: Record<string, string> }).cookies?.[OAUTH_BINDER_COOKIE] ?? null;
  res.clearCookie(OAUTH_BINDER_COOKIE, buildCookieOptions(req, { sameSite: 'lax' }));
  return value;
}

function brandOf(req: Request): ProductBrand {
  return (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrand();
}

function country(req: Request): string | null {
  const raw = req.get('x-vercel-ip-country');
  return raw && /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : null;
}

function wantsJson(req: Request): boolean {
  return (req.get('accept') ?? '').includes('application/json');
}

function setSession(req: Request, res: Response, token: string): void {
  const sameSite = (process.env.COOKIE_SAME_SITE || 'lax').toLowerCase();
  res.cookie(
    SESSION_COOKIE_NAME,
    token,
    buildCookieOptions(req, {
      maxAge: SESSION_MAX_AGE_MS,
      sameSite: sameSite === 'strict' ? 'strict' : sameSite === 'none' ? 'none' : 'lax',
    }),
  );
}

function currentSessionToken(req: Request): string | null {
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE_NAME];
  const header = req.get('x-session-token');
  return cookie || header || null;
}

/**
 * The OAuth redirect URI: the web page `/auth/callback/<provider>` on this
 * brand's public origin (`CANONICAL_ORIGIN` / `CN_CANONICAL_ORIGIN`, else the
 * registry origin). Outside production the request's own origin is used, so
 * local hosts work (register them with the provider for development).
 */
export function oauthRedirectUri(req: Request, brand: ProductBrand, provider: OAuthProviderId, env: EnvSource = process.env): string {
  let origin = (brandEnv(brand, 'CANONICAL_ORIGIN', env) || brand.canonicalOrigin).replace(/\/+$/, '');
  if (env.NODE_ENV !== 'production') {
    const host = (req.get('x-forwarded-host') ?? req.get('host') ?? '').split(',')[0]!.trim();
    const proto = (req.get('x-forwarded-proto') ?? req.protocol ?? 'http').split(',')[0]!.trim();
    if (host) origin = `${proto}://${host}`;
  }
  return `${origin}/auth/callback/${provider}`;
}

function signupContextFromStart(q: ReturnType<typeof OAuthStartQuerySchema.parse>, req: Request): OAuthSignupContext | null {
  if (q.age !== '1') return null;
  const consents = [{ type: 'age_16_plus', granted: true, proseVersion: 'signup.v1' }];
  if (q.pdpa === '1') consents.push({ type: 'tw_pdpa_notice', granted: true, proseVersion: 'signup.v1' });
  return {
    consents,
    marketingOptIn: q.marketing === '1',
    locale: q.locale ?? null,
    timezone: q.tz ?? null,
    country: country(req),
    attribution: {
      from: q.from,
      jobId: q.job,
      action: q.action,
      ref: q.ref,
      utmSource: q.utm_source,
      utmMedium: q.utm_medium,
      utmCampaign: q.utm_campaign,
      alert: q.alert,
    },
  };
}

/** 5 reset emails per hour per email hash (ARCH §3.10). Fails open on a DB error, like the middleware. */
async function perEmailLimit(email: string): Promise<void> {
  try {
    await assertRateLimit({ name: 'passwordResetPerEmail', id: email });
  } catch (err) {
    if ((err as { code?: string }).code === 'rate_limited') throw err;
  }
}

/** Where the web callback page sends a failed attempt. */
function failurePath(code: string): string {
  return `/login?error=${encodeURIComponent(code)}`;
}

/** New /auth paths (public unless noted). */
export function createAuthRouter(deps: AuthRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const flag = (key: FlagKey) => requireFlag(key, { env: deps.env });
  const svc = () => deps.service ?? defaultService;
  const limit = (options: Parameters<typeof rateLimit>[0]): RequestHandler[] => (deps.rateLimits === false ? [] : [rateLimit(options)]);

  router.get(
    '/methods',
    authRoute(async (req) => {
      const locale = typeof req.query.locale === 'string' ? req.query.locale : null;
      return svc().listMethods({ brand: brandOf(req), locale, country: country(req) });
    }),
  );

  router.post(
    '/password/forgot',
    flag('auth.passwordReset'),
    ...limit({ name: 'passwordResetPerIp', windows: [{ limit: 20, windowSec: HOUR }] }),
    authRoute(async (req, res) => {
      const { email } = parseBody(req, ForgotPasswordBodySchema);
      if (deps.rateLimits !== false) await perEmailLimit(email);
      await svc().requestPasswordReset({ email, brand: brandOf(req) });
      res.status(204).end();
    }),
  );

  router.post(
    '/password/reset',
    flag('auth.passwordReset'),
    ...limit({ name: 'passwordResetSubmitPerIp', windows: [{ limit: 10, windowSec: HOUR }] }),
    authRoute(async (req, res) => {
      const { token, password } = parseBody(req, ResetPasswordBodySchema);
      const brand = brandOf(req);
      const signIn = await svc().resetPassword({ token, password, brand });
      setSession(req, res, signIn.sessionToken);
      return { next: await svc().signInRoute(brand, signIn.userId, null) };
    }),
  );

  router.get(
    '/email/status',
    ...auth,
    authRoute(async (req) => svc().emailStatus(requireUserId(req))),
  );

  router.post(
    '/email/verify/send',
    ...auth,
    ...limit({ name: 'emailVerifySendPerUser', by: 'user', windows: [{ limit: 3, windowSec: HOUR }] }),
    authRoute(async (req, res) => {
      await svc().sendVerificationEmail({ userId: requireUserId(req), brand: brandOf(req) });
      res.status(204).end();
    }),
  );

  router.get(
    '/email/verify',
    async (req, res, next) => {
      if (wantsJson(req)) return next();
      // A link opened straight against the API: do the work, then redirect.
      try {
        const { token } = parseQuery(req, VerifyEmailQuerySchema);
        const result = await svc().verifyEmail({ token, brand: brandOf(req), userAgent: req.get('user-agent') ?? null });
        if (result.status === 'signed_in' && result.signIn) setSession(req, res, result.signIn.sessionToken);
        res.redirect(302, result.status === 'verified' ? '/settings?verified=1#account' : result.next);
      } catch (err) {
        res.redirect(302, `/settings?verified=0${isAuthError(err) ? `&reason=${err.code}` : ''}#account`);
      }
    },
    authRoute(async (req, res) => {
      const { token } = parseQuery(req, VerifyEmailQuerySchema);
      const result = await svc().verifyEmail({ token, brand: brandOf(req), userAgent: req.get('user-agent') ?? null });
      if (result.status === 'signed_in' && result.signIn) setSession(req, res, result.signIn.sessionToken);
      const { signIn: _signIn, ...wire } = result;
      return wire;
    }),
  );

  for (const provider of ['google', 'line'] as const) {
    const capability: FlagKey = provider === 'google' ? 'auth.google' : 'auth.line';

    router.get(
      `/oauth/${provider}/start`,
      flag(capability),
      ...limit({ name: 'oauthStartPerIp', windows: OAUTH_START_WINDOWS }),
      authRoute(async (req, res) => {
        const q = parseQuery(req, OAuthStartQuerySchema);
        const brand = brandOf(req);
        const { url, binder } = await svc().startOAuth({
          provider,
          brand,
          redirectUri: oauthRedirectUri(req, brand, provider, deps.env),
          next: q.next ?? null,
          signup: signupContextFromStart(q, req),
        });
        setBinder(req, res, binder);
        if (wantsJson(req)) return { url };
        res.redirect(302, url);
        return undefined;
      }),
    );

    router.get(
      `/oauth/${provider}/callback`,
      flag(capability),
      async (req, res, next) => {
        if (wantsJson(req)) return next();
        // The provider redirected straight to the API (not the web page).
        try {
          const q = parseQuery(req, OAuthCallbackQuerySchema);
          const result = await svc().finishOAuthCallback({
            provider,
            brand: brandOf(req),
            code: q.code,
            state: q.state,
            error: q.error,
            userAgent: req.get('user-agent') ?? null,
            binder: takeBinder(req, res),
          });
          if (result.status === 'signed_in') {
            setSession(req, res, result.signIn.sessionToken);
            res.redirect(302, result.next);
            return;
          }
          res.redirect(302, `/auth/callback/${provider}?pending=${encodeURIComponent(result.pendingToken)}&status=${result.status}`);
        } catch (err) {
          const code = (err as { code?: string }).code ?? 'oauth_failed';
          res.redirect(302, failurePath(code));
        }
      },
      authRoute(async (req, res) => {
        const q = parseQuery(req, OAuthCallbackQuerySchema);
        const result = await svc().finishOAuthCallback({
          provider,
          brand: brandOf(req),
          code: q.code,
          state: q.state,
          error: q.error,
          userAgent: req.get('user-agent') ?? null,
          binder: takeBinder(req, res),
        });
        if (result.status === 'signed_in') {
          setSession(req, res, result.signIn.sessionToken);
          return { status: 'signed_in' as const, next: result.next, isNewUser: result.isNewUser };
        }
        return result;
      }),
    );
  }

  router.post(
    '/oauth/complete',
    ...limit({ name: 'signupPerIp' }),
    authRoute(async (req, res) => {
      const body = parseBody(req, OAuthCompleteBodySchema);
      const result = await svc().completeOAuth({
        pendingToken: body.pendingToken,
        brand: brandOf(req),
        consents: body.consents,
        marketingOptIn: body.marketingOptIn,
        locale: body.locale ?? null,
        timezone: body.timezone ?? null,
        country: country(req),
        userAgent: req.get('user-agent') ?? null,
      });
      if (result.status === 'signed_in') {
        setSession(req, res, result.signIn.sessionToken);
        return { status: 'signed_in' as const, next: result.next, isNewUser: result.isNewUser };
      }
      return result;
    }),
  );

  // The capability is checked against the pending token's provider (service).
  router.post(
    '/oauth/email',
    ...limit({ name: 'signupPerIp' }),
    authRoute(async (req) => {
      const body = parseBody(req, OAuthEmailBodySchema);
      return svc().oauthEmail({
        pendingToken: body.pendingToken,
        email: body.email,
        brand: brandOf(req),
        consents: body.consents,
        marketingOptIn: body.marketingOptIn,
        locale: body.locale ?? null,
        timezone: body.timezone ?? null,
        country: country(req),
      });
    }),
  );

  return router;
}

/** New /account paths (seeker session). */
export function createAccountRouter(deps: AuthRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const svc = () => deps.service ?? defaultService;

  router.get('/identities', ...auth, authRoute(async (req) => ({ identities: await svc().listIdentities(requireUserId(req)) })));
  router.delete(
    '/identities/:id',
    ...auth,
    authRoute(async (req) => {
      const { id } = parseParams(req, IdentityParamsSchema);
      return { identities: await svc().unlinkIdentity(requireUserId(req), id) };
    }),
  );

  router.get('/consents', ...auth, authRoute(async (req) => ({ consents: await svc().listConsents(requireUserId(req)) })));
  router.post(
    '/consents',
    ...auth,
    authRoute(async (req) => {
      const body = parseBody(req, RecordConsentBodySchema);
      return svc().recordConsent(requireUserId(req), body, { ip: clientIp(req), userAgent: req.get('user-agent') ?? null });
    }),
  );

  router.get(
    '/sessions',
    ...auth,
    authRoute(async (req) => ({ sessions: await svc().listSessions(requireUserId(req), currentSessionToken(req)) })),
  );
  router.delete(
    '/sessions/:id',
    ...auth,
    authRoute(async (req) => {
      const { id } = parseParams(req, SessionParamsSchema);
      return svc().revokeSession(requireUserId(req), id);
    }),
  );

  return router;
}
