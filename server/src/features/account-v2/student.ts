// server/src/features/account-v2/student.ts
//
// Student verification by school email (F-ACCT-02, V2; unlocks the student
// plans, PRODUCT_PLAN.md §6.3). The user types a school address; we email a
// 6-digit code to it; entering the code proves they can read that inbox.
//
// Rules:
//   - eligible addresses: `*.edu`, `*.edu.<cc>`, `*.ac.<cc>` (e.g. ac.uk,
//     ac.jp), plus the schools listed in STUDENT_EMAIL_DOMAINS (comma list,
//     e.g. "ethz.ch,tum.de"). Alumni addresses (`alumni.` / `alum.`) and
//     disposable inboxes are refused;
//   - one school address backs one account: an address already verified by
//     another account is refused. The refusal comes at confirm time, after
//     the code proves the person can read that inbox, so the send step never
//     tells anyone whether an address is in use (no lookup oracle);
//   - codes last 15 minutes, 5 tries; at most 3 codes an hour, 10 a day,
//     counted before any lookup;
//   - a code for a new address is held as "pending" next to the current
//     verification; the current one stays until the new code is confirmed;
//   - a verification lasts 12 months, then the student verifies again;
//   - the school address is never stored (only its hash and domain).

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { classifyEmailDomain } from '../../lib/emailDomainPolicy.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { HttpError, type ErrorCode } from '../../platform/http.js';
import {
  ACCOUNT_V2_ERROR_CODES,
  STUDENT_CODE_MAX_ATTEMPTS,
  STUDENT_CODE_TTL_MIN,
  STUDENT_VERIFICATION_MONTHS,
  type StudentCodeSentResponse,
  type StudentStatus,
} from './contract.js';
import { createPrismaStudentStore, type StudentRow, type StudentStore } from './store.js';

export const STUDENT_DOMAINS_ENV = 'STUDENT_EMAIL_DOMAINS';
export const STUDENT_CODE_EMAIL = 'account.student_code';

export interface StudentDeps {
  store: StudentStore;
  env: () => EnvSource;
  now: () => Date;
  /** Sends the code; resolves to the send status ('sent' | 'failed' | 'suppressed'). */
  sendCode: (input: { to: string; userId: string; brand: ProductBrand; locale: string | null; code: string; minutes: number }) => Promise<string>;
  /** Counts one send for this user; false when over 3 an hour / 10 a day. */
  sendAllowed: (userId: string) => Promise<boolean>;
}

function fail(code: ErrorCode, reason: string, message: string): HttpError {
  return new HttpError(code, message, { reason });
}

function storageError(): HttpError {
  return new HttpError('storage_unavailable', 'Student verification is not available yet.', { reason: 'storage_unavailable' });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashSchoolEmail(email: string): string {
  return sha256(`ra-school:${email.trim().toLowerCase()}`);
}

function hashCode(userId: string, code: string): string {
  return sha256(`ra-student-code:${userId}:${code}`);
}

function allowlist(env: EnvSource): string[] {
  return (env[STUDENT_DOMAINS_ENV] ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
}

/**
 * The school domain of an eligible address, or null. Pure; exported for tests.
 * Subdomains of an allowlisted school count (`cs.ethz.ch` under `ethz.ch`).
 */
export function eligibleSchoolDomain(email: string, env: EnvSource = {}): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || domain.includes('..')) return null;
  const labels = domain.split('.');
  if (labels.some((l) => l === 'alumni' || l === 'alum')) return null;
  if (classifyEmailDomain(email).reason === 'disposable') return null;
  const listed = allowlist(env).find((d) => domain === d || domain.endsWith(`.${d}`));
  if (listed) return listed;
  const n = labels.length;
  if (n >= 2 && labels[n - 1] === 'edu') return domain;
  if (n >= 3 && (labels[n - 2] === 'edu' || labels[n - 2] === 'ac') && /^[a-z]{2}$/.test(labels[n - 1]!)) return domain;
  return null;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function isLive(row: StudentRow | null, now: Date): boolean {
  return Boolean(row?.verifiedAt && row.expiresAt && row.expiresAt > now);
}

export function defaultStudentDeps(): StudentDeps {
  return {
    store: createPrismaStudentStore(),
    env: () => process.env,
    now: () => new Date(),
    async sendCode({ to, userId, brand, locale, code, minutes }) {
      await import('./emails.js');
      const { sendEmail } = await import('../../platform/email/index.js');
      const res = await sendEmail({ template: STUDENT_CODE_EMAIL, to, userId, locale, brand: brand.id, params: { code, minutes } });
      return res.status;
    },
    async sendAllowed(userId) {
      const { consumeRateLimit, rateLimitKey, HOUR, DAY } = await import('../../platform/ratelimit/index.js');
      const r = await consumeRateLimit({
        key: rateLimitKey('studentCodePerUser', 'user', userId),
        windows: [
          { limit: 3, windowSec: HOUR },
          { limit: 10, windowSec: DAY },
        ],
      });
      return r.allowed;
    },
  };
}

export class StudentService {
  constructor(private readonly d: StudentDeps) {}

  async status(userId: string): Promise<StudentStatus> {
    if (!this.d.store.available()) {
      return { verified: false, schoolDomain: null, verifiedAt: null, expiresAt: null, pendingDomain: null, available: false };
    }
    const now = this.d.now();
    const row = await this.d.store.find(userId);
    const live = isLive(row, now);
    const pending = row?.codeHash && row.codeExpiresAt && row.codeExpiresAt > now && row.codeAttempts < STUDENT_CODE_MAX_ATTEMPTS;
    return {
      verified: live,
      schoolDomain: live ? row!.schoolDomain : null,
      verifiedAt: live ? row!.verifiedAt!.toISOString() : null,
      expiresAt: live ? row!.expiresAt!.toISOString() : null,
      pendingDomain: pending ? (row!.pendingDomain ?? row!.schoolDomain) : null,
      available: true,
    };
  }

  /** True while the user holds a live verification (checkout seam for the student plans). */
  async isVerified(userId: string): Promise<boolean> {
    if (!this.d.store.available()) return false;
    return isLive(await this.d.store.find(userId), this.d.now());
  }

  async sendCode(userId: string, brand: ProductBrand, schoolEmail: string, locale: string | null): Promise<StudentCodeSentResponse> {
    if (!this.d.store.available()) throw storageError();
    const domain = eligibleSchoolDomain(schoolEmail, this.d.env());
    if (!domain) {
      throw fail('invalid_request', ACCOUNT_V2_ERROR_CODES.schoolDomainNotEligible, 'Use the email address your school gave you (for example one ending in .edu).');
    }
    // Count the send before anything is looked up, so probing addresses costs a send each.
    if (!(await this.d.sendAllowed(userId))) {
      throw new HttpError('rate_limited', 'Too many codes. Try again in an hour.', { retryAfterSec: 3600 });
    }
    const now = this.d.now();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + STUDENT_CODE_TTL_MIN * 60_000);
    await this.d.store.saveCode({
      userId,
      brand: brand.id,
      pendingEmailHash: hashSchoolEmail(schoolEmail),
      pendingDomain: domain,
      codeHash: hashCode(userId, code),
      codeExpiresAt: expiresAt,
    });
    const status = await this.d.sendCode({ to: schoolEmail, userId, brand, locale, code, minutes: STUDENT_CODE_TTL_MIN });
    if (status !== 'sent') {
      throw fail('provider_not_configured', ACCOUNT_V2_ERROR_CODES.emailUnavailable, 'We could not send the email right now. Try again later.');
    }
    return { schoolDomain: domain, expiresAt: expiresAt.toISOString() };
  }

  async confirm(userId: string, code: string): Promise<StudentStatus> {
    if (!this.d.store.available()) throw storageError();
    const now = this.d.now();
    const row = await this.d.store.find(userId);
    if (!row?.codeHash || !row.codeExpiresAt) {
      throw fail('invalid_request', ACCOUNT_V2_ERROR_CODES.codeExpired, 'Send yourself a new code first.');
    }
    if (row.codeExpiresAt <= now || row.codeAttempts >= STUDENT_CODE_MAX_ATTEMPTS) {
      throw fail('invalid_request', ACCOUNT_V2_ERROR_CODES.codeExpired, 'This code has expired. Send a new one.');
    }
    const expected = Buffer.from(row.codeHash);
    const given = Buffer.from(hashCode(userId, code));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      const attempts = await this.d.store.countAttempt(userId);
      throw new HttpError('invalid_request', 'That code did not work.', {
        reason: ACCOUNT_V2_ERROR_CODES.codeInvalid,
        attemptsLeft: Math.max(0, STUDENT_CODE_MAX_ATTEMPTS - attempts),
      });
    }
    const emailHash = row.pendingEmailHash ?? row.schoolEmailHash;
    const domain = row.pendingDomain ?? row.schoolDomain;
    // One address backs one account. Checked only now, after the code proved
    // this person reads that inbox, so the answer is never an address lookup.
    if (await this.d.store.verifiedByOther(emailHash, userId, now)) {
      throw fail('conflict', ACCOUNT_V2_ERROR_CODES.schoolEmailInUse, 'This school email is already verified on another account.');
    }
    // The pending address replaces the current one only here.
    await this.d.store.markVerified(userId, {
      schoolEmailHash: emailHash,
      schoolDomain: domain,
      verifiedAt: now,
      expiresAt: addMonths(now, STUDENT_VERIFICATION_MONTHS),
    });
    return this.status(userId);
  }
}
