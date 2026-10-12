// server/src/features/auth/tokens.ts
//
// Single-use tokens on `RAAuthToken` (ARCHITECTURE.md §2.3): password reset
// (30 min), email verification, OAuth state (PKCE verifier + nonce + next),
// a LINE sign-up waiting for a verified email, and the known-device marks
// used for the new-device email. Only the sha256 of a raw token is stored.
//
// `consumeToken` is single-use under concurrency: it claims the row with an
// `updateMany … where consumedAt IS NULL` and treats a zero count as already
// used, so two parallel requests with one reset link cannot both succeed.
//
// Retention (PRODUCT F-TRUST-06 "OTP/auth tokens 24 h"): every link token
// lives at most 24 h, and `purgeAuthTokens` (run by the nightly account-purge
// cron) deletes every used or expired row, including the ones with no user
// (OAuth state with its PKCE verifier, pending OAuth sign-ups with an email
// and name). Known-device marks are not sign-in tokens: they hold only a hash
// of user × browser × OS plus the browser and OS names, live 90 days after
// the last sign-in from that device, and are deleted by the same sweep once
// expired (WP-13 adds the schedule line).

import crypto from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import type prismaClient from '../../lib/prisma.js';
import type { BrandId } from '../../platform/brand/registry.js';
import { authErrors } from './errors.js';

export type AuthTokenDb = Pick<typeof prismaClient, 'rAAuthToken'>;

export const AUTH_TOKEN_KINDS = {
  passwordReset: 'password_reset',
  emailVerify: 'email_verify',
  oauthState: 'oauth_state',
  /** A LINE identity waiting for a verified email before the account exists. */
  oauthPending: 'oauth_pending',
  /** Long-lived mark of a browser/OS pair a user signed in from (new-device email). */
  knownDevice: 'known_device',
} as const;
export type AuthTokenKind = (typeof AUTH_TOKEN_KINDS)[keyof typeof AUTH_TOKEN_KINDS];

const MINUTE = 60_000;
export const TOKEN_TTL_MS: Record<AuthTokenKind, number> = {
  password_reset: 30 * MINUTE,
  email_verify: 24 * 60 * MINUTE,
  oauth_state: 15 * MINUTE,
  oauth_pending: 24 * 60 * MINUTE,
  known_device: 90 * 24 * 60 * MINUTE,
};

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function newRawToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export interface IssueTokenInput {
  kind: AuthTokenKind;
  brand: BrandId;
  userId?: string | null;
  payload?: Prisma.InputJsonValue;
  /** Override the kind's TTL. */
  ttlMs?: number;
  /** Use a caller-chosen raw value (known-device marks). */
  raw?: string;
  now?: Date;
}

export async function issueToken(db: AuthTokenDb, input: IssueTokenInput): Promise<{ raw: string; expiresAt: Date }> {
  const raw = input.raw ?? newRawToken();
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? TOKEN_TTL_MS[input.kind]));
  await db.rAAuthToken.create({
    data: {
      kind: input.kind,
      brand: input.brand,
      userId: input.userId ?? null,
      tokenHash: hashToken(raw),
      payload: input.payload,
      expiresAt,
    },
  });
  return { raw, expiresAt };
}

export interface ConsumedToken {
  id: string;
  userId: string | null;
  brand: string;
  payload: unknown;
}

/**
 * Validate and burn a token. Throws `token_invalid` (unknown, wrong kind,
 * wrong brand or already used) or `token_expired`.
 */
export async function consumeToken(
  db: AuthTokenDb,
  raw: string,
  kind: AuthTokenKind,
  brand: BrandId,
  now: Date = new Date(),
): Promise<ConsumedToken> {
  const row = await db.rAAuthToken.findUnique({ where: { tokenHash: hashToken(raw) } });
  if (!row || row.kind !== kind || row.brand !== brand || row.consumedAt) throw authErrors.tokenInvalid();
  if (row.expiresAt.getTime() <= now.getTime()) throw authErrors.tokenExpired();
  const claimed = await db.rAAuthToken.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (claimed.count !== 1) throw authErrors.tokenInvalid();
  return { id: row.id, userId: row.userId, brand: row.brand, payload: row.payload };
}

/** Burn every live token of a kind for a user (a new reset link voids the old ones). */
export async function revokeTokens(db: AuthTokenDb, userId: string, kind: AuthTokenKind, now: Date = new Date()): Promise<number> {
  const res = await db.rAAuthToken.updateMany({ where: { userId, kind, consumedAt: null }, data: { consumedAt: now } });
  return res.count;
}

/**
 * Delete every used or expired token row (all kinds, all brands, with or
 * without a user). Idempotent; returns the number of rows removed.
 */
export async function purgeAuthTokens(db: AuthTokenDb, now: Date = new Date()): Promise<number> {
  const res = await db.rAAuthToken.deleteMany({
    where: { OR: [{ consumedAt: { not: null } }, { expiresAt: { lt: now } }] },
  });
  return res.count;
}
