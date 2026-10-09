// server/src/features/auth-cn/phoneBinding.ts — "bind a phone before AI features"
// (CN_TW_LAUNCH_PLAN.md §4.2 WP-AUTH-CN, CN-L-08 real-name; TASK_PLAN.md WP-11).
//
// Rule: a GoApply account that signed in with WeChat and has no verified phone
// number must bind one before any AI feature. AI routes call
// `assertPhoneBound(userId)` (or mount `requirePhoneBound`) after their auth;
// it answers `403 phone_binding_required`, which the web client turns into a
// link to /bind-phone. RoboApply accounts and phone/email accounts pass.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { parseBrandId } from '../../platform/brand/registry.js';
import { defaultAuthCnDb, type AuthCnDb } from './db.js';
import { AuthCnError, sendAuthCnError } from './errors.js';

export async function hasBoundPhone(userId: string, db: AuthCnDb = defaultAuthCnDb()): Promise<boolean> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { phoneE164: true, phoneVerifiedAt: true } });
  return Boolean(u?.phoneE164 && u.phoneVerifiedAt);
}

/** True when the account must bind a phone before AI features. */
export async function phoneBindingRequired(userId: string, db: AuthCnDb = defaultAuthCnDb()): Promise<boolean> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { brand: true, phoneE164: true, phoneVerifiedAt: true } });
  if (!u || parseBrandId(u.brand) !== 'goapply') return false;
  if (u.phoneE164 && u.phoneVerifiedAt) return false;
  const wechat = await db.rAAuthIdentity.findFirst({ where: { userId, provider: 'wechat' }, select: { id: true } });
  return Boolean(wechat);
}

/** Throws `AuthCnError('phone_binding_required')` (403) when the account must bind first. */
export async function assertPhoneBound(userId: string, db: AuthCnDb = defaultAuthCnDb()): Promise<void> {
  if (await phoneBindingRequired(userId, db)) throw new AuthCnError('phone_binding_required', { bindRoute: '/bind-phone' });
}

/** Express gate for AI routes; place it after the auth chain. */
export function requirePhoneBound(db?: AuthCnDb): RequestHandler {
  return async function phoneBindingGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as Request & { user?: { id?: string } }).user?.id;
      if (userId) await assertPhoneBound(userId, db ?? defaultAuthCnDb());
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
