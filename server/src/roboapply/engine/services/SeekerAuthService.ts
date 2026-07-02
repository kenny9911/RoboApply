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
  marketFromAcceptLanguage,
  normalizeLocale,
  type SeekerLocale,
  type SeekerMarket,
} from '../lib/seekerLocale.js';
import { SEEKER_CONSENT_PROSE_VERSION } from '../lib/seekerConsentTypes.js';

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
}

export interface SeekerLoginInput {
  email: string;
  password: string;
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
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (existing) {
    throw new SeekerEmailTakenError();
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const resolvedLocale = normalizeLocale(locale ?? acceptLanguage);
  const market = marketFromAcceptLanguage(acceptLanguage ?? null);
  const source = input.source ?? 'organic';

  // One transaction: User + SeekerProfile + initial consent row. The role
  // invariant guard in lib/prisma.ts enforces roles[0] === role on the User
  // create, so we set both together.
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        name: name ?? null,
        provider: 'email',
        role: 'seeker',
        roles: ['seeker'],
        market,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        subscriptionTier: true,
        market: true,
      },
    });
    const profile = await tx.seekerProfile.create({
      data: {
        userId: user.id,
        source,
        locale: resolvedLocale,
        market,
        // Audit row for the implicit "I'm signing up for the seeker app"
        // consent. Surface-specific consents (biometric, auto-apply, etc.)
        // are collected at the screen that needs them.
        consentRecords: {
          create: {
            consentType: 'seeker_app_optin',
            granted: true,
            proseVersion: SEEKER_CONSENT_PROSE_VERSION,
          },
        },
      },
      select: { id: true, source: true, readinessScore: true, locale: true },
    });
    return { user, profile };
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
      passwordHash: true,
      subscriptionTier: true,
      market: true,
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

  if (!user.seekerProfile) throw new SeekerNotSeekerAccountError();
  if (user.seekerProfile.deletedAt) throw new SeekerAccountDeletedError();

  const session = await createSeekerSession(user.id);
  const token = generateJwt({ id: user.id, email: user.email });

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      subscriptionTier: user.subscriptionTier,
      locale: normalizeLocale(user.seekerProfile.locale),
      market: user.market,
    },
    seekerProfile: {
      id: user.seekerProfile.id,
      source: user.seekerProfile.source,
      readinessScore: user.seekerProfile.readinessScore,
      locale: user.seekerProfile.locale,
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

export const seekerAuthService = {
  signup,
  login,
  changePassword,
  revokeAllSessions,
  normalizeLocale,
};

export default seekerAuthService;
