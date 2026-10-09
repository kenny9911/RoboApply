// server/src/features/auth/service.ts
//
// The auth area service (WP-10; ARCHITECTURE.md §3.2; PRODUCT_PLAN.md O0,
// F-ACCT-01/02/06, F-ONB-11, F-TRUST-01). Everything brand-dependent takes
// the brand explicitly (routes pass `getCurrentBrand()`), so a request never
// mixes markets. Every dependency is injectable for tests (no network, no DB).
//
// Covers: the method list, password reset (30-minute single-use link that
// revokes every other session), email verification (non-blocking; the first
// verification grants the free practice credit once, idempotently), Google and
// LINE sign-in (find or create a SEEKER; link by verified email only within the
// same brand; a provider user without a verified email verifies one before the
// account exists), `/auth/me` additions, linked sign-in methods, consents,
// sessions, the new-device email, the cross-brand signup notice and the
// deletion email.
//
// Account-safety rules for provider sign-in:
//   - The state is bound to the browser that started it (`binder`, a random
//     value the route keeps in an httpOnly cookie; only its hash is stored).
//   - Only seeker accounts (a SeekerProfile, or an admin) are signed in or
//     linked, as with the password login.
//   - Linking to an account whose email was never verified treats the
//     provider as the first proof of inbox ownership: the password set by
//     whoever created that account is removed and every session and open
//     reset/verification link is revoked before the provider is linked.
//   - An emailed "finish creating your account" link never attaches the
//     provider to an existing account (`account_exists`).

import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { logger } from '../../services/LoggerService.js';
import { getBrand, type BrandId, type ProductBrand } from '../../platform/brand/registry.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { HttpError } from '../../platform/http.js';
import { isEnabledForBrand, resolveFlagsForUser, type ResolvedFlags } from '../../platform/flags.js';
import { emailOrigin, sendEmail as platformSendEmail, type SendEmailInput, type SendEmailResult } from '../../platform/email/index.js';
import { AUTH_EMAIL_KEYS } from '../../platform/email/templates/auth/index.js';
import { grantPracticeCredit as platformGrantPracticeCredit, type PracticeGrantResult } from '../../platform/credits/index.js';
import { summarizeEntitlementsForMe, type EntitlementSummary } from '../../platform/credits/summary.js';
import { createSeekerSession } from '../../roboapply/engine/lib/seekerSession.js';
import { retentionDaysFor } from '../../roboapply/services/accountPurgeHelpers.js';
import {
  canonicalConsentType,
  isSeekerConsentType,
  SEEKER_CONSENT_TYPES,
  type SeekerConsentType,
} from '../../roboapply/engine/lib/seekerConsentTypes.js';
import { buildOnboardingMe, firstValueRoute, nextStage, routeForStage, type OnboardingMe } from '../onboarding/contract.js';
import { growthService } from '../growth/index.js';
import {
  REQUIRED_SIGNUP_CONSENTS,
  type AuthMeAdditions,
  type AuthMethodsResponse,
  type AuthMethodView,
  type ConsentView,
  type IdentityProvider,
  type IdentityView,
  type OAuthCallbackResult,
  type SessionView,
  type VerifyEmailResult,
} from './contract.js';
import { createSeekerAccount } from './accounts.js';
import { deviceMarkRaw, parseDevice } from './devices.js';
import { authErrors } from './errors.js';
import { authorizeUrl, finishOAuth, newNonce, OAuthProviderError, pkcePair, type FetchLike, type OAuthProviderId, type VerifiedIdentity } from './oauth/providers.js';
import {
  assertPassword,
  marketForSignup,
  onboardingEntryFrom,
  pdpaNoticeRequired,
  safeTimezone,
  touchFrom,
  validateSignupConsents,
  type ConsentRow,
  type SignupAttributionInput,
  type SignupConsentInput,
} from './signupPolicy.js';
import { AUTH_TOKEN_KINDS, consumeToken, hashToken, issueToken, newRawToken, revokeTokens, TOKEN_TTL_MS } from './tokens.js';

const SALT_ROUNDS = 12;
const API = '/api/v1/roboapply/auth';

/** The capability that gates each provider (R-04). */
const PROVIDER_CAPABILITY: Record<OAuthProviderId, 'auth.google' | 'auth.line'> = { google: 'auth.google', line: 'auth.line' };

/** PRODUCT O0 row 3: LINE is offered only to zh-TW visitors and visitors from Taiwan. */
export function lineAudience(locale: string | null | undefined, country: string | null | undefined): boolean {
  return locale === 'zh-TW' || (country ?? '').toUpperCase() === 'TW';
}

export type AuthDb = Pick<
  typeof prisma,
  'user' | 'seekerProfile' | 'session' | 'rAAuthToken' | 'rAAuthIdentity' | 'seekerConsentRecord' | 'seekerNotification' | '$transaction'
>;

export interface AuthServiceDeps {
  db?: AuthDb;
  env?: EnvSource;
  now?: () => Date;
  sendEmail?: (input: SendEmailInput<Record<string, unknown>>) => Promise<SendEmailResult>;
  fetch?: FetchLike;
  createSession?: (userId: string) => Promise<{ token: string; expiresAt: Date }>;
  hashPassword?: (password: string) => Promise<string>;
  grantPracticeCredit?: (userId: string, reason: 'email_verified', key: string) => Promise<PracticeGrantResult>;
  summarizeEntitlements?: (userId: string, brand: BrandId) => Promise<EntitlementSummary>;
  resolveFlags?: (userId: string, brand: ProductBrand) => Promise<ResolvedFlags>;
  recordAttribution?: typeof growthService.recordAttribution;
}

/** Signup context carried through an OAuth round trip (from the signup page) or collected on the callback page. */
export interface OAuthSignupContext {
  consents: SignupConsentInput[];
  marketingOptIn: boolean;
  locale: string | null;
  timezone: string | null;
  country: string | null;
  attribution?: SignupAttributionInput;
}

interface PendingPayload {
  identity: VerifiedIdentity;
  next: string | null;
  signup?: OAuthSignupContext | null;
}

/** Quiet log that never throws (some test doubles of the logger omit levels). */
function note(level: 'info' | 'warn' | 'error', message: string, meta: Record<string, unknown>): void {
  const fn = (logger as unknown as Record<string, unknown>)[level];
  if (typeof fn === 'function') (fn as (tag: string, msg: string, meta: unknown) => void).call(logger, 'AUTH', message, meta);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '•••';
  return `${local.slice(0, 1)}•••@${domain}`;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length < 7) return '•••';
  return `${digits.slice(0, digits.length - 8)}${digits.slice(-8, -4).replace(/\d/g, '•')}${digits.slice(-4)}`;
}

function isSafeNext(next: unknown): next is string {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) && next.length <= 512;
}

export interface SignInTarget {
  userId: string;
  sessionToken: string;
}

export function createAuthFeatureService(deps: AuthServiceDeps = {}) {
  const db = (): AuthDb => deps.db ?? prisma;
  const env = (): EnvSource => deps.env ?? process.env;
  const now = (): Date => deps.now?.() ?? new Date();
  const send = (input: SendEmailInput<Record<string, unknown>>) => (deps.sendEmail ?? platformSendEmail)(input);
  const createSession = (userId: string) => (deps.createSession ?? createSeekerSession)(userId);
  const hashPassword = (pw: string) => (deps.hashPassword ?? ((p: string) => bcrypt.hash(p, SALT_ROUNDS)))(pw);
  const grant = (userId: string) =>
    (deps.grantPracticeCredit ?? ((u, r, k) => platformGrantPracticeCredit(u, r, k)))(userId, 'email_verified', 'email_verified');

  // ── Shared helpers ──────────────────────────────────────────────────────

  async function profileOf(userId: string) {
    return db().seekerProfile.findUnique({
      where: { userId },
      select: { id: true, locale: true, deletedAt: true, onboardingStep: true, onboardingPath: true },
    });
  }

  /** Where a signed-in user goes: their onboarding screen when unfinished, else `next` or the first-value route. */
  async function signInRoute(brand: ProductBrand, userId: string, next: string | null): Promise<string> {
    const profile = await profileOf(userId);
    const onboarding = onboardingFor(brand, profile, flagContext(brand));
    if (!onboarding.completed && onboarding.nextRoute) return onboarding.nextRoute;
    if (next && isSafeNext(next)) return next;
    return firstValueRoute(brand.id, flagContext(brand));
  }

  function flagContext(brand: ProductBrand) {
    return {
      campusCalendar: isEnabledForBrand('jobs.campusCalendar', brand, env()),
      jobsFeed: isEnabledForBrand('jobs.feed', brand, env()),
    };
  }

  /** Grant the free practice credit for the first verified email (idempotent; never throws). */
  async function grantVerificationCredit(userId: string): Promise<void> {
    try {
      const res = await grant(userId);
      if (res.status === 'failed') note('warn', 'verification practice credit not granted', { userId, status: res.status });
    } catch (err) {
      note('warn', 'verification practice credit failed', { userId, error: errText(err) });
    }
  }

  async function markEmailVerified(userId: string): Promise<void> {
    const at = now();
    await db().user.updateMany({ where: { id: userId, emailVerified: false }, data: { emailVerified: true, emailVerifiedAt: at } });
    await grantVerificationCredit(userId);
  }

  function ensureCanSignIn(user: { isActive: boolean }, profile: { deletedAt: Date | null } | null): void {
    if (user.isActive === false) throw authErrors.accountDisabled();
    if (profile?.deletedAt) throw authErrors.accountDeleted();
  }

  /**
   * Provider sign-in follows the password login (SeekerAuthService.login):
   * only a seeker (a SeekerProfile) or an admin gets a seeker session, so a
   * recruiter-only User row is never linked or signed in here.
   */
  function ensureSeeker(user: { role?: string | null }, profile: unknown): void {
    if (!profile && user.role !== 'admin') throw authErrors.notSeekerAccount();
  }

  function otherBrandError(accountBrand: BrandId): HttpError {
    return new HttpError('account_other_brand', 'This account belongs to the other site. Sign in there instead.', {
      otherBrandUrl: `${getBrand(accountBrand).canonicalOrigin}/login`,
    });
  }

  async function sendSafe(input: SendEmailInput<Record<string, unknown>>): Promise<SendEmailResult | null> {
    try {
      return await send(input);
    } catch (err) {
      note('warn', 'auth email failed', { template: String(input.template), error: errText(err) });
      return null;
    }
  }

  // ── Methods ─────────────────────────────────────────────────────────────

  function listMethods(input: { brand: ProductBrand; locale?: string | null; country?: string | null }): AuthMethodsResponse {
    const { brand } = input;
    const e = env();
    const views: AuthMethodView[] = [];
    for (const id of brand.authMethods) {
      switch (id) {
        case 'email_password':
          views.push({ id, startUrl: null });
          break;
        case 'google':
          if (isEnabledForBrand('auth.google', brand, e)) views.push({ id, startUrl: `${API}/oauth/google/start` });
          break;
        case 'line':
          if (isEnabledForBrand('auth.line', brand, e)) views.push({ id, startUrl: `${API}/oauth/line/start` });
          break;
        case 'phone_otp':
          if (isEnabledForBrand('auth.phoneOtp', brand, e)) views.push({ id, startUrl: null });
          break;
        case 'wechat':
          if (isEnabledForBrand('auth.wechatWeb', brand, e) || isEnabledForBrand('auth.wechatInApp', brand, e)) {
            views.push({ id, startUrl: `${API}/wechat/qr` });
          }
          break;
      }
    }
    const country = input.country ? input.country.toUpperCase() : null;
    // PRODUCT O0 row 3: LINE only for zh-TW visitors and visitors from
    // Taiwan, and then first (CN plan §2.1).
    let methods = views;
    if (lineAudience(input.locale, country)) {
      const at = views.findIndex((v) => v.id === 'line');
      if (at > 0) views.unshift(...views.splice(at, 1));
    } else {
      methods = views.filter((v) => v.id !== 'line');
    }
    return { methods, country, pdpaNoticeRequired: pdpaNoticeRequired(brand.id, input.locale, country) };
  }

  // ── Password reset ──────────────────────────────────────────────────────

  /** Always resolves (no account enumeration). Emails a 30-minute link to a same-brand account. */
  async function requestPasswordReset(input: { email: string; brand: ProductBrand }): Promise<void> {
    const email = input.email.trim().toLowerCase();
    const user = await db().user.findUnique({
      where: { email },
      select: { id: true, email: true, brand: true, isActive: true, emailIsPlaceholder: true },
    });
    if (!user || user.brand !== input.brand.id || !user.isActive || user.emailIsPlaceholder) return;
    const profile = await profileOf(user.id);
    if (profile?.deletedAt) return;
    await revokeTokens(db(), user.id, AUTH_TOKEN_KINDS.passwordReset, now());
    const { raw } = await issueToken(db(), { kind: 'password_reset', brand: input.brand.id, userId: user.id, now: now() });
    await sendSafe({
      template: AUTH_EMAIL_KEYS.passwordReset,
      to: user.email,
      userId: user.id,
      locale: profile?.locale ?? null,
      brand: input.brand,
      params: { path: `/reset-password/${raw}` },
    });
  }

  /** Sets the password, revokes every session and reset link, and signs this browser in. */
  async function resetPassword(input: { token: string; password: string; brand: ProductBrand }): Promise<SignInTarget> {
    assertPassword(input.password);
    const at = now();
    const consumed = await consumeToken(db(), input.token, AUTH_TOKEN_KINDS.passwordReset, input.brand.id, at);
    if (!consumed.userId) throw authErrors.tokenInvalid();
    const user = await db().user.findUnique({ where: { id: consumed.userId }, select: { id: true, isActive: true, emailVerified: true } });
    if (!user) throw authErrors.tokenInvalid();
    ensureCanSignIn(user, await profileOf(user.id));
    const passwordHash = await hashPassword(input.password);
    await db().user.update({ where: { id: user.id }, data: { passwordHash } });
    await db().session.deleteMany({ where: { userId: user.id } });
    await revokeTokens(db(), user.id, AUTH_TOKEN_KINDS.passwordReset, at);
    // The link reached the inbox, so the address is proven.
    if (!user.emailVerified) await markEmailVerified(user.id);
    const session = await createSession(user.id);
    return { userId: user.id, sessionToken: session.token };
  }

  // ── Email verification ─────────────────────────────────────────────────

  async function emailStatus(userId: string) {
    const user = await db().user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerified: true, emailIsPlaceholder: true, passwordHash: true },
    });
    if (!user) throw new HttpError('not_found');
    return { email: user.email, verified: user.emailVerified, canResend: !user.emailVerified && !user.emailIsPlaceholder };
  }

  async function sendVerificationEmail(input: { userId: string; brand: ProductBrand }): Promise<{ sent: boolean; alreadyVerified: boolean }> {
    const user = await db().user.findUnique({
      where: { id: input.userId },
      select: { id: true, email: true, emailVerified: true, emailIsPlaceholder: true },
    });
    if (!user) throw new HttpError('not_found');
    if (user.emailVerified) return { sent: false, alreadyVerified: true };
    if (user.emailIsPlaceholder) return { sent: false, alreadyVerified: false };
    const profile = await profileOf(user.id);
    await revokeTokens(db(), user.id, AUTH_TOKEN_KINDS.emailVerify, now());
    const { raw } = await issueToken(db(), {
      kind: 'email_verify',
      brand: input.brand.id,
      userId: user.id,
      payload: { email: user.email },
      now: now(),
    });
    const res = await sendSafe({
      template: AUTH_EMAIL_KEYS.emailVerify,
      to: user.email,
      userId: user.id,
      locale: profile?.locale ?? null,
      brand: input.brand,
      params: { path: `/verify-email/${raw}` },
    });
    return { sent: res?.status === 'sent', alreadyVerified: false };
  }

  /**
   * Burns a verification link. For an existing account it marks the email
   * verified (and grants the free practice credit once). For a LINE sign-up
   * that had no email, it creates (or links) the account now.
   */
  async function verifyEmail(input: {
    token: string;
    brand: ProductBrand;
    userAgent?: string | null;
  }): Promise<VerifyEmailResult & { signIn?: SignInTarget }> {
    const consumed = await consumeToken(db(), input.token, AUTH_TOKEN_KINDS.emailVerify, input.brand.id, now());
    const payload = (consumed.payload ?? {}) as { email?: string; pending?: PendingPayload };
    if (consumed.userId) {
      const user = await db().user.findUnique({ where: { id: consumed.userId }, select: { id: true, email: true } });
      if (!user || (payload.email && payload.email !== user.email)) throw authErrors.tokenInvalid();
      await markEmailVerified(user.id);
      return { status: 'verified', next: '/settings#account' };
    }
    if (!payload.pending || !payload.email) throw authErrors.tokenInvalid();
    // The link proves the inbox, not that the person who started the
    // provider sign-in owns an account at that address: never attach the
    // provider to an existing account here (the token is already burned).
    const holder = await db().user.findUnique({ where: { email: payload.email }, select: { id: true, brand: true, role: true } });
    if (holder) {
      if (holder.brand !== input.brand.id && holder.role !== 'admin') {
        throw otherBrandError(holder.brand === 'goapply' ? 'goapply' : 'roboapply');
      }
      return { status: 'account_exists', next: '/login' };
    }
    const identity: VerifiedIdentity = { ...payload.pending.identity, email: payload.email, emailVerified: true };
    const result = await resolveIdentity(identity, input.brand, payload.pending.signup ?? null, payload.pending.next, input.userAgent ?? null);
    if (result.status !== 'signed_in' || !result.signIn) throw authErrors.tokenInvalid();
    return { status: 'signed_in', next: result.next, isNewUser: result.isNewUser, signIn: result.signIn };
  }

  // ── OAuth ───────────────────────────────────────────────────────────────

  async function startOAuth(input: {
    provider: OAuthProviderId;
    brand: ProductBrand;
    redirectUri: string;
    next?: string | null;
    signup?: OAuthSignupContext | null;
  }): Promise<{ url: string; binder: string }> {
    const { verifier, challenge } = pkcePair();
    const nonce = newNonce();
    // Browser binding: the route keeps `binder` in an httpOnly cookie; the
    // callback must present it (login CSRF / session fixation).
    const binder = newRawToken();
    const { raw } = await issueToken(db(), {
      kind: 'oauth_state',
      brand: input.brand.id,
      payload: {
        provider: input.provider,
        binderHash: hashToken(binder),
        verifier,
        nonce,
        redirectUri: input.redirectUri,
        next: isSafeNext(input.next) ? input.next : null,
        signup: (input.signup ?? null) as unknown as Prisma.InputJsonValue,
      },
      now: now(),
    });
    const url = authorizeUrl(
      input.provider,
      { redirectUri: input.redirectUri, state: raw, challenge, nonce, locale: input.signup?.locale ?? null },
      env(),
    );
    return { url, binder };
  }

  type ResolveResult =
    | { status: 'signed_in'; next: string; isNewUser: boolean; signIn: SignInTarget }
    | Exclude<OAuthCallbackResult, { status: 'signed_in' }>;

  async function pending(
    status: 'consent_required' | 'email_required',
    identity: VerifiedIdentity,
    brand: ProductBrand,
    next: string | null,
    signup: OAuthSignupContext | null,
  ): Promise<ResolveResult> {
    const { raw } = await issueToken(db(), {
      kind: 'oauth_pending',
      brand: brand.id,
      payload: { identity, next, signup } as unknown as Prisma.InputJsonValue,
      now: now(),
    });
    const base = { pendingToken: raw, next: next ?? '/jobs', name: identity.name };
    return status === 'consent_required' ? { status, ...base, email: identity.email } : { status, ...base };
  }

  /** Find or create the seeker for a verified provider identity (same brand only). */
  async function resolveIdentity(
    identity: VerifiedIdentity,
    brand: ProductBrand,
    signup: OAuthSignupContext | null,
    next: string | null,
    userAgent: string | null,
  ): Promise<ResolveResult> {
    const d = db();
    const linked = await d.rAAuthIdentity.findFirst({
      where: { brand: brand.id, provider: identity.provider, appId: '', subject: identity.subject },
      select: { id: true, userId: true },
    });
    if (linked) {
      const user = await d.user.findUnique({ where: { id: linked.userId }, select: { id: true, email: true, isActive: true, brand: true, role: true } });
      if (!user) throw authErrors.oauthFailed('identity_without_user');
      const linkedProfile = await profileOf(user.id);
      ensureSeeker(user, linkedProfile);
      ensureCanSignIn(user, linkedProfile);
      await d.rAAuthIdentity.update({ where: { id: linked.id }, data: { lastUsedAt: now() } });
      const session = await createSession(user.id);
      await notifyIfNewDevice({ userId: user.id, email: user.email, brand, userAgent });
      return { status: 'signed_in', next: await signInRoute(brand, user.id, next), isNewUser: false, signIn: { userId: user.id, sessionToken: session.token } };
    }

    if (!identity.email || !identity.emailVerified) {
      return pending('email_required', identity, brand, next, signup);
    }

    const existing = await d.user.findUnique({
      where: { email: identity.email },
      select: { id: true, email: true, isActive: true, brand: true, role: true, emailVerified: true },
    });
    if (existing) {
      if (existing.brand !== brand.id && existing.role !== 'admin') {
        // The provider proved the address, which is the OAuth equivalent of a
        // matching password (ARCH §1.10): say where the account lives.
        throw otherBrandError(existing.brand === 'goapply' ? 'goapply' : 'roboapply');
      }
      const existingProfile = await profileOf(existing.id);
      ensureSeeker(existing, existingProfile);
      ensureCanSignIn(existing, existingProfile);
      // An unverified email means nobody has proven this inbox yet; the
      // provider is the first proof. Whoever created the account (possibly
      // someone squatting on this address, since verification does not block
      // signup) loses the password they chose, every session and every open
      // reset/verification link, in the same transaction as the link.
      const firstProof = !existing.emailVerified;
      const at = now();
      await d.$transaction(async (tx) => {
        if (firstProof) {
          await tx.user.update({ where: { id: existing.id }, data: { passwordHash: null, emailVerified: true, emailVerifiedAt: at } });
          await tx.session.deleteMany({ where: { userId: existing.id } });
          await tx.rAAuthToken.updateMany({
            where: { userId: existing.id, kind: { in: [AUTH_TOKEN_KINDS.passwordReset, AUTH_TOKEN_KINDS.emailVerify] }, consumedAt: null },
            data: { consumedAt: at },
          });
        }
        await tx.rAAuthIdentity.create({
          data: {
            userId: existing.id,
            brand: brand.id,
            provider: identity.provider,
            appId: '',
            subject: identity.subject,
            email: identity.email,
            profile: { name: identity.name ?? undefined, avatarUrl: identity.avatarUrl ?? undefined },
            lastUsedAt: at,
          },
        });
      });
      if (firstProof) {
        note('info', 'provider linked to an unverified account: password and sessions revoked', { userId: existing.id, provider: identity.provider });
        await grantVerificationCredit(existing.id);
      }
      const session = await createSession(existing.id);
      await notifyIfNewDevice({ userId: existing.id, email: existing.email, brand, userAgent });
      return {
        status: 'signed_in',
        next: await signInRoute(brand, existing.id, next),
        isNewUser: false,
        signIn: { userId: existing.id, sessionToken: session.token },
      };
    }

    // A brand-new account needs the signup agreements first (H29).
    let consentRows: ConsentRow[];
    try {
      if (!signup) throw authErrors.ageConsentRequired();
      consentRows = validateSignupConsents({
        brand: brand.id,
        consents: signup.consents,
        marketingOptIn: signup.marketingOptIn,
        locale: signup.locale,
        country: signup.country,
      });
    } catch {
      return pending('consent_required', identity, brand, next, signup ? { ...signup, consents: [] } : null);
    }

    const locale = signup!.locale && (brand.locales as string[]).includes(signup!.locale) ? signup!.locale : brand.defaultLocale;
    const created = await d.$transaction(async (tx) => {
      const account = await createSeekerAccount(tx, {
        email: identity.email!,
        passwordHash: null,
        name: identity.name,
        provider: identity.provider,
        providerId: identity.subject,
        emailVerified: true,
        brand: brand.id,
        market: marketForSignup(brand.id, locale),
        locale,
        consentRows,
        entry: onboardingEntryFrom(signup!.attribution),
        timezone: safeTimezone(signup!.timezone),
        now: now(),
      });
      await tx.rAAuthIdentity.create({
        data: {
          userId: account.user.id,
          brand: brand.id,
          provider: identity.provider,
          appId: '',
          subject: identity.subject,
          email: identity.email,
          profile: { name: identity.name ?? undefined, avatarUrl: identity.avatarUrl ?? undefined },
          lastUsedAt: now(),
        },
      });
      return account;
    });
    await afterAccountCreated(created.user.id, signup!, userAgent);
    await grantVerificationCredit(created.user.id);
    const session = await createSession(created.user.id);
    return {
      status: 'signed_in',
      next: firstOnboardingRoute(brand),
      isNewUser: true,
      signIn: { userId: created.user.id, sessionToken: session.token },
    };
  }

  async function finishOAuthCallback(input: {
    provider: OAuthProviderId;
    brand: ProductBrand;
    code?: string;
    state?: string;
    error?: string;
    userAgent?: string | null;
    /** The value of the browser-binding cookie set by /start (null when absent). */
    binder?: string | null;
  }): Promise<ResolveResult> {
    if (input.error) throw authErrors.oauthFailed(input.error);
    if (!input.state || !input.code) throw authErrors.oauthStateInvalid();
    let state;
    try {
      state = await consumeToken(db(), input.state, AUTH_TOKEN_KINDS.oauthState, input.brand.id, now());
    } catch {
      throw authErrors.oauthStateInvalid();
    }
    const payload = (state.payload ?? {}) as {
      provider?: string;
      binderHash?: string;
      verifier?: string;
      nonce?: string;
      redirectUri?: string;
      next?: string | null;
      signup?: OAuthSignupContext | null;
    };
    if (payload.provider !== input.provider || !payload.verifier || !payload.nonce || !payload.redirectUri) {
      throw authErrors.oauthStateInvalid();
    }
    // A state started in another browser (e.g. a crafted callback link) is
    // refused, so nobody can sign a victim's browser into their account.
    if (!payload.binderHash || !input.binder || hashToken(input.binder) !== payload.binderHash) {
      throw authErrors.oauthStateInvalid();
    }
    let identity: VerifiedIdentity;
    try {
      identity = await finishOAuth(
        input.provider,
        { code: input.code, redirectUri: payload.redirectUri, verifier: payload.verifier, nonce: payload.nonce },
        { env: env(), fetch: deps.fetch, now: () => now().getTime() },
      );
    } catch (err) {
      if (err instanceof OAuthProviderError) throw authErrors.oauthFailed(err.reason);
      throw err;
    }
    return resolveIdentity(identity, input.brand, payload.signup ?? null, payload.next ?? null, input.userAgent ?? null);
  }

  async function consumePending(token: string, brand: ProductBrand): Promise<PendingPayload> {
    const consumed = await consumeToken(db(), token, AUTH_TOKEN_KINDS.oauthPending, brand.id, now());
    const payload = consumed.payload as PendingPayload | null;
    if (!payload?.identity?.subject) throw authErrors.tokenInvalid();
    return payload;
  }

  /** POST /auth/oauth/complete — a new OAuth user agrees to the signup terms. */
  async function completeOAuth(input: {
    pendingToken: string;
    brand: ProductBrand;
    consents: SignupConsentInput[];
    marketingOptIn: boolean;
    locale?: string | null;
    timezone?: string | null;
    country?: string | null;
    userAgent?: string | null;
  }): Promise<ResolveResult> {
    // Validate before burning the pending token, so a missed box can be fixed.
    validateSignupConsents({
      brand: input.brand.id,
      consents: input.consents,
      marketingOptIn: input.marketingOptIn,
      locale: input.locale,
      country: input.country,
    });
    const payload = await consumePending(input.pendingToken, input.brand);
    if (!payload.identity.email || !payload.identity.emailVerified) throw authErrors.tokenInvalid();
    const signup: OAuthSignupContext = {
      consents: input.consents,
      marketingOptIn: input.marketingOptIn,
      locale: input.locale ?? payload.signup?.locale ?? null,
      timezone: input.timezone ?? payload.signup?.timezone ?? null,
      country: input.country ?? null,
      attribution: payload.signup?.attribution,
    };
    return resolveIdentity(payload.identity, input.brand, signup, payload.next, input.userAgent ?? null);
  }

  /**
   * POST /auth/oauth/email — the provider gave no verified email (LINE often
   * omits it): send a link that finishes the account. Available while the
   * pending provider's capability is on (not only LINE's).
   */
  async function oauthEmail(input: {
    pendingToken: string;
    email: string;
    brand: ProductBrand;
    consents: SignupConsentInput[];
    marketingOptIn: boolean;
    locale?: string | null;
    timezone?: string | null;
    country?: string | null;
  }): Promise<{ status: 'check_email' }> {
    const email = input.email.trim().toLowerCase();
    validateSignupConsents({
      brand: input.brand.id,
      consents: input.consents,
      marketingOptIn: input.marketingOptIn,
      locale: input.locale,
      country: input.country,
    });
    const payload = await consumePending(input.pendingToken, input.brand);
    const capability = PROVIDER_CAPABILITY[payload.identity.provider as OAuthProviderId];
    if (!capability || !isEnabledForBrand(capability, input.brand, env())) throw new HttpError('feature_disabled');
    const signup: OAuthSignupContext = {
      consents: input.consents,
      marketingOptIn: input.marketingOptIn,
      locale: input.locale ?? payload.signup?.locale ?? null,
      timezone: input.timezone ?? payload.signup?.timezone ?? null,
      country: input.country ?? null,
      attribution: payload.signup?.attribution,
    };
    const { raw } = await issueToken(db(), {
      kind: 'email_verify',
      brand: input.brand.id,
      userId: null,
      payload: { email, pending: { identity: payload.identity, next: payload.next, signup } } as unknown as Prisma.InputJsonValue,
      now: now(),
    });
    await sendSafe({
      template: AUTH_EMAIL_KEYS.oauthEmail,
      to: email,
      locale: signup.locale,
      brand: input.brand,
      params: { path: `/verify-email/${raw}` },
    });
    return { status: 'check_email' };
  }

  function firstOnboardingRoute(brand: ProductBrand): string {
    return routeForStage(brand.id, nextStage(brand.id, 'account', null), flagContext(brand)) ?? '/jobs';
  }

  /** Attribution seam (WP-23) + first device mark. Never throws. */
  async function afterAccountCreated(userId: string, signup: { attribution?: SignupAttributionInput }, userAgent: string | null) {
    const touch = touchFrom(signup.attribution, now());
    if (touch) {
      try {
        await (deps.recordAttribution ?? growthService.recordAttribution)(userId, touch, { anonId: signup.attribution?.anonId });
      } catch (err) {
        note('info', 'attribution not recorded (growth seam)', { userId, error: errText(err) });
      }
    }
    await registerDevice(userId, userAgent);
  }

  // ── New-device email (F-TRUST-01) ──────────────────────────────────────

  async function registerDevice(userId: string, userAgent: string | null): Promise<void> {
    try {
      const device = parseDevice(userAgent);
      const tokenHash = hashToken(deviceMarkRaw(userId, device));
      const expiresAt = new Date(now().getTime() + TOKEN_TTL_MS.known_device);
      const existing = await db().rAAuthToken.findUnique({ where: { tokenHash }, select: { id: true } });
      if (existing) await db().rAAuthToken.update({ where: { id: existing.id }, data: { expiresAt } });
      else {
        const brand = await db().user.findUnique({ where: { id: userId }, select: { brand: true } });
        await db().rAAuthToken.create({
          data: { kind: AUTH_TOKEN_KINDS.knownDevice, brand: brand?.brand ?? 'roboapply', userId, tokenHash, expiresAt, payload: { ...device } },
        });
      }
    } catch (err) {
      note('info', 'device mark not stored', { userId, error: errText(err) });
    }
  }

  /**
   * Called after every successful sign-in. Emails the account when the browser
   * × OS pair is new for it; the first device ever seen is recorded silently.
   * Never throws (a failed notice must not fail a sign-in).
   */
  async function notifyIfNewDevice(input: {
    userId: string;
    email: string;
    brand: ProductBrand;
    userAgent: string | null;
    locale?: string | null;
  }): Promise<'known' | 'first' | 'new' | 'error'> {
    try {
      const device = parseDevice(input.userAgent);
      const tokenHash = hashToken(deviceMarkRaw(input.userId, device));
      const at = now();
      const live = await db().rAAuthToken.findMany({
        where: { userId: input.userId, kind: AUTH_TOKEN_KINDS.knownDevice, expiresAt: { gt: at } },
        select: { id: true, tokenHash: true },
      });
      const match = live.find((r) => r.tokenHash === tokenHash);
      if (match) {
        await db().rAAuthToken.update({ where: { id: match.id }, data: { expiresAt: new Date(at.getTime() + TOKEN_TTL_MS.known_device) } });
        return 'known';
      }
      await registerDevice(input.userId, input.userAgent);
      if (live.length === 0) return 'first';
      const profile = await profileOf(input.userId);
      await sendSafe({
        template: AUTH_EMAIL_KEYS.newDevice,
        to: input.email,
        userId: input.userId,
        locale: input.locale ?? profile?.locale ?? null,
        brand: input.brand,
        params: { browser: device.browser, os: device.os, at: at.toISOString().slice(0, 16).replace('T', ' ') },
      });
      return 'new';
    } catch (err) {
      note('info', 'new-device check skipped', { userId: input.userId, error: errText(err) });
      return 'error';
    }
  }

  // ── Signup side mails ──────────────────────────────────────────────────

  /** H34: the visitor sees "check your email"; the inbox learns where its account lives. */
  async function sendOtherBrandNotice(input: { email: string; visitingBrand: ProductBrand; accountBrand: BrandId; locale?: string | null }) {
    await sendSafe({
      template: AUTH_EMAIL_KEYS.otherBrand,
      to: input.email,
      locale: input.locale ?? null,
      brand: input.visitingBrand,
      params: { otherOrigin: emailOrigin(getBrand(input.accountBrand), env()) },
    });
  }

  async function sendAccountDeletedEmail(input: { userId: string; email: string; brand: ProductBrand }) {
    const profile = await profileOf(input.userId).catch(() => null);
    await sendSafe({
      template: AUTH_EMAIL_KEYS.accountDeleted,
      to: input.email,
      userId: input.userId,
      locale: profile?.locale ?? null,
      brand: input.brand,
      params: { days: retentionDaysFor(input.brand.id, env()) },
    });
  }

  // ── /auth/me additions ─────────────────────────────────────────────────

  async function meAdditions(userId: string, brand: ProductBrand): Promise<AuthMeAdditions> {
    const [user, profile] = await Promise.all([
      db().user.findUnique({ where: { id: userId }, select: { emailVerified: true } }),
      profileOf(userId),
    ]);
    const flags = await (deps.resolveFlags ?? ((u: string, b: ProductBrand) => resolveFlagsForUser(u, { brand: b, env: env() })))(userId, brand);
    const ctx = { campusCalendar: flags['jobs.campusCalendar'] === true, jobsFeed: flags['jobs.feed'] === true };
    let entitlements: EntitlementSummary | null = null;
    try {
      entitlements = await (deps.summarizeEntitlements ?? ((u: string, b: BrandId) => summarizeEntitlementsForMe(u, { brand: b })))(userId, brand.id);
    } catch (err) {
      note('info', 'entitlement summary unavailable for /auth/me', { userId, error: errText(err) });
    }
    let unreadCount: number | null = null;
    try {
      unreadCount = await db().seekerNotification.count({ where: { userId, readAt: null } });
    } catch (err) {
      note('info', 'unread count unavailable for /auth/me', { userId, error: errText(err) });
    }
    return {
      brand: { id: brand.id, name: brand.name, market: brand.market },
      onboarding: onboardingFor(brand, profile, ctx),
      entitlements,
      flags,
      unreadCount,
      emailVerified: user?.emailVerified ?? true,
    };
  }

  // ── Identities ─────────────────────────────────────────────────────────

  async function listIdentities(userId: string): Promise<IdentityView[]> {
    const user = await db().user.findUnique({
      where: { id: userId },
      select: { email: true, passwordHash: true, phoneE164: true, phoneVerifiedAt: true, createdAt: true },
    });
    if (!user) throw new HttpError('not_found');
    const rows = await db().rAAuthIdentity.findMany({
      where: { userId },
      select: { id: true, provider: true, email: true, subject: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const views: Array<Omit<IdentityView, 'removable'>> = [];
    if (user.passwordHash) {
      views.push({ id: 'email', provider: 'email', display: maskEmail(user.email), createdAt: user.createdAt.toISOString(), lastUsedAt: null });
    }
    if (user.phoneE164 && user.phoneVerifiedAt) {
      views.push({ id: 'phone', provider: 'phone', display: maskPhone(user.phoneE164), createdAt: user.phoneVerifiedAt.toISOString(), lastUsedAt: null });
    }
    for (const r of rows) {
      const provider = (['google', 'line', 'wechat'] as const).includes(r.provider as 'google') ? (r.provider as IdentityProvider) : null;
      if (!provider) continue;
      views.push({
        id: r.id,
        provider,
        display: r.email ? maskEmail(r.email) : provider,
        createdAt: r.createdAt.toISOString(),
        lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      });
    }
    const total = views.length;
    // Phone is the real-name identity on GoApply; it is changed in WP-11's flow, never unlinked here.
    return views.map((v) => ({ ...v, removable: total > 1 && v.provider !== 'phone' }));
  }

  async function unlinkIdentity(userId: string, identityId: string): Promise<IdentityView[]> {
    const views = await listIdentities(userId);
    const target = views.find((v) => v.id === identityId);
    if (!target) throw new HttpError('not_found');
    if (!target.removable) throw authErrors.lastIdentity();
    if (target.provider === 'email') {
      await db().user.update({ where: { id: userId }, data: { passwordHash: null } });
    } else {
      await db().rAAuthIdentity.deleteMany({ where: { id: identityId, userId } });
    }
    return listIdentities(userId);
  }

  // ── Consents ───────────────────────────────────────────────────────────

  async function listConsents(userId: string): Promise<ConsentView[]> {
    const profile = await profileOf(userId);
    if (!profile) return [];
    const rows = await db().seekerConsentRecord.findMany({
      where: { seekerProfileId: profile.id },
      select: { consentType: true, granted: true, proseVersion: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const latest = new Map<string, ConsentView>();
    for (const r of rows) {
      const type = isSeekerConsentType(r.consentType) ? canonicalConsentType(r.consentType) : r.consentType;
      latest.set(type, { type, granted: r.granted, proseVersion: r.proseVersion ?? null, at: r.createdAt.toISOString() });
    }
    return [...latest.values()].sort((a, b) => a.type.localeCompare(b.type));
  }

  async function recordConsent(
    userId: string,
    input: { type: string; granted: boolean; proseVersion: string },
    meta: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<ConsentView> {
    if (!isSeekerConsentType(input.type)) throw authErrors.unknownConsent(input.type);
    const type: SeekerConsentType = canonicalConsentType(input.type);
    if ((REQUIRED_SIGNUP_CONSENTS as readonly string[]).includes(type) && !input.granted) throw authErrors.consentLocked(type);
    const profile = await profileOf(userId);
    if (!profile) throw new HttpError('not_found', 'No seeker profile.');
    const row = await db().seekerConsentRecord.create({
      data: {
        seekerProfileId: profile.id,
        consentType: type,
        granted: input.granted,
        proseVersion: input.proseVersion,
        ipAddress: meta.ip ?? null,
        userAgent: meta.userAgent ? meta.userAgent.slice(0, 400) : null,
      },
      select: { consentType: true, granted: true, proseVersion: true, createdAt: true },
    });
    return { type: row.consentType, granted: row.granted, proseVersion: row.proseVersion ?? null, at: row.createdAt.toISOString() };
  }

  // ── Sessions ───────────────────────────────────────────────────────────

  async function listSessions(userId: string, currentToken: string | null): Promise<SessionView[]> {
    const rows = await db().session.findMany({
      where: { userId, expiresAt: { gt: now() } },
      select: { id: true, token: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      current: currentToken !== null && r.token === currentToken,
    }));
  }

  async function revokeSession(userId: string, sessionId: string): Promise<{ revoked: number }> {
    const res = await db().session.deleteMany({ where: { id: sessionId, userId } });
    if (res.count === 0) throw new HttpError('not_found');
    return { revoked: res.count };
  }

  return {
    listMethods,
    requestPasswordReset,
    resetPassword,
    emailStatus,
    sendVerificationEmail,
    verifyEmail,
    markEmailVerified,
    startOAuth,
    finishOAuthCallback,
    completeOAuth,
    oauthEmail,
    afterAccountCreated,
    registerDevice,
    notifyIfNewDevice,
    sendOtherBrandNotice,
    sendAccountDeletedEmail,
    meAdditions,
    signInRoute,
    firstOnboardingRoute,
    listIdentities,
    unlinkIdentity,
    listConsents,
    recordConsent,
    listSessions,
    revokeSession,
  };
}

export type AuthFeatureServiceImpl = ReturnType<typeof createAuthFeatureService>;

/**
 * `/auth/me.onboarding`: FND's `buildOnboardingMe`, except that a fresh
 * account at `account` points at the first onboarding screen (situation on
 * RoboApply, consent on GoApply), never back at /signup.
 */
export function onboardingFor(
  brand: ProductBrand,
  profile: { onboardingStep?: string | null; onboardingPath?: string | null } | null | undefined,
  ctx: { campusCalendar?: boolean; jobsFeed?: boolean } = {},
): OnboardingMe {
  const me = buildOnboardingMe(brand.id, profile, ctx);
  if (me.step === 'account') {
    return { ...me, nextRoute: routeForStage(brand.id, nextStage(brand.id, 'account', me.path), ctx) };
  }
  return me;
}

/** Every consent type the API accepts (re-exported for the client contract tests). */
export const ACCEPTED_CONSENT_TYPES: readonly string[] = SEEKER_CONSENT_TYPES;

/** The default instance (production dependencies). */
export const authService = createAuthFeatureService();
