// server/src/features/auth-cn/db.ts — the narrow typed Prisma surface this area uses.
//
// Services take an `AuthCnDb` so tests pass server/src/test/fakePrisma.ts
// instead of a database. Only the delegates listed here are touched.

import prisma from '../../lib/prisma.js';

type Client = typeof prisma;

export type AuthCnDelegates = Pick<
  Client,
  | 'user'
  | 'seekerProfile'
  | 'seekerConsentRecord'
  | 'rAPhoneOtp'
  | 'rAAuthIdentity'
  | 'rABrandInvite'
  | 'rAAuthToken'
  | 'rARateCounter'
  | 'session'
>;

export type AuthCnTx = AuthCnDelegates;

export type AuthCnDb = AuthCnDelegates & {
  $transaction<T>(fn: (tx: AuthCnTx) => Promise<T>): Promise<T>;
};

export function defaultAuthCnDb(): AuthCnDb {
  return prisma;
}

/** Prisma unique-constraint violation (P2002), also raised by the test fake. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
