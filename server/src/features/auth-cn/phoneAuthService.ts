// server/src/features/auth-cn/phoneAuthService.ts — phone sign-in/up, bind and change
// (TASK_PLAN.md WP-11; PRODUCT_PLAN.md G0, F-ACCT-02 cn).
//
//   verify  one flow: a known number signs in, a new number creates an
//           account (signup gate, required consents, invite in invite mode).
//   bind    adds a verified number to the signed-in account (after WeChat).
//           When the number already has an account on this brand and the
//           signed-in account is a fresh, empty WeChat-only account, the
//           WeChat identity moves onto the number's account and the empty one
//           is removed (the person proved both); otherwise 409 phone_taken.
//   change  OTP to the old number (or password / WeChat re-verification when
//           it is lost) AND OTP to the new number; every other session is
//           signed out. Both proofs are checked first and spent together
//           only when both pass, so one mistyped new code does not cost the
//           old-number code or the WeChat round trip. Password and WeChat
//           proofs are limited to 5 tries per user per 15 minutes (429).
//
// Codes never prove anything across purposes: each step checks the code for
// its own purpose (`login`, `bind`, `change_old`, `change_new`).

import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import { hashIdentifier } from '../../platform/ratelimit/index.js';
import { MINUTE, type RateWindow } from '../../platform/ratelimit/defaults.js';
import { maskCnPhone, type ConsentInput, type OtpPurpose } from './contract.js';
import { createGoApplyAccount, routeAfterSignIn, safeNext } from './accounts.js';
import { isUniqueViolation, type AuthCnDb } from './db.js';
import type { RawSignals } from '../growth/index.js';
import { AuthCnError } from './errors.js';
import { afterAccountCreated, afterPhoneBound, afterWechatLinked, type AccountHooks } from './hooks.js';
import { assertInviteRedeemable, redeemInviteIn } from './inviteService.js';
import type { ConsumeFn, OtpService } from './otpService.js';
import { assertSignupOpen, checkSignupConsents, cnSignupMode } from './signupPolicy.js';

/** A WeChat-only account younger than this, still at the first onboarding stages, may be merged on bind. */
const MERGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MERGEABLE_STAGES = new Set(['account', 'consent']);

/** Password / WeChat-token proofs for a phone change, per user. */
export const CHANGE_PROOF_WINDOWS: readonly RateWindow[] = [{ limit: 5, windowSec: 15 * MINUTE }];

export interface PhoneAuthDeps {
  db: AuthCnDb;
  otp: Pick<OtpService, 'verifyCode' | 'spend'>;
  env: EnvSource;
  now: () => Date;
  /** DB-backed limiter (platform consumeRateLimit). */
  consume: ConsumeFn;
  /** Invite attribution, invite check and the phone practice credit (hooks.ts). Absent = none run. */
  hooks?: AccountHooks;
}

export interface SignInResult {
  userId: string;
  isNewUser: boolean;
  nextRoute: string;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function createPhoneAuthService(deps: PhoneAuthDeps) {
  const { db } = deps;

  async function profileOf(userId: string) {
    return db.seekerProfile.findUnique({ where: { userId }, select: { id: true, deletedAt: true, onboardingStep: true } });
  }

  async function signInExisting(brand: ProductBrand, user: { id: string; isActive: boolean }, next: string | null | undefined): Promise<SignInResult> {
    if (user.isActive === false) throw new HttpError('forbidden', 'This account has been suspended.');
    const profile = await profileOf(user.id);
    if (profile?.deletedAt) throw new HttpError('forbidden', 'This account has been deleted.');
    return { userId: user.id, isNewUser: false, nextRoute: await routeAfterSignIn(brand, deps.env, profile?.onboardingStep ?? 'done', next) };
  }

  async function userByPhone(brand: ProductBrand, phoneE164: string) {
    return db.user.findFirst({ where: { brand: brand.id, phoneE164 }, select: { id: true, isActive: true } });
  }

  return {
    /** Code check for a send purpose that needs the signed-in user (bind / change). */
    async assertSendAllowed(
      brand: ProductBrand,
      purpose: OtpPurpose,
      phoneE164: string,
      userId: string | null,
    ): Promise<void> {
      if (purpose === 'login') return;
      if (!userId) throw new HttpError('unauthorized');
      const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, phoneE164: true } });
      if (!user) throw new HttpError('unauthorized');
      if (purpose === 'change_old') {
        if (user.phoneE164 !== phoneE164) throw new AuthCnError('phone_mismatch');
        return;
      }
      if (purpose === 'change_new') {
        if (user.phoneE164 === phoneE164) throw new AuthCnError('phone_mismatch', undefined, 'This is already the number on your account.');
        const other = await userByPhone(brand, phoneE164);
        if (other && other.id !== userId) throw new AuthCnError('phone_taken');
      }
    },

    async verifyAndSignIn(input: {
      brand: ProductBrand;
      phoneE164: string;
      code: string;
      consents?: ConsentInput[];
      inviteCode?: string;
      next?: string;
      locale?: string | null;
      ip: string;
      /** The invite-friends code from the signup link (`?ref=`); read only when the account is new. */
      ref?: string | null;
      /** Risk signals of this request for the invite check (hashed before storage). */
      signals?: RawSignals;
    }): Promise<SignInResult> {
      const { brand, phoneE164 } = input;
      // Check the code first (wrong codes count toward the lock), but spend it
      // only after the signup checks pass, so a missing consent or invite
      // does not cost the person a new code. Nothing about the number is
      // revealed before the code is proven.
      const { otpId } = await deps.otp.verifyCode({ brand: brand.id, phoneE164, purpose: 'login', code: input.code, ip: input.ip, consume: false });

      const existing = await userByPhone(brand, phoneE164);
      if (existing) {
        await deps.otp.spend(otpId);
        return signInExisting(brand, existing, input.next);
      }

      assertSignupOpen(deps.env);
      const consents = checkSignupConsents(input.consents, deps.env);
      const inviteRequired = cnSignupMode(deps.env) === 'invite';
      if (inviteRequired && !input.inviteCode) throw new AuthCnError('invite_invalid', { missing: true });
      if (inviteRequired && input.inviteCode) await assertInviteRedeemable(db, brand.id, input.inviteCode, deps.now());
      await deps.otp.spend(otpId);

      try {
        const userId = await db.$transaction(async (tx) => {
          if (inviteRequired && input.inviteCode) await redeemInviteIn(tx, brand.id, input.inviteCode, deps.now());
          return createGoApplyAccount(tx, {
            brand,
            provider: 'phone',
            phoneE164,
            consents,
            locale: input.locale,
            next: input.next,
            now: deps.now(),
          });
        });
        await afterAccountCreated(deps.hooks, userId, { ref: input.ref, signals: input.signals, phoneVerified: true, now: deps.now() });
        return { userId, isNewUser: true, nextRoute: await routeAfterSignIn(brand, deps.env, 'account', input.next) };
      } catch (err) {
        // Two first sign-ins with the same number at once: the loser signs in.
        if (isUniqueViolation(err)) {
          const winner = await userByPhone(brand, phoneE164);
          if (winner) return signInExisting(brand, winner, input.next);
        }
        throw err;
      }
    },

    async bind(input: {
      brand: ProductBrand;
      userId: string;
      phoneE164: string;
      code: string;
      next?: string;
      ip: string;
    }): Promise<{ userId: string; merged: boolean; nextRoute: string }> {
      const { brand, phoneE164 } = input;
      const me = await db.user.findUnique({
        where: { id: input.userId },
        select: { id: true, phoneE164: true, emailIsPlaceholder: true, passwordHash: true, createdAt: true, brand: true },
      });
      if (!me) throw new HttpError('unauthorized');
      if (me.phoneE164) throw new HttpError('conflict', 'This account already has a phone number. Use change instead.');

      await deps.otp.verifyCode({ brand: brand.id, phoneE164, purpose: 'bind', code: input.code, ip: input.ip });

      const owner = await userByPhone(brand, phoneE164);
      if (owner && owner.id !== me.id) {
        const profile = await profileOf(me.id);
        const ownerProfile = await profileOf(owner.id);
        const mergeable =
          me.emailIsPlaceholder &&
          !me.passwordHash &&
          deps.now().getTime() - me.createdAt.getTime() < MERGE_MAX_AGE_MS &&
          MERGEABLE_STAGES.has(profile?.onboardingStep ?? '');
        // The target must be usable BEFORE anything moves: never fold a new
        // account into a suspended or deleted one.
        if (!mergeable || owner.isActive === false || ownerProfile?.deletedAt) throw new AuthCnError('phone_taken');
        await db.$transaction(async (tx) => {
          await tx.rAAuthIdentity.updateMany({ where: { userId: me.id }, data: { userId: owner.id } });
          await tx.session.deleteMany({ where: { userId: me.id } });
          await tx.user.delete({ where: { id: me.id } });
        });
        // The caller's WeChat identity now belongs to the number's account: a
        // WeChat link to an existing account, so the invite check runs (soft).
        await afterWechatLinked(deps.hooks, owner.id);
        const signedIn = await signInExisting(brand, owner, input.next);
        return { userId: owner.id, merged: true, nextRoute: signedIn.nextRoute };
      }

      try {
        await db.user.update({ where: { id: me.id }, data: { phoneE164, phoneVerifiedAt: deps.now() } });
      } catch (err) {
        if (isUniqueViolation(err)) throw new AuthCnError('phone_taken');
        throw err;
      }
      await afterPhoneBound(deps.hooks, me.id);
      const profile = await profileOf(me.id);
      return {
        userId: me.id,
        merged: false,
        nextRoute: await routeAfterSignIn(brand, deps.env, profile?.onboardingStep ?? 'done', input.next),
      };
    },

    async change(input: {
      brand: ProductBrand;
      userId: string;
      oldCode?: string;
      identityProof?: { method: 'password' | 'wechat'; value: string };
      newPhoneE164: string;
      newCode: string;
      keepSessionToken: string | null;
      ip: string;
    }): Promise<{ phoneMasked: string; sessionsRevoked: number }> {
      const { brand } = input;
      const me = await db.user.findUnique({ where: { id: input.userId }, select: { id: true, phoneE164: true, passwordHash: true } });
      if (!me) throw new HttpError('unauthorized');
      if (!me.phoneE164) throw new HttpError('conflict', 'This account has no phone number yet. Bind one first.');
      if (me.phoneE164 === input.newPhoneE164) throw new AuthCnError('phone_mismatch', undefined, 'This is already the number on your account.');

      // 1. Check the old-number proof (nothing is spent yet).
      let oldOtpId: string | null = null;
      let wechatTokenId: string | null = null;
      if (input.oldCode) {
        ({ otpId: oldOtpId } = await deps.otp.verifyCode({
          brand: brand.id,
          phoneE164: me.phoneE164,
          purpose: 'change_old',
          code: input.oldCode,
          ip: input.ip,
          consume: false,
        }));
      } else if (input.identityProof?.method === 'password' || input.identityProof?.method === 'wechat') {
        // A stolen session is exactly what this step guards against: cap the guesses.
        const limit = await deps.consume(`rl:${brand.id}:phoneChangeProof:user:${hashIdentifier(me.id)}`, CHANGE_PROOF_WINDOWS);
        if (!limit.allowed) {
          throw new HttpError('rate_limited', undefined, { retryAfterSec: limit.retryAfterSec }, { 'Retry-After': String(limit.retryAfterSec) });
        }
        if (input.identityProof.method === 'password') {
          const ok = Boolean(me.passwordHash) && (await bcrypt.compare(input.identityProof.value, me.passwordHash as string));
          if (!ok) throw new AuthCnError('identity_proof_invalid');
        } else {
          const token = await db.rAAuthToken.findFirst({
            where: {
              tokenHash: sha256(input.identityProof.value),
              kind: 'wechat_reverify',
              userId: me.id,
              brand: brand.id,
              consumedAt: null,
              expiresAt: { gt: deps.now() },
            },
            select: { id: true },
          });
          if (!token) throw new AuthCnError('identity_proof_invalid');
          wechatTokenId = token.id;
        }
      } else {
        throw new AuthCnError('identity_proof_invalid');
      }

      // 2. Check the new number's code (nothing spent yet).
      const other = await userByPhone(brand, input.newPhoneE164);
      if (other && other.id !== me.id) throw new AuthCnError('phone_taken');
      const { otpId: newOtpId } = await deps.otp.verifyCode({
        brand: brand.id,
        phoneE164: input.newPhoneE164,
        purpose: 'change_new',
        code: input.newCode,
        ip: input.ip,
        consume: false,
      });

      // 3. Both passed: spend every proof (each single-use; a parallel spend loses).
      if (oldOtpId) await deps.otp.spend(oldOtpId);
      if (wechatTokenId) {
        const now = deps.now();
        const spent = await db.rAAuthToken.updateMany({ where: { id: wechatTokenId, consumedAt: null }, data: { consumedAt: now } });
        if (spent.count !== 1) throw new AuthCnError('identity_proof_invalid');
      }
      await deps.otp.spend(newOtpId);

      try {
        await db.user.update({ where: { id: me.id }, data: { phoneE164: input.newPhoneE164, phoneVerifiedAt: deps.now() } });
      } catch (err) {
        if (isUniqueViolation(err)) throw new AuthCnError('phone_taken');
        throw err;
      }
      // An account bound before the credit existed gets it now; the ledger key makes a repeat a no-op.
      await afterPhoneBound(deps.hooks, me.id);
      // 4. Sign out everywhere else.
      const revoked = await db.session.deleteMany({
        where: { userId: me.id, ...(input.keepSessionToken ? { token: { not: input.keepSessionToken } } : {}) },
      });
      return { phoneMasked: maskCnPhone(input.newPhoneE164) ?? '', sessionsRevoked: revoked.count };
    },

    /** The signed-in user's phone status (settings #security). */
    async status(userId: string): Promise<{ phoneMasked: string | null; hasPassword: boolean; hasWechat: boolean }> {
      const u = await db.user.findUnique({ where: { id: userId }, select: { phoneE164: true, phoneVerifiedAt: true, passwordHash: true } });
      if (!u) throw new HttpError('unauthorized');
      const wechat = await db.rAAuthIdentity.findFirst({ where: { userId, provider: 'wechat' }, select: { id: true } });
      return {
        phoneMasked: u.phoneVerifiedAt ? maskCnPhone(u.phoneE164) : null,
        hasPassword: Boolean(u.passwordHash),
        hasWechat: Boolean(wechat),
      };
    },

    safeNext,
  };
}

export type PhoneAuthService = ReturnType<typeof createPhoneAuthService>;
