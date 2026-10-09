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
export const OAuthStartQuerySchema = z.object({ next: NextPath.optional() });
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
  onboarding: OnboardingMe;
  entitlements: EntitlementSummary;
  flags: ResolvedFlags;
  unreadCount: number;
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

export const AUTH_ERROR_CODES = {
  invalidCredentials: 'invalid_credentials',
  tokenInvalid: 'token_invalid',
  tokenExpired: 'token_expired',
  lastIdentity: 'last_identity',
  ageConsentRequired: 'age_consent_required',
  emailUnverified: 'email_unverified',
  oauthStateInvalid: 'oauth_state_invalid',
} as const;
