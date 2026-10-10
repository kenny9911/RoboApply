// backend/src/seeker/services/SeekerAuthService.ts
//
// Seeker signup + login. Forks the shared User-creation path because the
// seeker product needs:
//   - role='seeker' and roles=['seeker'] set TOGETHER to satisfy the
//     role-invariant guard in lib/prisma.ts.
//   - SeekerProfile + first SeekerConsentRecord created in the same
//     transaction as the User row, so an interrupted signup never leaves
//     an orphan User without a SeekerProfile (and vice versa).
//   - Phone is INTENTIONALLY OPTIONAL — the recruiter-side signup flow
//     requires a phone number, but the seeker app is mobile-first /
//     consumer and asking for a phone number up front kills the funnel.
//
// Boundary: this file does NOT import from backend/src/services/*. JWT +
// session primitives live in backend/src/seeker/lib/seekerSession.ts so
// the seeker boundary check stays clean.

import bcrypt from 'bcryptjs';
import prisma from '../../../lib/prisma.js';
import { createSeekerSession, generateJwt } from '../lib/seekerSession.js';
import {
  normalizeLocale,
  type SeekerLocale,
  type SeekerMarket,
} from '../lib/seekerLocale.js';
import { clampLocaleToBrand, getBrand, parseBrandId, type BrandId } from '../../../platform/brand/registry.js';
import type { EnvSource } from '../../../platform/brand/brandEnv.js';
import { createSeekerAccount } from '../../../features/auth/accounts.js';
import {
  assertPassword,
  marketForSignup,
  onboardingEntryFrom,
  safeTimezone,
  validateSignupConsents,
  type ConsentRow,
  type SignupAttributionInput,
  type SignupConsentInput,
} from '../../../features/auth/signupPolicy.js';
import type { GoApplySignupPlan } from '../../../features/auth/goapplySignup.js';

const SALT_ROUNDS = 12;

export interface SeekerSignupInput {
  email: string;
  password: string;
  name?: string;
  locale?: string | null;
  /** Raw Accept-Language header — used to derive `market` for pricing. */
  acceptLanguage?: string | null;
  /** 'organic' (default) | 'invited' | 'imported'. */
  source?: string;
  /**
   * Product brand of the request (`req.brand.id`). Stamped on `User.brand`
   * (immutable afterwards); omitted → the column default ('roboapply').
   * requireAuth rejects a session whose user.brand differs from the host's
   * brand, so an unstamped GoApply signup would be unusable.
   */
  brand?: BrandId;
  /** Signup agreements (WP-10): `age_16_plus` required; `tw_pdpa_notice` for zh-TW/TW on RoboApply. */
  consents?: SignupConsentInput[];
  /** "Send me product news and tips" — unchecked by default; recorded as `marketing_email`. */
  marketingOptIn?: boolean;
  /** Entry attribution (F-ONB-02) → SeekerProfile.onboardingEntry. */
  attribution?: SignupAttributionInput;
  /** IANA time zone from the browser. */
  timezone?: string | null;
  /** Edge country (`x-vercel-ip-country`); only decides whether the PDPA notice applies. */
  country?: string | null;
  /**
   * GoApply only: the invite code. Required while `CN_SIGNUP_MODE=invite`
   * (the default); spent inside the account-creation transaction.
   */
  inviteCode?: string | null;
  /** Test seam for the GoApply signup rules (default `process.env`). */
  env?: EnvSource;
}

export interface SeekerLoginInput {
  email: string;
  password: string;
  /** Product brand of the request; a non-admin account of the other brand gets SeekerAccountOtherBrandError. */
  brand?: BrandId;
}

export interface SeekerAuthResult {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    subscriptionTier: string;
    locale: SeekerLocale | null;
    market: SeekerMarket | string;
  };
  /** SeekerProfile summary (id + flags) for client-side hydration. */
  seekerProfile: {
    id: string;
    source: string;
    readinessScore: number;
    locale: string | null;
  };
  /** JWT (7 day) — read by the frontend axios instance. */
  token: string;
  /** Opaque DB-backed session token — set as the `session_token` cookie. */
  sessionToken: string;
}

export class SeekerEmailTakenError extends Error {
  constructor() {
    super('An account with this email already exists');
    this.name = 'SeekerEmailTakenError';
  }
}

export class SeekerNotSeekerAccountError extends Error {
  constructor() {
    super('This account is not a seeker account');
    this.name = 'SeekerNotSeekerAccountError';
  }
}

export class SeekerAccountDeletedError extends Error {
  constructor() {
    super('This account has been deleted');
    this.name = 'SeekerAccountDeletedError';
  }
}

export class SeekerAccountDisabledError extends Error {
  constructor() {
    super('This account has been suspended. Contact support if you believe this is an error.');
    this.name = 'SeekerAccountDisabledError';
  }
}

/**
 * The password matched, but the account belongs to the other product brand
 * (ARCH §1 rule 5 / §3.2: `409 account_other_brand`, only after the password
 * checks out, so account existence never leaks to a wrong guess).
 */
export class SeekerAccountOtherBrandError extends Error {
  constructor(readonly accountBrand: BrandId) {
    super('This account belongs to another site.');
    this.name = 'SeekerAccountOtherBrandError';
  }
}

/**
 * Signup with an email that belongs to the OTHER brand (H34). Not shown to
 * the visitor: the route answers the normal "check your email" response and
 * emails the inbox where its account lives. `code` lets callers branch
 * without importing the class.
 */
export class SeekerEmailOtherBrandError extends Error {
  readonly code = 'signup_other_brand' as const;
  constructor(readonly accountBrand: BrandId) {
    super('This email belongs to an account on the other site.');
    this.name = 'SeekerEmailOtherBrandError';
  }
}

export class SeekerInvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'SeekerInvalidCredentialsError';
  }
}

export class SeekerWrongPasswordError extends Error {
  constructor() {
    super('Current password is incorrect');
    this.name = 'SeekerWrongPasswordError';
  }
}

export class SeekerNoPasswordError extends Error {
  constructor() {
    super('This account has no password set (OAuth sign-in)');
    this.name = 'SeekerNoPasswordError';
  }
}

async function signup(input: SeekerSignupInput): Promise<SeekerAuthResult> {
  const { email, password, name, locale, acceptLanguage } = input;

  if (!email || typeof email !== 'string') {
    throw new Error('Email is required');
  }
  // ≥8 characters with a letter and a digit (PRODUCT O0) → 422 weak_password.
  assertPassword(password);

  const normalizedEmail = email.toLowerCase().trim();
  // Fall THROUGH to Accept-Language when the explicit locale is unsupported.
  // `normalizeLocale(locale ?? acceptLanguage)` only consulted the header when
  // `locale` was absent: a caller passing an out-of-list tag ('zh-Hant-MO' is
  // fine, but 'it' or a stale cookie value is not) got null persisted, which
  // reads as English for every requestless background job. Callers now pass a
  // header/cookie-derived locale (roboapply/routes/auth.ts), so an unrecognised
  // value is a realistic input, not a programmer error.
  let resolvedLocale = normalizeLocale(locale) ?? normalizeLocale(acceptLanguage);
  const brandForPolicy: BrandId = input.brand ?? 'roboapply';

  // Agreements first (422 before anything is looked up or written).
  //   RoboApply: the required `age_16_plus`, the PDPA notice for zh-TW/TW and
  //   the marketing choice (unchecked by default).
  //   GoApply: features/auth/goapplySignup.ts — signup open (production needs
  //   the approved documents), the required consents incl. the CN-0
  //   cross-border one (each stored with the version and hash of the text the
  //   form showed, which the form sends back as `proseHash`) and,
  //   in invite mode, a redeemable invite code. The invite is spent inside
  //   the account-creation transaction below.
  let consentRows: ConsentRow[];
  let goapplyPlan: GoApplySignupPlan | null = null;
  if (input.brand === 'goapply') {
    resolvedLocale = clampLocaleToBrand(getBrand('goapply'), resolvedLocale) as SeekerLocale;
    const { planGoApplyEmailSignup } = await import('../../../features/auth/goapplySignup.js');
    goapplyPlan = await planGoApplyEmailSignup(
      { consents: input.consents, inviteCode: input.inviteCode },
      { env: input.env },
    );
    consentRows = goapplyPlan.consentRows;
  } else {
    consentRows = validateSignupConsents({
      brand: brandForPolicy,
      consents: input.consents,
      marketingOptIn: input.marketingOptIn,
      locale: resolvedLocale,
      country: input.country ?? null,
    });
  }

  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, brand: true },
  });
  if (existing) {
    const existingBrand = parseBrandId(existing.brand);
    if (input.brand && existingBrand && existingBrand !== input.brand) {
      // H34: no 409 here — the route answers "check your email" and the
      // inbox gets the cross-brand notice.
      throw new SeekerEmailOtherBrandError(existingBrand);
    }
    throw new SeekerEmailTakenError();
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  // ARCH §1.10: GoApply → 'cn'; RoboApply → 'tw' / 'jp' / 'other' from the
  // locale the visitor chose (not from Accept-Language).
  const market = marketForSignup(brandForPolicy, resolvedLocale);
  const source = input.source ?? 'organic';

  // One transaction: User + SeekerProfile (onboardingStep 'account', entry,
  // timezone) + the consent rows. The role invariant guard in lib/prisma.ts
  // enforces roles[0] === role on the User create; createSeekerAccount sets
  // both together.
  const plan = goapplyPlan;
  const created = await prisma.$transaction(async (tx) => {
    // GoApply invite mode: a failed redemption (AuthCnError invite_invalid)
    // rolls the whole signup back; nothing is created.
    if (plan) await plan.redeemInvite(tx);
    return createSeekerAccount(tx, {
      email: normalizedEmail,
      passwordHash,
      name: name ?? null,
      provider: 'email',
      emailVerified: false,
      ...(input.brand ? { brand: input.brand } : {}),
      market,
      locale: resolvedLocale,
      source,
      consentRows,
      entry: onboardingEntryFrom(input.attribution),
      timezone: safeTimezone(input.timezone),
    });
  });

  const session = await createSeekerSession(created.user.id);
  const token = generateJwt({ id: created.user.id, email: created.user.email });

  return {
    user: {
      id: created.user.id,
      email: created.user.email,
      name: created.user.name,
      role: created.user.role,
      subscriptionTier: created.user.subscriptionTier,
      locale: resolvedLocale,
      market: created.user.market,
    },
    seekerProfile: created.profile,
    token,
    sessionToken: session.token,
  };
}

async function login(input: SeekerLoginInput): Promise<SeekerAuthResult> {
  const { email, password } = input;
  if (!email || !password) throw new SeekerInvalidCredentialsError();
  const normalizedEmail = email.toLowerCase().trim();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      passwordHash: true,
      subscriptionTier: true,
      market: true,
      brand: true,
      seekerProfile: {
        select: {
          id: true,
          source: true,
          readinessScore: true,
          locale: true,
          deletedAt: true,
        },
      },
    },
  });
  if (!user || !user.passwordHash) throw new SeekerInvalidCredentialsError();
  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) throw new SeekerInvalidCredentialsError();

  // Hard admin-disable gate — mirror the recruiter AuthService.login and the
  // requireAuth middleware so a suspended account is rejected cleanly HERE with
  // a clear message, instead of getting a session cookie and then being
  // silently bounced by /me's 401 (which the client swallows).
  if (user.isActive === false) throw new SeekerAccountDisabledError();

  // Brand gate (mirrors requireAuth's `auth_other_brand`): never mint a
  // session that the next authenticated call would reject. Admins are exempt,
  // as they are in requireAuth.
  const accountBrand = parseBrandId(user.brand);
  if (input.brand && accountBrand && accountBrand !== input.brand && user.role !== 'admin') {
    throw new SeekerAccountOtherBrandError(accountBrand);
  }

  // Admins use the RoboApply candidate product but never went through the
  // seeker signup funnel, so they have no SeekerProfile. requireSeekerProfile
  // (/me) lazily provisions one for them — but login runs BEFORE /me is ever
  // reached, so without the same bypass an admin can never obtain a session
  // (403 not_a_seeker_account). Provision on demand to keep login and the /me
  // gate symmetric. `upsert` is race-safe against the parallel /me calls the
  // shell fires on load.
  let seekerProfile = user.seekerProfile;
  if (!seekerProfile && user.role === 'admin') {
    seekerProfile = await prisma.seekerProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id, source: 'admin' },
      update: {},
      select: {
        id: true,
        source: true,
        readinessScore: true,
        locale: true,
        deletedAt: true,
      },
    });
  }

  if (!seekerProfile) throw new SeekerNotSeekerAccountError();
  if (seekerProfile.deletedAt) throw new SeekerAccountDeletedError();

  const session = await createSeekerSession(user.id);
  const token = generateJwt({ id: user.id, email: user.email });

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      subscriptionTier: user.subscriptionTier,
      locale: normalizeLocale(seekerProfile.locale),
      market: user.market,
    },
    seekerProfile: {
      id: seekerProfile.id,
      source: seekerProfile.source,
      readinessScore: seekerProfile.readinessScore,
      locale: seekerProfile.locale,
    },
    token,
    sessionToken: session.token,
  };
}

/**
 * Change a seeker's password. Verifies the current password, hashes the new
 * one (bcrypt, same SALT_ROUNDS as signup), and — by default — revokes every
 * OTHER session so a stolen cookie can't outlive a password change. Pass
 * `keepSessionToken` to preserve the caller's current session.
 */
async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  keepSessionToken?: string | null;
}): Promise<void> {
  const { userId, currentPassword, newPassword, keepSessionToken } = input;
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new Error('New password must be at least 8 characters long');
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user) throw new SeekerInvalidCredentialsError();
  if (!user.passwordHash) throw new SeekerNoPasswordError();
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new SeekerWrongPasswordError();

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  // Revoke other sessions (defense-in-depth on a credential change).
  await prisma.session.deleteMany({
    where: { userId, ...(keepSessionToken ? { token: { not: keepSessionToken } } : {}) },
  });
}

/** Revoke every session for a user ("sign out everywhere"). */
async function revokeAllSessions(userId: string): Promise<number> {
  const res = await prisma.session.deleteMany({ where: { userId } });
  return res.count;
}

/**
 * GDPR soft-delete, shared by both account-delete routes (roboapply/routes/
 * account.ts and settings.ts): stamp SeekerProfile.deletedAt — login then
 * throws SeekerAccountDeletedError — and revoke every session. The nightly
 * account-purge sweep (SeekerAccountPurgeService) hard-deletes storage
 * artifacts + the User row once the retention window elapses. The deletedAt
 * stamp is first-write-wins (`deletedAt: null` guard) so a repeat call can
 * never reset the retention clock; callers treat repeats as success.
 */
async function softDeleteAccount(userId: string): Promise<{ profilesMarked: number; sessionsRevoked: number }> {
  const { count: profilesMarked } = await prisma.seekerProfile.updateMany({
    where: { userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  const sessionsRevoked = await revokeAllSessions(userId);
  return { profilesMarked, sessionsRevoked };
}

export const seekerAuthService = {
  signup,
  login,
  changePassword,
  revokeAllSessions,
  softDeleteAccount,
  normalizeLocale,
};

export default seekerAuthService;
