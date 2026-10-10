// server/src/features/auth-cn/hooks.ts — what happens around a GoApply account
// besides signing in (INT-01; requests R-60-3, WP-60 #6, WP-43 → WP-11):
//
//   account created   the invite-friends code the visitor arrived with (`ref`)
//                     is handed to growth.recordAttribution with the request's
//                     risk signals, so a friend who signs up by phone or
//                     WeChat counts like one who signs up by email; a number
//                     verified at signup grants the free practice credit.
//   phone bound       the free practice credit (once per account: the ledger
//                     key is `phone_verified`, so binding again or changing
//                     the number grants nothing more), then the invite check
//                     (a verified phone can complete a friend's invite).
//   WeChat linked     the invite check.
//
// Every hook is soft: a failure is logged and never fails the sign-in, the
// bind or the change. The services take the hooks as a dependency; without
// one nothing runs (unit tests), and `createAuthCnServices` wires the
// production seams (growth, platform credits) through lazy imports.

import { logger } from '../../services/LoggerService.js';
import type { RawSignals, RecordAttributionOptions, Touch } from '../growth/index.js';

export interface AccountHooks {
  recordAttribution(userId: string, touch: Touch, options: RecordAttributionOptions): Promise<unknown>;
  checkReferral(userId: string): Promise<unknown>;
  /** Grants the `phone_verified` practice credit (idempotent per account). */
  grantPhoneCredit(userId: string): Promise<unknown>;
}

/** Idempotency key and reason of the phone-verification practice credit. */
export const PHONE_VERIFIED_GRANT = 'phone_verified' as const;

/** The production seams. Imports are lazy so this module stays cheap to load. */
export function defaultAccountHooks(): AccountHooks {
  return {
    recordAttribution: async (userId, touch, options) => (await import('../growth/index.js')).recordAttribution(userId, touch, options),
    checkReferral: async (userId) => (await import('../growth/index.js')).checkReferralFor(userId),
    grantPhoneCredit: async (userId) =>
      (await import('../../platform/credits/index.js')).grantPracticeCredit(userId, PHONE_VERIFIED_GRANT, PHONE_VERIFIED_GRANT),
  };
}

async function softly(what: string, userId: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    const warn = (logger as unknown as { warn?: (tag: string, msg: string, meta: unknown) => void }).warn;
    warn?.call(logger, 'AUTH_CN', `${what} failed (sign-in continues)`, { userId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** An invite-friends code as carried in a link: printable, at most 64 characters, or null. */
export function cleanRef(ref: string | null | undefined): string | null {
  if (typeof ref !== 'string') return null;
  const value = ref.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return value || null;
}

export interface NewAccountContext {
  /** The invite-friends code from the signup link (`?ref=`), if any. */
  ref?: string | null;
  /** IP, user agent and `ra_anon` id of the request that created the account. */
  signals?: RawSignals;
  /** The account was created with a verified phone number. */
  phoneVerified: boolean;
  now: Date;
}

export async function afterAccountCreated(hooks: AccountHooks | undefined, userId: string, ctx: NewAccountContext): Promise<void> {
  if (!hooks) return;
  const ref = cleanRef(ctx.ref);
  if (ref) {
    // Functional attribution only (the referral); growth attaches the invite.
    const touch: Touch = { ref, at: ctx.now.toISOString() };
    await softly('invite attribution', userId, () => hooks.recordAttribution(userId, touch, { signals: ctx.signals }));
  }
  if (ctx.phoneVerified) await softly('phone practice credit', userId, () => hooks.grantPhoneCredit(userId));
}

/** A verified phone number was added to (or changed on) an existing account. */
export async function afterPhoneBound(hooks: AccountHooks | undefined, userId: string): Promise<void> {
  if (!hooks) return;
  await softly('phone practice credit', userId, () => hooks.grantPhoneCredit(userId));
  await softly('invite check', userId, () => hooks.checkReferral(userId));
}

/** A WeChat identity was linked to an existing account. */
export async function afterWechatLinked(hooks: AccountHooks | undefined, userId: string): Promise<void> {
  if (!hooks) return;
  await softly('invite check', userId, () => hooks.checkReferral(userId));
}
