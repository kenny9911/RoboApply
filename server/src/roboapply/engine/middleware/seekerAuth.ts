// backend/src/seeker/middleware/seekerAuth.ts
//
// Two-step middleware for every /api/v1/seeker/* route:
//   1. Run the shared `requireAuth` so JWT / session / API-key / query-token
//      auth all resolve identically to the recruiter side. Token precedence
//      stays exactly the same — see backend/src/middleware/auth.ts.
//   2. Confirm the authenticated user actually has a SeekerProfile row. If
//      they don't, return 403 instead of leaking a recruiter-only User into
//      the seeker product surface.
//
// Admins may use the candidate (RoboApply) product themselves. They never
// signed up through the seeker funnel, so they have no SeekerProfile — and the
// 403 below would lock them out of the entire app, because GET /auth/me sits
// behind this gate and its 403 cascades to a forced client logout. So when an
// admin reaches a profile-gated route without a profile, we lazily provision
// one (auto-provision mirrors how the CRM console upserts CustomerProfile). The
// admin's User.role stays 'admin'; this only gives them a RoboApply data row.
//
// Side effect: attaches `req.seekerProfile` so downstream handlers don't
// each re-query the same row.

import type { NextFunction, Request, Response } from 'express';
import prisma from '../../../lib/prisma.js';
import { requireAuth } from '../../../middleware/auth.js';

export interface SeekerProfileOnRequest {
  id: string;
  userId: string;
  source: string;
  readinessScore: number;
  locale: string | null;
  market: string | null;
  masterResumeId: string | null;
  deletedAt: Date | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      seekerProfile?: SeekerProfileOnRequest;
    }
  }
}

/**
 * The actual "do I have a SeekerProfile" gate. Runs AFTER `requireAuth` has
 * populated `req.user`.
 */
async function requireSeekerProfile(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, code: 'unauthorized', error: 'Authentication required' });
      return;
    }

    const profileSelect = {
      id: true,
      userId: true,
      source: true,
      readinessScore: true,
      locale: true,
      market: true,
      masterResumeId: true,
      deletedAt: true,
    } as const;

    let profile = await prisma.seekerProfile.findUnique({
      where: { userId: req.user.id },
      select: profileSelect,
    });

    // Admins can use RoboApply themselves but won't have a seeker-funnel
    // profile. Lazily create one so the gate (and /auth/me) lets them in
    // instead of locking them out. `upsert` is race-safe across the parallel
    // /me calls the shell fires on load; SeekerProfile only requires userId
    // (source defaults), so the insert is minimal and safe.
    if (!profile && req.user.role === 'admin') {
      profile = await prisma.seekerProfile.upsert({
        where: { userId: req.user.id },
        create: { userId: req.user.id, source: 'admin' },
        update: {},
        select: profileSelect,
      });
    }

    if (!profile) {
      res.status(403).json({
        success: false,
        code: 'seeker_profile_required',
        error: 'This account is not a seeker account',
      });
      return;
    }

    if (profile.deletedAt) {
      res.status(403).json({
        success: false,
        code: 'account_deleted',
        error: 'This account has been deleted',
      });
      return;
    }

    req.seekerProfile = profile;
    next();
  } catch (err) {
    // Don't leak DB errors to the client.
    console.error('seekerAuth middleware error:', err);
    res.status(500).json({ success: false, code: 'seeker_auth_error', error: 'Auth check failed' });
  }
}

/**
 * Composed middleware: `requireAuth` then `requireSeekerProfile`. Use this
 * on every protected seeker route so the gate semantics live in exactly
 * one place.
 */
export const seekerAuth = [requireAuth, requireSeekerProfile] as const;

export { requireSeekerProfile };
export default seekerAuth;
