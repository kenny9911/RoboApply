// server/src/features/auth-cn/otpService.ts — SMS one-time codes (TASK_PLAN.md WP-11;
// PRODUCT_PLAN.md G0 #3; CN_TW_LAUNCH_PLAN.md CN-L-07).
//
// Rules (acceptance):
//   - 6 digits from crypto.randomInt; only an HMAC-SHA256 of
//     brand|phone|purpose|code is stored (`RAPhoneOtp.codeHash`); 5 min expiry.
//   - A new code supersedes the unused ones for the same phone and purpose.
//   - Limits, all persisted in `RARateCounter` (DB, never in memory):
//     1 send / 60 s and 10 / day per phone; 10 / hour and 30 / day per IP;
//     `SMS_DAILY_MAX` codes per brand per day — fail closed: when a counter
//     cannot be read no code is sent.
//   - 5 wrong tries on a code → that code is spent and the number is locked
//     for 30 minutes (sending and verifying), stored as a `lock:` counter row
//     whose `expiresAt` is the end of the lock. The wrong-try counter is
//     incremented atomically in the database (`attempts: { increment: 1 }`)
//     and the lock decision is taken from the stored value, so parallel
//     wrong guesses cannot all read the same old count.
//   - Send order: lock → per-IP → per-phone → brand daily cap, so a sender
//     already over its own IP limit never uses up a victim's per-phone budget.
//   - The SMS carries only the brand signature and the code (no links).

import crypto from 'node:crypto';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { BrandId } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import { consumeRateLimit, hashIdentifier, type RateLimitResult } from '../../platform/ratelimit/index.js';
import { DAY, HOUR, MINUTE, type RateWindow } from '../../platform/ratelimit/defaults.js';
import type { SmsService } from '../../platform/sms/index.js';
import { OTP_POLICY, type OtpPurpose } from './contract.js';
import { isUniqueViolation, type AuthCnDb } from './db.js';
import { AuthCnError } from './errors.js';

export const OTP_WINDOWS = {
  perPhone: [
    { limit: 1, windowSec: OTP_POLICY.resendAfterSec },
    { limit: OTP_POLICY.perPhonePerDay, windowSec: DAY },
  ],
  perIp: [
    { limit: OTP_POLICY.perIpPerHour, windowSec: HOUR },
    { limit: OTP_POLICY.perIpPerDay, windowSec: DAY },
  ],
  /** Verify attempts per IP (on top of the per-code attempt limit). */
  verifyPerIp: [{ limit: 10, windowSec: MINUTE }],
} as const satisfies Record<string, readonly RateWindow[]>;

/** The epoch `windowStart` marks a lock row (one per phone; `expiresAt` = lock end). */
const LOCK_WINDOW_START = new Date(0);

export type ConsumeFn = (key: string, windows: readonly RateWindow[]) => Promise<RateLimitResult>;

export interface OtpDeps {
  db: AuthCnDb;
  sms: Pick<SmsService, 'sendOtp'>;
  consume: ConsumeFn;
  now: () => Date;
  env: EnvSource;
  /** HMAC key for code hashes (a function is read lazily, on the first code). */
  secret: string | (() => string);
  brandName: (brand: BrandId) => string;
}

const DEV_OTP_SECRET = 'development-secret-change-in-production';

/**
 * The code-hashing key (`JWT_SECRET`). Production never falls back to a known
 * key: with `JWT_SECRET` unset it throws, so no code is sent or checked.
 */
export function otpSecret(env: EnvSource = process.env): string {
  const secret = (env.JWT_SECRET || '').trim();
  if (secret) return secret;
  if (env.NODE_ENV === 'production') throw new Error('JWT_SECRET is required to hash sign-in codes in production.');
  return DEV_OTP_SECRET;
}

export function defaultConsume(): ConsumeFn {
  return (key, windows) => consumeRateLimit({ key, windows });
}

/** `SMS_DAILY_MAX` (positive integer) or the default. */
export function smsDailyMax(env: EnvSource): number {
  const n = Number.parseInt((env.SMS_DAILY_MAX ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : OTP_POLICY.defaultSmsDailyMax;
}

export function hashOtp(secret: string, brand: BrandId, phoneE164: string, purpose: OtpPurpose, code: string): string {
  return crypto.createHmac('sha256', secret).update(`${brand}|${phoneE164}|${purpose}|${code}`).digest('hex');
}

export function generateOtpCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb);
}

function lockKey(brand: BrandId, phoneE164: string): string {
  return `lock:${brand}:otp:${hashIdentifier(phoneE164)}`;
}

function rlKey(brand: BrandId, name: string, id: string): string {
  return `rl:${brand}:${name}:id:${hashIdentifier(id)}`;
}

function rateLimited(result: RateLimitResult): HttpError {
  return new HttpError('rate_limited', undefined, { retryAfterSec: result.retryAfterSec }, { 'Retry-After': String(result.retryAfterSec) });
}

export interface SendCodeInput {
  brand: BrandId;
  phoneE164: string;
  purpose: OtpPurpose;
  ip: string;
  /** Test hook: a fixed code. */
  code?: string;
}

export interface VerifyCodeInput {
  brand: BrandId;
  phoneE164: string;
  purpose: OtpPurpose;
  code: string;
  ip?: string;
  /** false: check only; the caller spends the code with `spend(otpId)` once its own checks pass. Default true. */
  consume?: boolean;
}

export function createOtpService(deps: OtpDeps) {
  const { db } = deps;
  const secret = (): string => (typeof deps.secret === 'function' ? deps.secret() : deps.secret);

  async function lockedFor(brand: BrandId, phoneE164: string): Promise<number | null> {
    const now = deps.now();
    const row = await db.rARateCounter.findFirst({
      where: { key: lockKey(brand, phoneE164), expiresAt: { gt: now } },
      select: { expiresAt: true },
    });
    if (!row) return null;
    return Math.max(1, Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000));
  }

  async function lock(brand: BrandId, phoneE164: string): Promise<number> {
    const key = lockKey(brand, phoneE164);
    const until = new Date(deps.now().getTime() + OTP_POLICY.lockMinutes * 60_000);
    await db.rARateCounter.deleteMany({ where: { key } });
    try {
      await db.rARateCounter.create({ data: { key, windowStart: LOCK_WINDOW_START, count: 1, expiresAt: until } });
    } catch (err) {
      // A parallel wrong guess wrote the same lock row first: the number is locked either way.
      if (!isUniqueViolation(err)) throw err;
    }
    return OTP_POLICY.lockMinutes * 60;
  }

  async function assertNotLocked(brand: BrandId, phoneE164: string): Promise<void> {
    const retryAfterSec = await lockedFor(brand, phoneE164);
    if (retryAfterSec !== null) throw new AuthCnError('otp_locked', { retryAfterSec });
  }

  return {
    lockedFor,

    /** Sends a code. Throws on lock, limits, the daily cap or a provider failure. */
    async sendCode(input: SendCodeInput): Promise<{ resendInSec: number }> {
      const { brand, phoneE164, purpose } = input;
      const key = secret(); // production without JWT_SECRET: throws before any counter or code is touched
      await assertNotLocked(brand, phoneE164);

      // The IP first: a request blocked there never counts against the number.
      const ip = await deps.consume(rlKey(brand, 'otpPerIp', input.ip), OTP_WINDOWS.perIp);
      if (!ip.allowed) throw rateLimited(ip);
      const phone = await deps.consume(rlKey(brand, 'otpPerPhone', phoneE164), OTP_WINDOWS.perPhone);
      if (!phone.allowed) throw rateLimited(phone);
      const daily = await deps.consume(`rl:${brand}:smsDaily:all:global`, [{ limit: smsDailyMax(deps.env), windowSec: DAY }]);
      if (!daily.allowed) throw new AuthCnError('sms_daily_cap', { retryAfterSec: daily.retryAfterSec });

      const now = deps.now();
      await db.rAPhoneOtp.updateMany({
        where: { brand, phoneE164, purpose, consumedAt: null },
        data: { consumedAt: now },
      });
      const code = input.code ?? generateOtpCode();
      const row = await db.rAPhoneOtp.create({
        data: {
          brand,
          phoneE164,
          purpose,
          codeHash: hashOtp(key, brand, phoneE164, purpose, code),
          ipHash: hashIdentifier(input.ip),
          expiresAt: new Date(now.getTime() + OTP_POLICY.codeTtlSec * 1000),
        },
        select: { id: true },
      });

      let sent = false;
      try {
        sent = (await deps.sms.sendOtp({ phoneE164, code, brandName: deps.brandName(brand) })).ok;
      } catch {
        sent = false;
      }
      if (!sent) {
        await db.rAPhoneOtp.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: deps.now() } });
        throw new AuthCnError('sms_send_failed');
      }
      return { resendInSec: OTP_POLICY.resendAfterSec };
    },

    /** Spends a code checked with `consume: false`. Throws otp_invalid when it was spent meanwhile. */
    async spend(otpId: string): Promise<void> {
      const spent = await db.rAPhoneOtp.updateMany({ where: { id: otpId, consumedAt: null }, data: { consumedAt: deps.now() } });
      if (spent.count !== 1) throw new AuthCnError('otp_invalid', { attemptsLeft: null });
    },

    /** Checks (and by default spends) a code. Throws otp_invalid / otp_expired / otp_locked. */
    async verifyCode(input: VerifyCodeInput): Promise<{ otpId: string }> {
      const { brand, phoneE164, purpose } = input;
      const key = secret();
      await assertNotLocked(brand, phoneE164);
      if (input.ip) {
        const ipCheck = await deps.consume(rlKey(brand, 'otpVerifyPerIp', input.ip), OTP_WINDOWS.verifyPerIp);
        if (!ipCheck.allowed) throw rateLimited(ipCheck);
      }
      const now = deps.now();
      const row = await db.rAPhoneOtp.findFirst({
        where: { brand, phoneE164, purpose, consumedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, codeHash: true, attempts: true, expiresAt: true },
      });
      if (!row) throw new AuthCnError('otp_invalid', { attemptsLeft: null });
      if (row.expiresAt.getTime() <= now.getTime()) {
        await db.rAPhoneOtp.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: now } });
        throw new AuthCnError('otp_expired');
      }
      const expected = hashOtp(key, brand, phoneE164, purpose, input.code);
      if (!safeEqualHex(expected, row.codeHash)) {
        // Atomic increment (UPDATE … SET attempts = attempts + 1); the decision
        // uses the stored count, never the value read above.
        const bumped = await db.rAPhoneOtp.updateMany({ where: { id: row.id, consumedAt: null }, data: { attempts: { increment: 1 } } });
        if (bumped.count !== 1) {
          // Spent meanwhile (locked by a parallel wrong guess, superseded or used).
          await assertNotLocked(brand, phoneE164);
          throw new AuthCnError('otp_invalid', { attemptsLeft: null });
        }
        const stored = await db.rAPhoneOtp.findUnique({ where: { id: row.id }, select: { attempts: true } });
        const attempts = stored?.attempts ?? OTP_POLICY.wrongAttemptsBeforeLock;
        if (attempts >= OTP_POLICY.wrongAttemptsBeforeLock) {
          await db.rAPhoneOtp.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: now } });
          const retryAfterSec = await lock(brand, phoneE164);
          throw new AuthCnError('otp_locked', { retryAfterSec });
        }
        throw new AuthCnError('otp_invalid', { attemptsLeft: OTP_POLICY.wrongAttemptsBeforeLock - attempts });
      }
      if (input.consume !== false) {
        const spent = await db.rAPhoneOtp.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: now } });
        if (spent.count !== 1) throw new AuthCnError('otp_invalid', { attemptsLeft: null });
      }
      return { otpId: row.id };
    },
  };
}

export type OtpService = ReturnType<typeof createOtpService>;
