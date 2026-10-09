// server/src/features/auth-cn/routes.ts — GoApply sign-in routes (WP-11).
//
// Mounted by features/index.ts:
//   createPhoneAuthRouter()   at /api/v1/roboapply/auth/phone
//   createWechatAuthRouter()  at /api/v1/roboapply/auth/wechat
//   createAuthCnAdminRouter() at /api/v1/roboapply/admin/auth-cn (admin; adminRoutes.ts)
// Every route checks its capability per route (R-04): `auth.phoneOtp`,
// `auth.wechatWeb`, `auth.wechatInApp`, `auth.wechatMini` — so a method whose
// credentials are absent answers 404 feature_disabled and renders no UI.
//
//   GET  /auth/phone/policy        what the G0 form needs (GoApply only)
//   GET  /auth/phone/me            signed in: masked number + re-verification options
//   POST /auth/phone/send-code     +86 only; limits in otpService.ts
//   POST /auth/phone/verify        sign in or sign up (one flow); sets the session cookie
//   POST /auth/phone/bind          signed in: add a verified number
//   POST /auth/phone/change        signed in: old-number proof + new-number code
//   POST /auth/wechat/start        { flow, consents, … } → { url } (the web form's sign-in/up)
//   GET  /auth/wechat/qr           302 → WeChat QR (returning users; purpose=reverify for a phone change)
//   GET  /auth/wechat/callback     302 → /auth/callback/wechat?result=…
//   GET  /auth/wechat/mp/start     302 → 公众号 OAuth (inside WeChat; returning users / reverify)
//   GET  /auth/wechat/mp/callback  302 → /auth/callback/wechat?result=…
//   POST /auth/wechat/mini/login   mini-program API seam; returns a session token
//
// Every WeChat start sets WECHAT_NONCE_COOKIE (httpOnly, SameSite=Lax, 10 min,
// path /api/v1/roboapply/auth/wechat); the callback passes it to the service,
// which refuses a state started in another browser, and clears it.

import { Router, type Request, type Response } from 'express';
import { buildClearCookieOptions, buildCookieOptions } from '../../lib/cookieOptions.js';
import { optionalAuth } from '../../middleware/auth.js';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getCurrentBrandOrDefault, type BrandedRequest } from '../../platform/brand/brandContext.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { requireFlag } from '../../platform/flags.js';
import { HttpError, parseBody, parseQuery, requireUserId } from '../../platform/http.js';
import { clientIp } from '../../platform/ratelimit/index.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  BindPhoneBodySchema,
  ChangePhoneBodySchema,
  SendCodeBodySchema,
  toCnE164,
  VerifyCodeBodySchema,
  WechatCallbackQuerySchema,
  WechatMiniLoginBodySchema,
  WechatStartBodySchema,
  WechatStartQuerySchema,
  maskCnPhone,
  type BindPhoneResponse,
  type ChangePhoneResponse,
  type PhoneSessionResponse,
  type PhoneStatusResponse,
  type SendCodeResponse,
  type SignupPolicyResponse,
  type WechatMiniLoginResponse,
  type WechatStartResponse,
} from './contract.js';
import { currentSessionToken, issueSessionCookie } from './accounts.js';
import { cnRoute } from './errors.js';
import { createAuthCnServices, type AuthCnServices } from './services.js';
import { buildSignupPolicy } from './signupPolicy.js';
import { OAUTH_STATE_TTL_MS, returnLocation } from './wechatAuthService.js';

/** Binds a WeChat OAuth state to the browser that started it (login-CSRF guard). */
export const WECHAT_NONCE_COOKIE = 'ra_wx_oauth_nonce';
const WECHAT_COOKIE_PATH = '/api/v1/roboapply/auth/wechat';

function setNonceCookie(req: Request, res: Response, nonce: string): void {
  res.cookie(WECHAT_NONCE_COOKIE, nonce, buildCookieOptions(req, { sameSite: 'lax', path: WECHAT_COOKIE_PATH, maxAge: OAUTH_STATE_TTL_MS }));
}

function takeNonceCookie(req: Request, res: Response): string | null {
  const raw = (req.cookies as Record<string, string> | undefined)?.[WECHAT_NONCE_COOKIE];
  if (typeof raw !== 'string' || !raw) return null;
  res.clearCookie(WECHAT_NONCE_COOKIE, buildClearCookieOptions(req, { path: WECHAT_COOKIE_PATH }));
  return raw;
}

export { createAuthCnAdminRouter } from './adminRoutes.js';

function brandOf(req: Request): ProductBrand {
  return (req as Partial<BrandedRequest>).brand ?? getCurrentBrandOrDefault();
}

function phoneOf(raw: string): string {
  const e164 = toCnE164(raw);
  if (!e164) throw new HttpError('invalid_request', '请输入正确的手机号');
  return e164;
}

function localeOf(req: Request): string | null {
  const c = (req.cookies as Record<string, string> | undefined)?.robo_locale;
  return typeof c === 'string' && c ? c : null;
}

function userIdOf(req: Request): string | null {
  const id = (req as Request & { user?: { id?: unknown } }).user?.id;
  return typeof id === 'string' && id ? id : null;
}

function services(deps: FeatureRouterDeps, overrides?: Partial<AuthCnServices>): AuthCnServices {
  return { ...createAuthCnServices({ env: deps.env, ...(overrides?.db ? { db: overrides.db } : {}) }), ...overrides };
}

export function createPhoneAuthRouter(deps: FeatureRouterDeps = {}, overrides?: Partial<AuthCnServices>): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];
  const otp = requireFlag('auth.phoneOtp', { env: deps.env });
  let svc: AuthCnServices | null = null;
  const s = () => (svc ??= services(deps, overrides));

  router.get(
    '/policy',
    cnRoute(async (req): Promise<SignupPolicyResponse> => {
      const brand = brandOf(req);
      if (brand.market !== 'cn') throw new HttpError('feature_disabled');
      return buildSignupPolicy(brand, deps.env ?? process.env);
    }),
  );

  router.get(
    '/me',
    ...auth,
    otp,
    cnRoute(async (req): Promise<PhoneStatusResponse> => s().phone.status(requireUserId(req))),
  );

  router.post(
    '/send-code',
    otp,
    ...maybeAuth,
    cnRoute(async (req): Promise<SendCodeResponse> => {
      const body = parseBody(req, SendCodeBodySchema);
      const brand = brandOf(req);
      const phoneE164 = phoneOf(body.phone);
      await s().phone.assertSendAllowed(brand, body.purpose, phoneE164, userIdOf(req));
      return s().otp.sendCode({ brand: brand.id, phoneE164, purpose: body.purpose, ip: clientIp(req) });
    }),
  );

  router.post(
    '/verify',
    otp,
    cnRoute(async (req, res): Promise<PhoneSessionResponse> => {
      const body = parseBody(req, VerifyCodeBodySchema);
      const brand = brandOf(req);
      const result = await s().phone.verifyAndSignIn({
        brand,
        phoneE164: phoneOf(body.phone),
        code: body.code,
        consents: body.consents,
        inviteCode: body.inviteCode,
        next: body.next,
        locale: localeOf(req),
        ip: clientIp(req),
      });
      await issueSessionCookie(req, res, result.userId, s().issueSession);
      return result;
    }),
  );

  router.post(
    '/bind',
    ...auth,
    otp,
    cnRoute(async (req, res): Promise<BindPhoneResponse> => {
      const body = parseBody(req, BindPhoneBodySchema);
      const brand = brandOf(req);
      const phoneE164 = phoneOf(body.phone);
      const result = await s().phone.bind({ brand, userId: requireUserId(req), phoneE164, code: body.code, next: body.next, ip: clientIp(req) });
      // A merge moved the sign-in onto the number's account: the old session went with the removed account.
      if (result.merged) await issueSessionCookie(req, res, result.userId, s().issueSession);
      return { userId: result.userId, merged: result.merged, nextRoute: result.nextRoute, phoneMasked: maskCnPhone(phoneE164) ?? '' };
    }),
  );

  router.post(
    '/change',
    ...auth,
    otp,
    cnRoute(async (req): Promise<ChangePhoneResponse> => {
      const body = parseBody(req, ChangePhoneBodySchema);
      return s().phone.change({
        brand: brandOf(req),
        userId: requireUserId(req),
        oldCode: body.oldCode,
        identityProof: body.identityProof,
        newPhoneE164: phoneOf(body.newPhone),
        newCode: body.newCode,
        keepSessionToken: currentSessionToken(req),
        ip: clientIp(req),
      });
    }),
  );

  return router;
}

export function createWechatAuthRouter(deps: FeatureRouterDeps = {}, overrides?: Partial<AuthCnServices>): Router {
  const router = Router();
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];
  const web = requireFlag('auth.wechatWeb', { env: deps.env });
  const inApp = requireFlag('auth.wechatInApp', { env: deps.env });
  const mini = requireFlag('auth.wechatMini', { env: deps.env });
  let svc: AuthCnServices | null = null;
  const s = () => (svc ??= services(deps, overrides));

  // GET start: no consents (returning users and reverify only).
  const start = (flow: 'web' | 'mp') =>
    cnRoute(async (req, res) => {
      const q = parseQuery(req, WechatStartQuerySchema);
      const { url, nonce } = await s().wechat.startUrl({
        brand: brandOf(req),
        flow,
        next: q.next,
        invite: q.invite,
        purpose: q.purpose,
        userId: userIdOf(req),
      });
      setNonceCookie(req, res, nonce);
      res.redirect(302, url);
    });

  const callback = (flow: 'web' | 'mp') =>
    cnRoute(async (req, res) => {
      const q = parseQuery(req, WechatCallbackQuerySchema);
      const nonce = takeNonceCookie(req, res);
      const outcome = await s().wechat.callback({ brand: brandOf(req), flow, code: q.code, state: q.state, nonce, locale: localeOf(req) });
      if (outcome.kind === 'error') {
        res.redirect(302, returnLocation({ result: 'error', code: outcome.code }));
        return;
      }
      if (outcome.kind === 'reverify') {
        res.redirect(302, returnLocation({ result: 'ok', reverify: outcome.token, next: '/settings#security' }));
        return;
      }
      await issueSessionCookie(req, res, outcome.userId, s().issueSession);
      res.redirect(
        302,
        returnLocation({
          result: 'ok',
          next: outcome.nextRoute,
          ...(outcome.phoneBound ? {} : { bind: '1' as const }),
          ...(outcome.isNew ? { new: '1' as const } : {}),
        }),
      );
    });

  // POST start (the web form): consents in the body; the flow's own capability gate.
  router.post(
    '/start',
    (req, res, next) => ((req.body as { flow?: unknown } | undefined)?.flow === 'mp' ? inApp : web)(req, res, next),
    cnRoute(async (req, res): Promise<WechatStartResponse> => {
      const body = parseBody(req, WechatStartBodySchema);
      const { url, nonce } = await s().wechat.startUrl({
        brand: brandOf(req),
        flow: body.flow,
        next: body.next,
        consents: body.consents,
        invite: body.inviteCode,
        purpose: 'signin',
      });
      setNonceCookie(req, res, nonce);
      return { url };
    }),
  );
  router.get('/qr', web, ...maybeAuth, start('web'));
  router.get('/callback', web, callback('web'));
  router.get('/mp/start', inApp, ...maybeAuth, start('mp'));
  router.get('/mp/callback', inApp, callback('mp'));
  router.post(
    '/mini/login',
    mini,
    cnRoute(async (req, res): Promise<WechatMiniLoginResponse> => {
      const body = parseBody(req, WechatMiniLoginBodySchema);
      const result = await s().wechat.miniLogin({
        brand: brandOf(req),
        code: body.code,
        phoneCode: body.phoneCode,
        consents: body.consents,
        inviteCode: body.inviteCode,
        locale: localeOf(req),
      });
      const sessionToken = await issueSessionCookie(req, res, result.userId, s().issueSession);
      return { userId: result.userId, isNewUser: result.isNewUser, nextRoute: result.nextRoute, phoneBound: result.phoneBound, sessionToken };
    }),
  );

  return router;
}
