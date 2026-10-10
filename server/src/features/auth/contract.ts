// server/src/features/auth/contract.ts
//
// Wire contract for the NEW auth and account paths (ARCHITECTURE.md §3.2;
// TASK_PLAN.md WP-10). The legacy routers server/src/roboapply/routes/
// {auth,account}.ts keep /auth/signup, /auth/login, /auth/me, /auth/logout
// and the existing /account/* paths; this area adds only new paths and the
// additive `/auth/me` fields.
//
// Error codes: `account_other_brand` (409, details `{ otherBrandUrl }`, only
// after the password matched the other-brand account), `auth_other_brand`
// (401), `rate_limited` (429), plus the area codes in AUTH_ERROR_CODES.

import { z } from 'zod';
import type { AuthMethod, BrandId } from '../../platform/brand/registry.js';
import type { ResolvedFlags } from '../../platform/flags.js';
import type { EntitlementSummary } from '../../platform/credits/summary.js';
import type { OnboardingMe } from '../onboarding/contract.js';

const Email = z.string().trim().toLowerCase().email().max(254);
/** ≥8 characters with at least one letter and one digit (PRODUCT O0). */
export const PasswordSchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/[A-Za-z]/, 'Include at least one letter.')
  .regex(/\d/, 'Include at least one digit.');

// ── GET /auth/methods ────────────────────────────────────────────────────

export interface AuthMethodView {
  id: AuthMethod;
  /** Start URL for redirect methods (oauth), null for in-page forms. */
  startUrl: string | null;
}
export interface AuthMethodsResponse {
  methods: AuthMethodView[];
  /**
   * ISO-3166 alpha-2 country from the edge (`x-vercel-ip-country`), or null.
   * Drives the LINE-first order and the Taiwan PDPA notice; never stored.
   */
  country: string | null;
  /** True when signup must show the Taiwan PDPA notice line and its consent row (`tw_pdpa_notice`). */
  pdpaNoticeRequired: boolean;
}

// ── Password reset ───────────────────────────────────────────────────────

/** POST /auth/password/forgot → 204 always (no account enumeration). 5/h/email-hash, 20/h/IP. */
export const ForgotPasswordBodySchema = z.object({ email: Email }).strict();
/** POST /auth/password/reset → session; revokes other sessions. Token: 30 min, single use. */
export const ResetPasswordBodySchema = z.object({ token: z.string().min(16).max(512), password: PasswordSchema }).strict();

// ── Email verification ───────────────────────────────────────────────────

/** GET /auth/email/verify?token= → 302 `/settings#account?verified=1`. */
export const VerifyEmailQuerySchema = z.object({ token: z.string().min(16).max(512) });

// ── OAuth (Google, LINE) ─────────────────────────────────────────────────

/** `next` must be a same-site path (never an absolute URL). */
const NextPath = z
  .string()
  .max(512)
  .regex(/^\/(?!\/)/, 'Use a path on this site.');
/**
 * GET /auth/oauth/<provider>/start. From the signup page the visitor has
 * already ticked the required boxes, so the start carries them (`age`,
 * `pdpa`, `marketing`) plus locale, time zone and entry attribution; a new
 * account created by the callback records them. From the login page they are
 * absent, and a brand-new user is asked for them before the account exists.
 */
const Flag01 = z.enum(['0', '1']);
/** Longest `ft` / `lt` value `/oauth/:provider/start` reads (web twin: lib/api/auth.ts). */
export const OAUTH_TOUCH_PARAM_MAX = 1500;

export const OAuthStartQuerySchema = z.object({
  next: NextPath.optional(),
  age: Flag01.optional(),
  pdpa: Flag01.optional(),
  marketing: Flag01.optional(),
  locale: z.string().max(10).optional(),
  tz: z.string().max(64).optional(),
  from: z.string().max(80).optional(),
  job: z.string().max(64).optional(),
  action: z.enum(['apply']).optional(),
  ref: z.string().max(64).optional(),
  utm_source: z.string().max(120).optional(),
  utm_medium: z.string().max(120).optional(),
  utm_campaign: z.string().max(120).optional(),
  alert: z.string().max(200).optional(),
  /**
   * The visitor's stored first / last touch (lib/analytics `getAttribution()`),
   * each as compact JSON. The callback is a GET with no body, so this is how
   * a Google / LINE sign-up keeps an earlier campaign or invite code. A value
   * that is too long or malformed is dropped: it never fails the sign-in.
   */
  ft: z.string().max(OAUTH_TOUCH_PARAM_MAX).optional().catch(undefined),
  lt: z.string().max(OAUTH_TOUCH_PARAM_MAX).optional().catch(undefined),
});
export const OAuthCallbackQuerySchema = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});

// ── Signup additions (legacy POST /auth/signup body, WP-10) ─────────────

/** Attribution captured once at signup (F-ONB-02); mirrors onboarding OnboardingEntry. */
export const SignupAttributionSchema = z
  .object({
    from: z.string().max(80).optional(),
    jobId: z.string().max(64).optional(),
    action: z.enum(['apply']).optional(),
    ref: z.string().max(64).optional(),
    utmSource: z.string().max(120).optional(),
    utmMedium: z.string().max(120).optional(),
    utmCampaign: z.string().max(120).optional(),
    alert: z.string().max(200).optional(),
    anonId: z.string().max(64).optional(),
    landingPath: z.string().max(512).optional(),
  })
  .strict();

export const SignupConsentSchema = z
  .object({ type: z.string().min(1).max(60), granted: z.boolean(), proseVersion: z.string().min(1).max(40) })
  .strict();

/** Fields WP-10 adds to the legacy signup body. `age_16_plus` is required (422 without it). */
export const SignupAdditionsSchema = z.object({
  marketingOptIn: z.boolean().default(false),
  consents: z.array(SignupConsentSchema).max(20),
  attribution: SignupAttributionSchema.optional(),
  timezone: z.string().max(64).optional(),
});

// ── /auth/me additions (additive; `mission` is dropped by WP-10) ─────────

export interface AuthMeAdditions {
  brand: { id: BrandId; name: string; market: 'intl' | 'cn' };
  /**
   * The onboarding stage. A fresh account is at `account` (written by signup);
   * WP-10 points its `nextRoute` at the first onboarding screen (situation /
   * consent), never back at /signup.
   */
  onboarding: OnboardingMe;
  /** Null only when the credits service could not answer (never invented). */
  entitlements: EntitlementSummary | null;
  flags: ResolvedFlags;
  /** Unread message-center items; null when unknown (never a guessed 0). */
  unreadCount: number | null;
  /** Email/password accounts start unverified; verification is not blocking. */
  emailVerified: boolean;
}

// ── /account/identities ──────────────────────────────────────────────────

export const IDENTITY_PROVIDERS = ['google', 'line', 'wechat', 'phone', 'email'] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

export interface IdentityView {
  id: string;
  provider: IdentityProvider;
  /** Masked display value (e.g. "k•••@gmail.com", "+86 138••••1234"). */
  display: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** False when this is the last way to sign in. */
  removable: boolean;
}
export interface IdentitiesResponse {
  identities: IdentityView[];
}
export const IdentityParamsSchema = z.object({ id: z.string().min(1).max(64) });

/** `RAAuthIdentity.profile` (documented JSON column): name/avatar as returned by the provider. */
export const AuthIdentityProfileSchema = z
  .object({ name: z.string().optional(), avatarUrl: z.string().optional(), locale: z.string().optional() })
  .passthrough();

// ── /account/consents ────────────────────────────────────────────────────

export interface ConsentView {
  type: string;
  granted: boolean;
  proseVersion: string | null;
  at: string;
}
export interface ConsentsResponse {
  consents: ConsentView[];
}
export const RecordConsentBodySchema = z
  .object({ type: z.string().min(1).max(60), granted: z.boolean(), proseVersion: z.string().min(1).max(40) })
  .strict();

// ── OAuth callback (JSON form, called by app/auth/callback/<provider>) ───

/**
 * GET /auth/oauth/<provider>/callback answers JSON when the client asks for it
 * (`Accept: application/json`), else 302s to `next`.
 *   - `signed_in`: session cookie set; go to `next`.
 *   - `email_required`: the provider returned no verified email; the user
 *     enters one and verifies it before the account exists
 *     (POST /auth/oauth/email).
 * The callback must come from the browser that started the attempt: start
 * sets a short-lived httpOnly cookie (`ra_oauth_state`) whose hash is stored
 * with the state, and the callback refuses a state without it
 * (`oauth_state_invalid`).
 */
export type OAuthCallbackResult =
  | { status: 'signed_in'; next: string; isNewUser: boolean }
  | { status: 'consent_required'; pendingToken: string; next: string; name: string | null; email: string | null }
  | { status: 'email_required'; pendingToken: string; next: string; name: string | null };

/** POST /auth/oauth/complete: a new OAuth user ticks the required signup boxes; the account is created. */
export const OAuthCompleteBodySchema = z
  .object({
    pendingToken: z.string().min(16).max(512),
    consents: z.array(SignupConsentSchema).max(20),
    marketingOptIn: z.boolean().default(false),
    locale: z.string().max(10).optional(),
    timezone: z.string().max(64).optional(),
  })
  .strict();

/**
 * POST /auth/oauth/email: the provider gave no verified email (LINE often
 * omits it); send a verification link that finishes the account. Gated on
 * the capability of the provider recorded in the pending token.
 */
export const OAuthEmailBodySchema = z
  .object({
    pendingToken: z.string().min(16).max(512),
    email: Email,
    consents: z.array(SignupConsentSchema).max(20),
    marketingOptIn: z.boolean().default(false),
    locale: z.string().max(10).optional(),
    timezone: z.string().max(64).optional(),
  })
  .strict();

/**
 * GET /auth/email/verify (JSON form): what the link did.
 *   - `account_exists`: a LINE sign-up link for an address that already has
 *     an account on this site. Nothing was linked or created; the person
 *     signs in to that account the way they did before.
 */
export type VerifyEmailResult =
  | { status: 'verified'; next: string }
  | { status: 'signed_in'; next: string; isNewUser: boolean }
  | { status: 'account_exists'; next: string };

/** POST /auth/signup when the email belongs to the other brand: the normal "check your email" answer (no 409; H34). */
export interface SignupCheckEmailResponse {
  status: 'check_email';
}

// ── /account/sessions ─────────────────────────────────────────────────────

export interface SessionView {
  id: string;
  createdAt: string;
  expiresAt: string;
  /** The session making this request. */
  current: boolean;
}
export interface SessionsResponse {
  sessions: SessionView[];
}
export const SessionParamsSchema = z.object({ id: z.string().min(1).max(64) });

/** GET /auth/email/status (S): drives the "verify your email" line in Settings. */
export interface EmailStatusResponse {
  email: string;
  verified: boolean;
  /** Email/password accounts get a verification email; OAuth-created accounts are verified by the provider. */
  canResend: boolean;
}

/** Consent types every signup must grant (H29: both brands). */
export const REQUIRED_SIGNUP_CONSENTS = ['age_16_plus'] as const;

export const AUTH_ERROR_CODES = {
  invalidCredentials: 'invalid_credentials',
  tokenInvalid: 'token_invalid',
  tokenExpired: 'token_expired',
  lastIdentity: 'last_identity',
  ageConsentRequired: 'age_consent_required',
  emailUnverified: 'email_unverified',
  oauthStateInvalid: 'oauth_state_invalid',
  pdpaConsentRequired: 'pdpa_consent_required',
  unknownConsent: 'unknown_consent',
  weakPassword: 'weak_password',
  oauthFailed: 'oauth_failed',
  emailTaken: 'email_taken',
  accountDisabled: 'account_disabled',
  accountDeleted: 'account_deleted',
  consentLocked: 'consent_locked',
  notSeekerAccount: 'not_a_seeker_account',
  /** A provider sign-in may not create an account on this brand (GoApply: phone, WeChat or the email form do). */
  signupClosed: 'signup_closed',
} as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

// ── `next` after sign-in ─────────────────────────────────────────────────

/**
 * `next` paths honoured right after sign-in or sign-up even while onboarding
 * is unfinished: the public free-tool pages, where a signed-out visitor asked
 * to keep a result and create an account (WP-57). Any other same-site `next`
 * waits until onboarding is done (R-06). Web twin: `PRIORITY_NEXT_PATHS` in
 * lib/auth/entry.ts (a test keeps the two equal).
 */
export const PRIORITY_NEXT_PATHS = ['/tools/resume-check', '/tools/resume-job-match'] as const;

/** True when `next` (a same-site path, query and hash ignored) is one of PRIORITY_NEXT_PATHS. */
export function isPriorityNext(next: string | null | undefined): boolean {
  if (typeof next !== 'string') return false;
  const path = next.split(/[?#]/)[0]!.replace(/\/+$/, '');
  return (PRIORITY_NEXT_PATHS as readonly string[]).includes(path);
}
