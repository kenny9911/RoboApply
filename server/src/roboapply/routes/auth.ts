// backend/src/roboapply/routes/auth.ts
//
// Mounted at /api/v1/roboapply/auth/* in backend/src/index.ts.
//
//   POST /signup    — proxies seeker signup; on success also creates a
//                     shell RoboApplyMission row for the new user so they
//                     can hit the onboarding flow without a separate
//                     account-create step.
//   POST /login     — proxies seeker login.
//   GET  /me        — proxies seeker /me + injects mission snapshot.
//   POST /logout    — proxies seeker logout.
//
// RoboApply users ARE seeker users (one User row, one SeekerProfile row,
// plus a RoboApplyMission row). The proxy keeps the auth surface unified
// while letting the RoboApply frontend hit a single /api/v1/roboapply/auth/*
// namespace and not need to know about /seeker/* legacy routes.

import { Router, type Request, type Response } from 'express';
import { rateLimit, requireAuth } from '../../middleware/auth.js';
import {
  buildCookieOptions,
  buildClearCookieOptions,
  SESSION_COOKIE_NAME,
} from '../../lib/cookieOptions.js';
import { logger } from '../../services/LoggerService.js';
import seekerAuthService, {
  SeekerAccountDeletedError,
  SeekerEmailTakenError,
  SeekerInvalidCredentialsError,
  SeekerNotSeekerAccountError,
} from '../engine/services/SeekerAuthService.js';
import seekerProfileService from '../engine/services/SeekerProfileService.js';
import { invalidateSeekerSession } from '../engine/lib/seekerSession.js';
import { requireSeekerProfile } from '../engine/middleware/seekerAuth.js';
import { getMissionForUser } from '../services/RoboApplyMissionService.js';
import { isJobApplyingEnabled } from '../lib/featureFlags.js';
import prisma from '../../lib/prisma.js';

const router = Router();

const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const resolvedSameSite = (() => {
  const configured = (process.env.COOKIE_SAME_SITE || 'lax').toLowerCase();
  if (configured === 'strict') return 'strict' as const;
  if (configured === 'none') return 'none' as const;
  return 'lax' as const;
})();

function sessionCookieOptions() {
  return buildCookieOptions({
    sameSite: resolvedSameSite,
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
  });
}

function clearSessionCookieOptions() {
  return buildClearCookieOptions();
}

const authRateLimit = rateLimit(5, 60_000);

function isPlausibleEmail(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 320) return false;
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return false;
  const dot = trimmed.lastIndexOf('.');
  if (dot < at) return false;
  return true;
}

/**
 * POST /api/v1/roboapply/auth/signup
 *
 * Body: { email, password, name?, locale? }
 *
 * Creates the User + SeekerProfile via seekerAuthService.signup, then
 * creates an EMPTY RoboApplyMission shell so the new user can hit the
 * onboarding flow at /onboarding to flesh it out with intent + resume.
 */
router.post('/signup', authRateLimit, async (req: Request, res: Response) => {
  try {
    const { email, password, name, locale } = req.body ?? {};
    if (!isPlausibleEmail(email)) {
      return res.status(400).json({
        success: false,
        code: 'invalid_email',
        error: 'Please provide a valid email address',
      });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({
        success: false,
        code: 'invalid_password',
        error: 'Password must be at least 8 characters',
      });
    }

    const acceptLanguage = typeof req.headers['accept-language'] === 'string'
      ? (req.headers['accept-language'] as string)
      : null;

    const result = await seekerAuthService.signup({
      email,
      password,
      name: typeof name === 'string' ? name.trim() : undefined,
      locale: typeof locale === 'string' ? locale : null,
      acceptLanguage,
      source: 'roboapply_signup',
    });

    res.cookie(SESSION_COOKIE_NAME, result.sessionToken, sessionCookieOptions());

    // RoboApplyMission shell — empty intent. The /onboarding flow will
    // PATCH intent + tier + resume. We don't pre-fire the IntentParser here.
    try {
      await prisma.roboApplyMission.create({
        data: {
          userId: result.user.id,
          intentText: '',
          tier: 'free',
          reviewMode: 'review_first',
          dailyCap: 3,
          locale: (result.user.locale ?? 'en'),
          timezone: typeof req.body?.timezone === 'string' ? req.body.timezone : 'UTC',
          enabled: false, // disabled until onboarding completes (intent + resume set)
        },
      });
    } catch (err) {
      // Non-fatal — user can re-create via POST /missions in onboarding.
      logger.warn(
        'ROBOAPPLY_AUTH',
        'shell mission create failed on signup; will be retried at onboarding',
        { userId: result.user.id, error: err instanceof Error ? err.message : String(err) },
        req.requestId,
      );
    }

    return res.status(201).json({
      success: true,
      data: {
        user: result.user,
        seekerProfile: result.seekerProfile,
        token: result.token,
      },
    });
  } catch (err) {
    if (err instanceof SeekerEmailTakenError) {
      return res.status(409).json({
        success: false,
        code: 'email_taken',
        error: 'An account with this email already exists',
      });
    }
    const message = err instanceof Error ? err.message : 'Signup failed';
    logger.warn('ROBOAPPLY_AUTH', 'signup failed', { message }, req.requestId);
    return res.status(400).json({ success: false, code: 'signup_failed', error: message });
  }
});

/**
 * POST /api/v1/roboapply/auth/login
 *
 * Body: { email, password }
 */
router.post('/login', authRateLimit, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};
    if (!isPlausibleEmail(email) || typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({
        success: false,
        code: 'invalid_credentials',
        error: 'Email and password are required',
      });
    }

    const result = await seekerAuthService.login({ email, password });
    res.cookie(SESSION_COOKIE_NAME, result.sessionToken, sessionCookieOptions());

    return res.json({
      success: true,
      data: {
        user: result.user,
        seekerProfile: result.seekerProfile,
        token: result.token,
      },
    });
  } catch (err) {
    if (err instanceof SeekerNotSeekerAccountError) {
      return res.status(403).json({
        success: false,
        code: 'not_a_seeker_account',
        error: 'This account is not a RoboApply account',
      });
    }
    if (err instanceof SeekerAccountDeletedError) {
      return res.status(403).json({
        success: false,
        code: 'account_deleted',
        error: 'This account has been deleted',
      });
    }
    if (err instanceof SeekerInvalidCredentialsError) {
      return res.status(401).json({
        success: false,
        code: 'invalid_credentials',
        error: 'Invalid email or password',
      });
    }
    const message = err instanceof Error ? err.message : 'Login failed';
    logger.warn('ROBOAPPLY_AUTH', 'login failed', { message }, req.requestId);
    return res.status(401).json({ success: false, code: 'login_failed', error: message });
  }
});

/**
 * GET /api/v1/roboapply/auth/me
 *
 * Returns user + profile + mission. Mission may be null if shell-creation
 * failed at signup; clients should redirect to /onboarding in that case.
 */
router.get(
  '/me',
  requireAuth,
  requireSeekerProfile,
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const p = prisma as any;
      const [profile, mission, variantCount, goal] = await Promise.all([
        seekerProfileService.getByUserId(userId),
        getMissionForUser(userId),
        p.rAResumeVariant.count({ where: { userId, deletedAt: null } }),
        p.rACareerGoal.findUnique({
          where: { userId },
          select: { preferencesBlob: true },
        }),
      ]);

      // Derive an onboardingState so the frontend's post-login redirect
      // (skip onboarding when the user already onboarded) works. V3+ truth
      // sources, in addition to the legacy V1 mission heuristics:
      //   - resume:      any live RAResumeVariant counts (V3 onboarding never
      //                  set mission.resumeId — the old derivation bounced
      //                  every V3 user back to /onboarding on each login)
      //   - preferences: the chat-onboarding stamp preferencesBlob.onboarding
      //                  .completedAt, or the legacy intentText heuristic
      const ob = (goal?.preferencesBlob as any)?.onboarding ?? null;
      const hasResume = !!mission?.resumeId || variantCount > 0;
      const hasIntent =
        (mission?.intentText?.trim()?.length ?? 0) >= 5 || Boolean(ob?.completedAt);
      const completedSteps: string[] = [];
      if (hasResume) completedSteps.push('resume');
      if (hasIntent) completedSteps.push('preferences');
      const onboardingState = {
        completed: Boolean(ob?.completedAt) || (hasResume && hasIntent),
        completedSteps,
      };

      return res.json({
        success: true,
        data: {
          user: req.user,
          profile,
          mission,
          onboardingState,
          // Deploy-time master switch for the auto-apply product surface. The
          // frontend reads this to hide Today/Queue/Pipeline/Activity and land
          // users on Resume Builder + Mock Interview when off. Single source of
          // truth — the Next.js app cannot read the backend's .env directly.
          jobApplyingEnabled: isJobApplyingEnabled(),
        },
      });
    } catch (err) {
      logger.error(
        'ROBOAPPLY_AUTH',
        'GET /me failed',
        { error: err instanceof Error ? err.message : String(err) },
        req.requestId,
      );
      return res.status(500).json({ success: false, code: 'me_failed', error: 'Failed to load profile' });
    }
  },
);

/** POST /api/v1/roboapply/auth/logout */
router.post(
  '/logout',
  requireAuth,
  requireSeekerProfile,
  async (req: Request, res: Response) => {
    try {
      if (req.sessionToken) {
        await invalidateSeekerSession(req.sessionToken);
      }
      res.clearCookie(SESSION_COOKIE_NAME, clearSessionCookieOptions());
      return res.status(204).send();
    } catch (err) {
      logger.error(
        'ROBOAPPLY_AUTH',
        'logout failed',
        { error: err instanceof Error ? err.message : String(err) },
        req.requestId,
      );
      return res.status(500).json({ success: false, code: 'logout_failed', error: 'Logout failed' });
    }
  },
);

export default router;
