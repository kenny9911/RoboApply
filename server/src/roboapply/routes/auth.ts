// backend/src/roboapply/routes/auth.ts
//
// Mounted at /api/v1/roboapply/auth/* in backend/src/index.ts.
//
//   POST /signup    — seeker signup (WP-10): agreements (`age_16_plus`
//                     required; PDPA notice for zh-TW/TW), unchecked
//                     marketing opt-in, entry attribution, brand + market
//                     stamping, onboardingStep 'account', verification email.
//                     GoApply hosts apply GoApply's rules instead
//                     (features/auth/goapplySignup.ts): 403 `signup_closed`
//                     in production without the approved documents; 422
//                     `consent_required` without the agreement, the age
//                     confirmation and (while data is processed outside the
//                     mainland) the cross-border consent; in invite mode 422
//                     `invite_invalid` without a redeemable `inviteCode`,
//                     which is spent in the account-creation transaction.
//                     An email that belongs to the OTHER brand gets a
//                     "check your email" answer (200, no session) and a
//                     notice in that inbox (H34; never a 409). Open: that
//                     answer still differs from a new signup (201 + session);
//                     making them identical needs verify-before-create
//                     signup (owner decision). No V1 RoboApplyMission any more.
//   POST /login     — seeker login; 409 account_other_brand only after the
//                     password matched; new-device email. Two-step sign-in
//                     (WP-79 hook): when the account has it on, the session
//                     just minted is revoked, no cookie or token is sent, and
//                     the answer is 401 `two_factor_required` with a
//                     short-lived httpOnly challenge cookie (`ra_2fa`).
//   POST /login/2fa — the second step: a current authenticator code or a
//                     recovery code → the normal login response.
//   GET  /me        — user + profile + the WP-10 additions (brand,
//                     onboarding, entitlements, flags, unreadCount,
//                     emailVerified). `mission` is no longer returned and the
//                     V1 mission is no longer read.
//   POST /logout    — logout.
// Rate limits are DB-backed (platform/ratelimit): signup 5/min + 20/day per
// IP, login 10/min per IP.
//
// RoboApply users ARE seeker users (one User row, one SeekerProfile row).
// The proxy keeps the auth surface unified
// while letting the RoboApply frontend hit a single /api/v1/roboapply/auth/*
// namespace and not need to know about /seeker/* legacy routes.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../platform/ratelimit/index.js';
import { authService } from '../../features/auth/service.js';
import { isAuthError } from '../../features/auth/errors.js';
import {
  buildCookieOptions,
  buildClearCookieOptions,
  SESSION_COOKIE_NAME,
} from '../../lib/cookieOptions.js';
import { logger } from '../../services/LoggerService.js';
import seekerAuthService, {
  SeekerAccountDeletedError,
  SeekerAccountDisabledError,
  SeekerAccountOtherBrandError,
  SeekerEmailTakenError,
  SeekerInvalidCredentialsError,
  SeekerNotSeekerAccountError,
} from '../engine/services/SeekerAuthService.js';
import seekerProfileService from '../engine/services/SeekerProfileService.js';
import { invalidateSeekerSession } from '../engine/lib/seekerSession.js';
import { requireSeekerProfile } from '../engine/middleware/seekerAuth.js';
import prisma from '../../lib/prisma.js';
import { recordUserActivity } from '../../lib/userActivity.js';
import { getCurrentBrandId } from '../../lib/requestContext.js';
import { getBrand, type BrandId, type ProductBrand } from '../../platform/brand/registry.js';
import {
  ACCOUNT_V2_ERROR_CODES,
  CHALLENGE_COOKIE,
  LoginTwoFactorBodySchema,
  clearChallengeCookie,
  completeLoginChallenge,
  loginChallengeDeps,
  sendTwoFactorRequired,
  sendTwoFactorUnavailable,
  startLoginChallenge,
  type LoginChallengeDeps,
} from '../../features/account-v2/index.js';
import { AuthCnError } from '../../features/auth-cn/index.js';
import { signupRequestContext } from '../../features/auth/requestContext.js';
import { HttpError } from '../../platform/http.js';
import { generateJwt } from '../engine/lib/seekerSession.js';

const router = Router();

/** The request's product brand (brand middleware), stamped on signup and checked on login. */
function requestBrandId(req: Request): BrandId | undefined {
  return (req as Request & { brand?: { id: BrandId } }).brand?.id ?? getCurrentBrandId();
}

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

/**
 * The account fields a response of this router may carry.
 *
 * `req.user` and the sign-in results are the whole `User` row minus the
 * password hash (AuthService.buildPublicUser). That row also holds the reset
 * and verification token hashes and their expiries, the provider subject id,
 * the payment-customer and subscription ids, staff assignments and internal
 * quota counters. None of that is the browser's business, and a token column
 * must never be serialized, even hashed and even when null. So the response is
 * built from this list, never from the row: a column added to `User` later is
 * not sent until it is named here.
 */
export const PUBLIC_USER_FIELDS = [
  'id',
  'email',
  'name',
  'avatar',
  'role',
  'roles',
  'brand',
  'market',
  // The sign-in result carries the profile's language (not a User column).
  'locale',
  'provider',
  'emailVerified',
  'emailVerifiedAt',
  'emailIsPlaceholder',
  'phoneVerifiedAt',
  'createdAt',
  'subscriptionTier',
  'subscriptionStatus',
  'currentPeriodEnd',
] as const;

/** `user` reduced to PUBLIC_USER_FIELDS (absent fields stay absent); null for no user. */
export function publicUserOf(user: unknown): Record<string, unknown> | null {
  if (!user || typeof user !== 'object') return null;
  const row = user as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_USER_FIELDS) if (row[key] !== undefined) out[key] = row[key];
  return out;
}

const signupRateLimit = rateLimit({ name: 'signupPerIp' });
const loginRateLimit = rateLimit({ name: 'loginPerIp' });

// ── Two-step sign-in hook (WP-79) ───────────────────────────────────────
// The second step is checked in features/account-v2 (loginChallenge.ts);
// this router only carries the challenge between the two requests.

let challengeDepsFactory: () => LoginChallengeDeps = loginChallengeDeps;

/** Tests only: replace the sign-in gate's collaborators (null restores the defaults). */
export function setLoginChallengeDepsForTests(factory: (() => LoginChallengeDeps) | null): void {
  challengeDepsFactory = factory ?? loginChallengeDeps;
}

function requestBrand(req: Request): ProductBrand {
  return getBrand(requestBrandId(req) ?? 'roboapply');
}

/** Edge country (Vercel); only decides whether the Taiwan PDPA notice applies. */
function requestCountry(req: Request): string | null {
  const raw = req.get('x-vercel-ip-country');
  return raw && /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : null;
}

/** Best-effort follow-ups after a sign-in/up never fail the request or add warn logs. */
async function quietly(task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch {
    // Each task logs its own failure (features/auth/service.ts `note`).
  }
}

function asConsents(value: unknown): Array<{ type: string; granted: boolean; proseVersion: string; proseHash?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .slice(0, 20)
    .map((c) => ({
      type: String(c.type ?? ''),
      granted: c.granted === true,
      proseVersion: typeof c.proseVersion === 'string' ? c.proseVersion.slice(0, 40) : 'unknown',
      // GoApply: the sha256 of the consent text the form showed (64 hex characters); anything else is ignored.
      ...(typeof c.proseHash === 'string' && /^[0-9a-f]{64}$/.test(c.proseHash) ? { proseHash: c.proseHash } : {}),
    }));
}

function asAttribution(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined);
  return {
    from: s('from'),
    jobId: s('jobId'),
    action: v.action === 'apply' ? ('apply' as const) : undefined,
    ref: s('ref'),
    utmSource: s('utmSource'),
    utmMedium: s('utmMedium'),
    utmCampaign: s('utmCampaign'),
    alert: s('alert'),
    landingPath: s('landingPath'),
  };
}

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
 * Body: { email, password, name?, locale?, consents, marketingOptIn?,
 * attribution?, timezone?, inviteCode? (GoApply) }
 *
 * Creates the User + SeekerProfile via seekerAuthService.signup at the
 * onboarding stage `account`. GoApply hosts go through GoApply's signup
 * rules (its consents; an invite only with CN_SIGNUP_MODE=invite; open by
 * default) inside the same service call.
 */
router.post('/signup', signupRateLimit, async (req: Request, res: Response) => {
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
    const brand = requestBrand(req);

    const acceptLanguage = typeof req.headers['accept-language'] === 'string'
      ? (req.headers['accept-language'] as string)
      : null;

    // Signup locale precedence — body → X-Robo-Locale header → robo_locale
    // cookie → Accept-Language (resolved downstream by normalizeLocale).
    //
    // Accept-Language alone is WRONG here: it reports the browser's language,
    // not the language the user chose on the marketing site. Someone who
    // switched the site to Chinese and signed up on an English-locale browser
    // used to get `locale: 'en'` persisted on SeekerProfile + RoboApplyMission,
    // which is what every requestless background job reads — so every digest,
    // insight and match rationale spoke English to them forever.
    //
    // This is the same chain as `getRequestLocale` in v2/lib/raLocale.ts,
    // replicated (not imported) because that module is V2-scoped and this route
    // is not; it is four lines, and raLocale.ts documents the same
    // fork-the-tiny-helper rule for its own copy. Raw tags are passed through —
    // seekerLocale.normalizeLocale owns normalization and the closed list.
    const cookieLocale = (req as { cookies?: Record<string, string> }).cookies?.robo_locale;
    const headerLocale = req.get('x-robo-locale');
    const resolvedLocale =
      (typeof locale === 'string' && locale.trim() ? locale : null) ??
      (typeof headerLocale === 'string' && headerLocale.trim() ? headerLocale : null) ??
      (typeof cookieLocale === 'string' && cookieLocale.trim() ? cookieLocale : null);

    const result = await seekerAuthService.signup({
      email,
      password,
      name: typeof name === 'string' ? name.trim() : undefined,
      locale: resolvedLocale,
      acceptLanguage,
      source: 'roboapply_signup',
      brand: requestBrandId(req),
      consents: asConsents(req.body?.consents),
      marketingOptIn: req.body?.marketingOptIn === true,
      attribution: asAttribution(req.body?.attribution),
      timezone: typeof req.body?.timezone === 'string' ? req.body.timezone : null,
      country: requestCountry(req),
      inviteCode: typeof req.body?.inviteCode === 'string' ? req.body.inviteCode.slice(0, 64) : null,
    });

    res.cookie(SESSION_COOKIE_NAME, result.sessionToken, sessionCookieOptions());

    // No V1 RoboApplyMission shell any more (WP-10): onboarding is the
    // server stage machine (SeekerProfile.onboardingStep = 'account').
    // Attribution (WP-23 recipe) and the invite attach (WP-60): the request's
    // analytics identity decides whether marketing fields are kept; its IP,
    // user agent and `ra_anon` id are the invite risk signals.
    const attribution = asAttribution(req.body?.attribution);
    await quietly(() => authService.afterAccountCreated(result.user.id, { attribution }, signupRequestContext(req, brand)));
    await quietly(() => authService.rememberRegion(result.user.id, requestCountry(req)));
    // Verification is not blocking (PRODUCT O0); it unlocks the free practice credit.
    await quietly(() => authService.sendVerificationEmail({ userId: result.user.id, brand }));

    await recordUserActivity(req, {
      userId: result.user.id,
      eventType: 'signup',
      path: '/api/v1/roboapply/auth/signup',
      sessionToken: result.sessionToken,
      market: result.user.market,
      statusCode: 201,
    });

    return res.status(201).json({
      success: true,
      data: {
        user: publicUserOf(result.user),
        seekerProfile: result.seekerProfile,
        token: result.token,
        // The first onboarding screen (situation on RoboApply, consent on GoApply).
        next: authService.firstOnboardingRoute(brand),
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'signup_other_brand') {
      // H34: the same answer a fresh signup that must confirm its email would
      // get, plus a notice to that inbox naming where the account lives.
      const accountBrand = (err as { accountBrand?: BrandId }).accountBrand ?? 'roboapply';
      await quietly(() =>
        authService.sendOtherBrandNotice({
          email: String(req.body?.email ?? '').trim().toLowerCase(),
          visitingBrand: requestBrand(req),
          accountBrand,
          locale: typeof req.body?.locale === 'string' ? req.body.locale : null,
        }),
      );
      return res.status(200).json({ success: true, data: { status: 'check_email' } });
    }
    if (isAuthError(err) || err instanceof AuthCnError) {
      // AuthCnError: GoApply's signup rules (signup_closed 403,
      // consent_required 422, invite_invalid 422), the same envelope the
      // phone and WeChat routes write.
      return res.status(err.status).json({
        success: false,
        code: err.code,
        error: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      });
    }
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
router.post('/login', loginRateLimit, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};
    if (!isPlausibleEmail(email) || typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({
        success: false,
        code: 'invalid_credentials',
        error: 'Email and password are required',
      });
    }

    const result = await seekerAuthService.login({ email, password, brand: requestBrandId(req) });

    // WP-79: the password matched; a second factor may still be required.
    // Nothing that authenticates (cookie, session token, JWT) leaves this
    // handler unless the gate says the session stands.
    let gate: Awaited<ReturnType<typeof startLoginChallenge>>;
    try {
      gate = await startLoginChallenge(challengeDepsFactory(), {
        userId: result.user.id,
        brand: requestBrand(req),
        sessionToken: result.sessionToken,
        login: { user: result.user, seekerProfile: result.seekerProfile },
      });
    } catch (gateErr) {
      logger.error('ROBOAPPLY_AUTH', 'two-step sign-in check failed; refusing sign-in', {
        error: gateErr instanceof Error ? gateErr.message : String(gateErr),
      }, req.requestId);
      return sendTwoFactorUnavailable(res);
    }
    if (gate.kind === 'challenge') return sendTwoFactorRequired(req, res, gate);

    res.cookie(SESSION_COOKIE_NAME, result.sessionToken, sessionCookieOptions());

    await recordUserActivity(req, {
      userId: result.user.id,
      eventType: 'login',
      path: '/api/v1/roboapply/auth/login',
      sessionToken: result.sessionToken,
      market: result.user.market,
      statusCode: 200,
    });

    // F-TRUST-01: email the account when this browser × OS is new for it.
    await quietly(() =>
      authService.notifyIfNewDevice({
        userId: result.user.id,
        email: result.user.email,
        brand: requestBrand(req),
        userAgent: req.get('user-agent') ?? null,
        locale: result.user.locale ?? null,
      }),
    );
    await quietly(() => authService.rememberRegion(result.user.id, requestCountry(req)));

    return res.json({
      success: true,
      data: {
        user: publicUserOf(result.user),
        seekerProfile: result.seekerProfile,
        token: result.token,
      },
    });
  } catch (err) {
    if (err instanceof SeekerAccountOtherBrandError) {
      return res.status(409).json({
        success: false,
        code: 'account_other_brand',
        error: 'This account belongs to another site. Sign in there instead.',
        details: { otherBrandUrl: `${getBrand(err.accountBrand).canonicalOrigin}/login` },
      });
    }
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
    if (err instanceof SeekerAccountDisabledError) {
      return res.status(403).json({
        success: false,
        code: 'account_disabled',
        error: 'This account has been suspended. Contact support if you believe this is an error.',
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
 * POST /api/v1/roboapply/auth/login/2fa
 *
 * Body: { code } or { recoveryCode } (+ challengeToken for cookie-less
 * clients). The challenge cookie from POST /login identifies the sign-in.
 */
router.post('/login/2fa', loginRateLimit, async (req: Request, res: Response) => {
  const parsed = LoginTwoFactorBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ success: false, code: 'invalid_request', error: 'Enter the 6-digit code or a recovery code.' });
  }
  const cookieToken = (req.cookies?.[CHALLENGE_COOKIE] as string | undefined) || undefined;
  const token = cookieToken ?? parsed.data.challengeToken;
  if (!token) {
    return res.status(401).json({
      success: false,
      code: ACCOUNT_V2_ERROR_CODES.challengeInvalid,
      error: 'This sign-in step has expired. Sign in again.',
    });
  }
  const factor = parsed.data.code ? { code: parsed.data.code } : { recoveryCode: parsed.data.recoveryCode! };
  try {
    const done = await completeLoginChallenge(challengeDepsFactory(), { token, brand: requestBrand(req), factor });
    clearChallengeCookie(req, res);
    res.cookie(SESSION_COOKIE_NAME, done.sessionToken, sessionCookieOptions());

    const login = (done.login ?? {}) as { user?: { id: string; email: string; market?: string | null; locale?: string | null }; seekerProfile?: unknown };
    const user = login.user ?? null;
    await recordUserActivity(req, {
      userId: done.userId,
      eventType: 'login',
      path: '/api/v1/roboapply/auth/login/2fa',
      sessionToken: done.sessionToken,
      market: user?.market ?? undefined,
      statusCode: 200,
    });
    if (user?.email) {
      await quietly(() =>
        authService.notifyIfNewDevice({
          userId: done.userId,
          email: user.email,
          brand: requestBrand(req),
          userAgent: req.get('user-agent') ?? null,
          locale: user.locale ?? null,
        }),
      );
    }
    return res.json({
      success: true,
      data: {
        user: publicUserOf(user),
        seekerProfile: login.seekerProfile ?? null,
        token: user?.email ? generateJwt({ id: done.userId, email: user.email }) : undefined,
        twoFactor: { method: done.method, recoveryCodesLeft: done.recoveryCodesLeft },
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      const details = (err.details ?? {}) as { reason?: string };
      const code = details.reason ?? err.code;
      if (code === ACCOUNT_V2_ERROR_CODES.challengeInvalid) clearChallengeCookie(req, res);
      if (err.headers) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
      return res.status(err.status).json({ success: false, code, error: err.message, details: err.details });
    }
    logger.error('ROBOAPPLY_AUTH', 'two-step sign-in failed', { error: err instanceof Error ? err.message : String(err) }, req.requestId);
    return sendTwoFactorUnavailable(res);
  }
});

/**
 * GET /api/v1/roboapply/auth/me
 *
 * Returns user + profile + the legacy `onboardingState` (kept for clients
 * that still read it) + the WP-10 additions: brand, onboarding {step, path,
 * completed, nextRoute}, entitlements, flags, unreadCount, emailVerified.
 * The V1 `mission` snapshot is neither returned nor read any more.
 */
router.get(
  '/me',
  requireAuth,
  requireSeekerProfile,
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const p = prisma as any;
      const [profile, variantCount, goal] = await Promise.all([
        seekerProfileService.getByUserId(userId),
        p.rAResumeVariant.count({ where: { userId, deletedAt: null } }),
        p.rACareerGoal.findUnique({
          where: { userId },
          select: { preferencesBlob: true },
        }),
      ]);

      // The legacy `onboardingState` (the server stage machine in
      // `onboarding` below is the source of truth for routing). Derived from:
      //   - resume:      any live RAResumeVariant;
      //   - preferences: the onboarding stamp preferencesBlob.onboarding
      //                  .completedAt.
      // `skippedAt` and `autoOpens` are read back from the same blob as
      // stored. Nothing writes them any more (the old setup panel and its
      // /v2/onboarding/seen route are gone), so they stay at their last value.
      const ob = (goal?.preferencesBlob as any)?.onboarding ?? null;
      const hasResume = variantCount > 0;
      const hasIntent = Boolean(ob?.completedAt);
      const completedSteps: string[] = [];
      if (hasResume) completedSteps.push('resume');
      if (hasIntent) completedSteps.push('preferences');
      const onboardingState = {
        completed: Boolean(ob?.completedAt) || (hasResume && hasIntent),
        completedSteps,
        skippedAt: typeof ob?.skippedAt === 'string' ? ob.skippedAt : null,
        autoOpens: typeof ob?.autoOpens === 'number' ? ob.autoOpens : 0,
      };

      // Additive fields; a failure here never breaks /me (each part degrades
      // to null inside, and a total failure omits them).
      const additions = await authService.meAdditions(userId, requestBrand(req), { country: requestCountry(req) }).catch(() => null);

      return res.json({
        success: true,
        data: {
          // Public fields only: never the row (it carries token hashes and internal ids).
          user: publicUserOf(req.user),
          profile,
          onboardingState,
          ...(additions ?? {}),
          // There used to be a `jobApplyingEnabled` field here, mirroring the
          // JOB_APPLYING_ENABLED env var so the frontend could hide the
          // auto-apply surface. Auto-apply is gone (ruling R1), the four
          // destinations are unconditional, and the env var is removed from
          // the deploy — so the field would only be a switch nothing reads.
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

/**
 * POST /api/v1/roboapply/auth/logout
 *
 * Deliberately UNAUTHENTICATED. Logout's contract is "make this browser
 * signed out", and that must work even when the session is already dead.
 * The edge proxy only checks that the session cookie EXISTS, so a browser
 * holding a stale cookie (session row revoked/expired — e.g. every session
 * from before the 2026-07 DB split) can reach protected pages while every
 * API call 401s. A requireAuth-gated logout 401'd too and could never clear
 * that dead cookie, leaving the browser stuck in the broken state. The api
 * client's stale-session recovery (lib/api/client.ts) relies on this route
 * to shed the cookie before bouncing to /login.
 *
 * Safety: invalidation is by exact token (idempotent deleteMany) — a caller
 * can only revoke a token it already possesses, and clearing a cookie
 * reveals nothing.
 */
router.post(
  '/logout',
  async (req: Request, res: Response) => {
    try {
      const cookieToken = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
      const headerToken = typeof req.headers['x-session-token'] === 'string'
        ? req.headers['x-session-token']
        : undefined;
      const token = cookieToken ?? headerToken;
      if (token) {
        await invalidateSeekerSession(token);
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
