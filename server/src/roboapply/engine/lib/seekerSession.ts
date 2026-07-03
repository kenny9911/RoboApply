// backend/src/seeker/lib/seekerSession.ts
//
// JWT + Session primitives for the seeker auth surface. Mirrors the shared
// auth approach (7-day JWT, 30-day DB-backed session) but lives under
// backend/src/seeker/ so the boundary check stays clean — seeker code can
// import from seeker/lib/ but NOT from backend/src/services/.
//
// The actual session row is written to the SAME prisma.session table used
// by the recruiter side. That's intentional: the JWT_SECRET and Session
// model are the auth infrastructure of the whole app, not recruiter-specific
// business logic. The middleware in backend/src/middleware/auth.ts is the
// shared reader, so a seeker-created session token authenticates exactly
// the same way a recruiter-created one does.

import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import prisma from '../../../lib/prisma.js';
import { parseDurationSeconds } from '../../../lib/parseDuration.js';

const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-change-in-production';
const JWT_EXPIRES_IN = parseDurationSeconds(process.env.JWT_EXPIRES_IN, 604800); // 7 days
const SESSION_EXPIRES_IN = parseDurationSeconds(process.env.SESSION_EXPIRES_IN, 2592000); // 30 days

export interface SeekerTokenPayload {
  userId: string;
  email: string;
  iat?: number;
  exp?: number;
}

/** Generate a JWT — same shape as the recruiter side so the shared middleware reads it. */
export function generateJwt(user: { id: string; email: string }): string {
  const payload: SeekerTokenPayload = { userId: user.id, email: user.email };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/** Generate a fresh DB-backed session token and persist it. */
export async function createSeekerSession(userId: string): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_EXPIRES_IN * 1000);
  await prisma.session.create({ data: { userId, token, expiresAt } });
  return { token, expiresAt };
}

/** Invalidate one session by token. Idempotent — safe to call on an unknown token. */
export async function invalidateSeekerSession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { token } });
}
