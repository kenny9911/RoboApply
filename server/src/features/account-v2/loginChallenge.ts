// server/src/features/account-v2/loginChallenge.ts
//
// The second step of signing in (F-TRUST-07). A sign-in path that has just
// checked the first factor and minted a session calls `gateSessionForSignIn`
// (the password route calls it as `startLoginChallenge`):
//
//   - two-factor off → the session stands;
//   - two-factor on  → the session is revoked at once (it never reaches the
//     browser) and a short-lived challenge is issued instead. Only
//     `completeLoginChallenge` with a valid code or recovery code mints the
//     real session;
//   - the check itself fails (database) → the session is revoked and the
//     error propagates: sign-in fails closed, never open.
//
// Challenges are single-use `RAAuthToken` rows (kind 'totp_challenge'; only
// the sha256 of the token is stored), valid 5 minutes, at most 5 wrong codes;
// the challenge is bound to the brand that issued it. A per-user limit stops
// guessing across many challenges.

import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import { ACCOUNT_V2_ERROR_CODES, LOGIN_CHALLENGE_MAX_ATTEMPTS, LOGIN_CHALLENGE_TTL_SEC } from './contract.js';
import type { SecondFactor, TwoFactorService } from './twoFactor.js';

export const CHALLENGE_KIND = 'totp_challenge';
/** httpOnly cookie that carries the challenge between the two steps. */
export const CHALLENGE_COOKIE = 'ra_2fa';

export interface ChallengeRow {
  id: string;
  userId: string;
  brand: string;
  attempts: number;
  /** What the first step would have answered (user, seekerProfile), replayed by the second step. */
  login: Record<string, unknown> | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface ChallengeStore {
  create(input: { userId: string; brand: string; tokenHash: string; login: Record<string, unknown> | null; expiresAt: Date }): Promise<void>;
  findByHash(tokenHash: string): Promise<ChallengeRow | null>;
  setAttempts(id: string, attempts: number, login: Record<string, unknown> | null): Promise<void>;
  /** Single use: true only for the caller that consumed it. */
  consume(id: string, now: Date): Promise<boolean>;
}

export interface LoginChallengeDeps {
  twoFactor: Pick<TwoFactorService, 'requiresChallenge' | 'checkSecondFactor'>;
  challenges: ChallengeStore;
  now: () => Date;
  invalidateSession: (token: string) => Promise<void>;
  createSession: (userId: string) => Promise<{ token: string }>;
  /** The account may still sign in (active, profile not deleted). */
  accountAllowed: (userId: string) => Promise<boolean>;
  /** Counts one wrong-or-right attempt for this user; false when over the limit. */
  userAttemptAllowed: (userId: string) => Promise<boolean>;
}

export function hashChallengeToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function invalidChallenge(): HttpError {
  return new HttpError('unauthorized', 'This sign-in step has expired. Sign in again.', { reason: ACCOUNT_V2_ERROR_CODES.challengeInvalid });
}

export type GateOutcome = { kind: 'session' } | { kind: 'challenge'; token: string; expiresInSec: number };

export async function gateSessionForSignIn(
  deps: LoginChallengeDeps,
  input: { userId: string; brand: ProductBrand; sessionToken: string; login?: Record<string, unknown> | null },
): Promise<GateOutcome> {
  let required: boolean;
  try {
    required = await deps.twoFactor.requiresChallenge(input.userId);
  } catch (err) {
    await deps.invalidateSession(input.sessionToken).catch(() => undefined);
    throw err;
  }
  if (!required) return { kind: 'session' };
  await deps.invalidateSession(input.sessionToken);
  const token = randomBytes(32).toString('base64url');
  await deps.challenges.create({
    userId: input.userId,
    brand: input.brand.id,
    tokenHash: hashChallengeToken(token),
    login: input.login ?? null,
    expiresAt: new Date(deps.now().getTime() + LOGIN_CHALLENGE_TTL_SEC * 1000),
  });
  return { kind: 'challenge', token, expiresInSec: LOGIN_CHALLENGE_TTL_SEC };
}

/** The password route's name for the gate (readiness.ts looks for it). */
export const startLoginChallenge = gateSessionForSignIn;

export interface CompletedSignIn {
  userId: string;
  sessionToken: string;
  login: Record<string, unknown> | null;
  method: 'totp' | 'recovery';
  recoveryCodesLeft: number;
}

export async function completeLoginChallenge(
  deps: LoginChallengeDeps,
  input: { token: string; brand: ProductBrand; factor: SecondFactor },
): Promise<CompletedSignIn> {
  const now = deps.now();
  const row = await deps.challenges.findByHash(hashChallengeToken(input.token));
  if (!row || row.consumedAt || row.expiresAt <= now || row.brand !== input.brand.id || row.attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS) {
    throw invalidChallenge();
  }
  if (!(await deps.userAttemptAllowed(row.userId))) {
    throw new HttpError('rate_limited', 'Too many tries. Wait a few minutes, then sign in again.', { retryAfterSec: 900 });
  }
  if (!(await deps.accountAllowed(row.userId))) {
    await deps.challenges.consume(row.id, now);
    throw invalidChallenge();
  }
  const result = await deps.twoFactor.checkSecondFactor(row.userId, input.brand, input.factor);
  if (!result.ok) {
    const attempts = row.attempts + 1;
    await deps.challenges.setAttempts(row.id, attempts, row.login);
    if (attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS) await deps.challenges.consume(row.id, now);
    throw new HttpError('unauthorized', 'That code did not work.', {
      reason: ACCOUNT_V2_ERROR_CODES.totpInvalid,
      attemptsLeft: Math.max(0, LOGIN_CHALLENGE_MAX_ATTEMPTS - attempts),
    });
  }
  if (!(await deps.challenges.consume(row.id, now))) throw invalidChallenge();
  const session = await deps.createSession(row.userId);
  return { userId: row.userId, sessionToken: session.token, login: row.login, method: result.method, recoveryCodesLeft: result.recoveryCodesLeft };
}

// ── Prisma challenge store (RAAuthToken; no schema change) ──────────────

export type ChallengeDb = Pick<ExtendedPrismaClient, 'rAAuthToken'>;

interface ChallengePayload {
  attempts?: number;
  login?: Record<string, unknown> | null;
}

export function createPrismaChallengeStore(getDb: () => Promise<ChallengeDb>): ChallengeStore {
  return {
    async create({ userId, brand, tokenHash, login, expiresAt }) {
      const db = await getDb();
      const payload: ChallengePayload = { attempts: 0, login };
      await db.rAAuthToken.create({ data: { userId, brand, kind: CHALLENGE_KIND, tokenHash, payload: payload as Prisma.InputJsonValue, expiresAt } });
    },
    async findByHash(tokenHash) {
      const db = await getDb();
      const row = await db.rAAuthToken.findUnique({ where: { tokenHash } });
      if (!row || row.kind !== CHALLENGE_KIND || !row.userId) return null;
      const payload = (row.payload ?? {}) as ChallengePayload;
      return {
        id: row.id,
        userId: row.userId,
        brand: row.brand,
        attempts: typeof payload.attempts === 'number' ? payload.attempts : 0,
        login: payload.login && typeof payload.login === 'object' ? payload.login : null,
        expiresAt: row.expiresAt,
        consumedAt: row.consumedAt,
      };
    },
    async setAttempts(id, attempts, login) {
      const db = await getDb();
      const payload: ChallengePayload = { attempts, login };
      await db.rAAuthToken.update({ where: { id }, data: { payload: payload as Prisma.InputJsonValue } });
    },
    async consume(id, now) {
      const db = await getDb();
      const { count } = await db.rAAuthToken.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: now } });
      return count === 1;
    },
  };
}

export function createMemoryChallengeStore(): ChallengeStore & { rows: Map<string, ChallengeRow & { tokenHash: string }> } {
  const rows = new Map<string, ChallengeRow & { tokenHash: string }>();
  let n = 0;
  return {
    rows,
    async create({ userId, brand, tokenHash, login, expiresAt }) {
      n += 1;
      const id = `ch_${n}`;
      rows.set(id, { id, userId, brand, tokenHash, attempts: 0, login, expiresAt, consumedAt: null });
    },
    async findByHash(tokenHash) {
      const row = [...rows.values()].find((r) => r.tokenHash === tokenHash);
      return row ? { ...row } : null;
    },
    async setAttempts(id, attempts) {
      const row = rows.get(id);
      if (row) row.attempts = attempts;
    },
    async consume(id, now) {
      const row = rows.get(id);
      if (!row || row.consumedAt) return false;
      row.consumedAt = now;
      return true;
    },
  };
}
