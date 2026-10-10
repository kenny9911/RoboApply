// server/src/features/auth-cn/phoneBinding.ts — "bind a phone before AI features"
// (CN_TW_LAUNCH_PLAN.md §4.2 WP-AUTH-CN, CN-L-08 real-name; TASK_PLAN.md WP-11;
// GOAPPLY_PARITY_PLAN.md §3.7).
//
// Rule: a GoApply account that signed in with WeChat and has no verified phone
// number must bind one before any AI feature, WHEN A PHONE CAN BE BOUND: the
// `auth.phoneOtp` capability is on (an SMS provider is live and the phone
// method is not switched off). Otherwise nobody can bind a number, so nothing
// is asked and the account uses AI like any other (D5: a missing China
// credential never locks a feature).
// AI routes call `assertPhoneBound(userId)` (or mount `requirePhoneBound`)
// after their auth; it answers `403 phone_binding_required`, which the web
// client turns into a link to /bind-phone. RoboApply accounts and phone/email
// accounts pass.
//
// One function, `phoneBindingRequired`, is the rule for every consumer (the
// practice gate, the Assistant, resume, cover letter, prep, network, offers,
// the extension, the feed and the legacy AI gates).

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { getBrand, parseBrandId } from '../../platform/brand/registry.js';
import { isEnabledForBrand } from '../../platform/flags.js';
import { defaultAuthCnDb, type AuthCnDb } from './db.js';
import { AuthCnError, sendAuthCnError } from './errors.js';

/**
 * True when a GoApply account can bind a phone number on this deployment: the
 * `auth.phoneOtp` capability is on for GoApply, which is what the bind routes
 * themselves are gated on (`requireFlag('auth.phoneOtp')`, routes.ts). It is
 * false whenever the capability's requirement is not met (no SMS provider;
 * the dev console never counts in production), and also when the operator
 * switched the phone method off (`FLAG_GOAPPLY_AUTH_PHONE_OTP=false`): in both
 * cases POST /auth/phone/bind answers 404, so asking for a number would lock
 * the account out of AI for good.
 */
export function phoneBindingAvailable(env: EnvSource = process.env): boolean {
  return isEnabledForBrand('auth.phoneOtp', getBrand('goapply'), env);
}

export async function hasBoundPhone(userId: string, db: AuthCnDb = defaultAuthCnDb()): Promise<boolean> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { phoneE164: true, phoneVerifiedAt: true } });
  return Boolean(u?.phoneE164 && u.phoneVerifiedAt);
}

/**
 * True when the account must bind a phone before AI features: a GoApply
 * account with a WeChat identity and no verified number, on a deployment
 * where a number can be bound (`phoneBindingAvailable`). False for everyone
 * when it cannot.
 */
export async function phoneBindingRequired(userId: string, db: AuthCnDb = defaultAuthCnDb(), env: EnvSource = process.env): Promise<boolean> {
  if (!phoneBindingAvailable(env)) return false;
  const u = await db.user.findUnique({ where: { id: userId }, select: { brand: true, phoneE164: true, phoneVerifiedAt: true } });
  if (!u || parseBrandId(u.brand) !== 'goapply') return false;
  if (u.phoneE164 && u.phoneVerifiedAt) return false;
  const wechat = await db.rAAuthIdentity.findFirst({ where: { userId, provider: 'wechat' }, select: { id: true } });
  return Boolean(wechat);
}

/** Throws `AuthCnError('phone_binding_required')` (403) when the account must bind first. */
export async function assertPhoneBound(userId: string, db: AuthCnDb = defaultAuthCnDb(), env: EnvSource = process.env): Promise<void> {
  if (await phoneBindingRequired(userId, db, env)) throw new AuthCnError('phone_binding_required', { bindRoute: '/bind-phone' });
}

/** Express gate for AI routes; place it after the auth chain. */
export function requirePhoneBound(db?: AuthCnDb, env?: EnvSource): RequestHandler {
  return async function phoneBindingGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as Request & { user?: { id?: string } }).user?.id;
      if (userId) await assertPhoneBound(userId, db ?? defaultAuthCnDb(), env ?? process.env);
      next();
    } catch (err) {
      if (err instanceof AuthCnError) {
        sendAuthCnError(res, err);
        return;
      }
      next(err);
    }
  };
}
