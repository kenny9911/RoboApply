// @vitest-environment node
//
// WP-10 service acceptance on an in-memory Prisma (no network, no database):
// password reset (30 min, single use, revokes other sessions), email
// verification (non-blocking; grants the practice credit once), Google/LINE
// (find or create a seeker; link by verified email only within the brand;
// other-brand → 409; LINE without email verifies one first), /auth/me
// additions, identities, consents, sessions and the new-device email.
// INT-01: signup attribution (marketing fields only where linking is
// allowed; the invite attach and its risk signals), the invite check after
// email verification and after a provider is linked (soft), `/auth/me`
// unread count from the message centre, the region for the tips default,
// consents through the compliance ledger (prose hash), and `next` to a free
// tool page winning over onboarding.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const finish = vi.hoisted(() => vi.fn());

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./oauth/providers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./oauth/providers.js')>()),
  finishOAuth: finish,
}));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { getBrand } from '../../platform/brand/registry.js';
import { FLAG_KEYS } from '../../platform/flags.js';
import { createAuthFeatureService, onboardingFor, type AuthDb } from './service.js';
import { hashToken, purgeAuthTokens } from './tokens.js';
import { AuthError } from './errors.js';
import { CONSENT_PROSE_VERSION } from '../compliance/consents.js';
import { createDelegateSignalStore, createGrowthService, createReferralService, type ReferralDb } from '../growth/index.js';
import type { GrowthDb } from '../growth/service.js';
import type { ReferralSignalDelegate } from '../growth/referralSignalStore.js';
import { PRIORITY_NEXT_PATHS, isPriorityNext } from './contract.js';

const ROBO = getBrand('roboapply');
const GO = getBrand('goapply');
const ENV = { NODE_ENV: 'test', GOOGLE_OAUTH_CLIENT_ID: 'g', GOOGLE_OAUTH_CLIENT_SECRET: 'gs', LINE_LOGIN_CHANNEL_ID: 'l', LINE_LOGIN_CHANNEL_SECRET: 'ls' };
const T0 = new Date('2026-10-10T12:00:00.000Z');
const AGE = [{ type: 'age_16_plus', granted: true, proseVersion: 'v1' }];
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/129.0 Safari/537.36';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/131.0';

let clock: Date;
let db: ReturnType<typeof createFakePrisma>;
let sent: Array<{ template: string; to: string; params: Record<string, unknown>; brand: unknown }>;
let grants: string[][];
let sessions: number;
let referralChecks: string[];

function seedUser(over: Record<string, unknown> = {}) {
  const user = {
    id: 'u1',
    email: 'ana@example.test',
    brand: 'roboapply',
    role: 'seeker',
    isActive: true,
    emailVerified: false,
    emailIsPlaceholder: false,
    passwordHash: 'old-hash',
    phoneE164: null,
    phoneVerifiedAt: null,
    createdAt: T0,
    ...over,
  };
  db.$rows('user').push(user);
  db.$rows('seekerProfile').push({ id: `p-${user.id}`, userId: user.id, locale: 'en', deletedAt: null, onboardingStep: 'done', onboardingPath: null });
  return user;
}

function service(extra: Parameters<typeof createAuthFeatureService>[0] = {}) {
  return createAuthFeatureService({
    db: db as unknown as AuthDb,
    env: ENV,
    now: () => clock,
    sendEmail: async (input) => {
      sent.push({ template: String(input.template), to: input.to, params: input.params, brand: input.brand });
      return { status: 'sent' };
    },
    createSession: async (userId) => {
      sessions += 1;
      const token = `session-${sessions}`;
      db.$rows('session').push({ id: `s${sessions}`, userId, token, createdAt: clock, expiresAt: new Date(clock.getTime() + 864e5) });
      return { token, expiresAt: new Date(clock.getTime() + 864e5) };
    },
    hashPassword: async (pw) => `hashed:${pw}`,
    grantPracticeCredit: async (userId, reason, key) => {
      grants.push([userId, reason, key]);
      return { status: grants.length === 1 ? 'granted' : 'already_granted', ledgerId: 'l1', balanceAfter: 1 };
    },
    summarizeEntitlements: async () => ({ planKey: 'free' }) as never,
    resolveFlags: async () => Object.fromEntries([...FLAG_KEYS.map((k) => [k, false]), ['hiringContacts', 'off']]) as never,
    recordAttribution: vi.fn(async () => undefined),
    checkReferral: async (userId) => {
      referralChecks.push(userId);
    },
    unreadCount: async () => 0,
    rememberRegion: async () => undefined,
    ...extra,
  });
}

/** Raw token from the last email's `/…/<token>` path. */
function lastLinkToken(): string {
  const path = String(sent.at(-1)!.params.path);
  return path.split('/').pop()!;
}

async function authCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

beforeEach(() => {
  clock = new Date(T0);
  db = createFakePrisma({ uniqueFields: { rAAuthToken: ['tokenHash'], user: ['email'] } });
  sent = [];
  grants = [];
  sessions = 0;
  referralChecks = [];
  finish.mockReset();
});

describe('methods', () => {
  it('lists configured methods in brand order; LINE only (and first) for zh-TW or Taiwan', () => {
    const svc = service();
    expect(svc.listMethods({ brand: ROBO }).methods.map((m) => m.id)).toEqual(['email_password', 'google']);
    expect(svc.listMethods({ brand: ROBO, locale: 'en', country: 'US' }).methods.map((m) => m.id)).toEqual(['email_password', 'google']);
    const tw = svc.listMethods({ brand: ROBO, country: 'tw' });
    expect(tw.methods.map((m) => m.id)).toEqual(['line', 'email_password', 'google']);
    expect(tw.pdpaNoticeRequired).toBe(true);
    expect(tw.country).toBe('TW');
    expect(svc.listMethods({ brand: ROBO, locale: 'zh-TW', country: 'JP' }).methods.map((m) => m.id)).toEqual(['line', 'email_password', 'google']);
    const none = createAuthFeatureService({ db: db as unknown as AuthDb, env: {} }).listMethods({ brand: ROBO });
    expect(none.methods).toEqual([{ id: 'email_password', startUrl: null }]);
    expect(service().listMethods({ brand: GO }).methods.map((m) => m.id)).toEqual(['email_password']);
  });
});

describe('password reset', () => {
  it('emails only a same-brand account and never reveals which emails exist', async () => {
    seedUser();
    const svc = service();
    await svc.requestPasswordReset({ email: 'nobody@example.test', brand: ROBO });
    await svc.requestPasswordReset({ email: 'ana@example.test', brand: GO });
    expect(sent).toEqual([]);
    await svc.requestPasswordReset({ email: 'ANA@example.test', brand: ROBO });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ template: 'auth.password_reset', to: 'ana@example.test' });
    expect(String(sent[0]!.params.path)).toMatch(/^\/reset-password\/[\w-]{20,}$/);
    // Stored as a hash only.
    expect(db.$rows('rAAuthToken')[0]!.tokenHash).toBe(hashToken(lastLinkToken()));
  });

  it('is single-use, lasts 30 minutes and revokes every other session', async () => {
    seedUser();
    db.$rows('session').push({ id: 'old', userId: 'u1', token: 'stolen', createdAt: T0, expiresAt: new Date(T0.getTime() + 1e9) });
    const svc = service();
    await svc.requestPasswordReset({ email: 'ana@example.test', brand: ROBO });
    const token = lastLinkToken();

    expect(await authCode(svc.resetPassword({ token, password: 'short', brand: ROBO }))).toBe('weak_password');
    expect(await authCode(svc.resetPassword({ token, password: 'new-pass-123', brand: GO }))).toBe('token_invalid');

    const res = await svc.resetPassword({ token, password: 'new-pass-123', brand: ROBO });
    expect(res.userId).toBe('u1');
    expect(db.$rows('user')[0]!.passwordHash).toBe('hashed:new-pass-123');
    expect(db.$rows('session').map((s) => s.token)).toEqual([res.sessionToken]);
    // The link reached the inbox: the email is now verified (credit granted once).
    expect(db.$rows('user')[0]!.emailVerified).toBe(true);
    expect(grants).toEqual([['u1', 'email_verified', 'email_verified']]);

    expect(await authCode(svc.resetPassword({ token, password: 'new-pass-456', brand: ROBO }))).toBe('token_invalid');
  });

  it('expires after 30 minutes, and a new link voids the previous one', async () => {
    seedUser();
    const svc = service();
    await svc.requestPasswordReset({ email: 'ana@example.test', brand: ROBO });
    const first = lastLinkToken();
    await svc.requestPasswordReset({ email: 'ana@example.test', brand: ROBO });
    const second = lastLinkToken();
    expect(await authCode(svc.resetPassword({ token: first, password: 'new-pass-123', brand: ROBO }))).toBe('token_invalid');
    clock = new Date(T0.getTime() + 31 * 60_000);
    expect(await authCode(svc.resetPassword({ token: second, password: 'new-pass-123', brand: ROBO }))).toBe('token_expired');
  });
});

describe('email verification', () => {
  it('sends a link, verifies, and grants the free practice credit with one idempotency key', async () => {
    seedUser();
    const svc = service();
    expect(await svc.sendVerificationEmail({ userId: 'u1', brand: ROBO })).toEqual({ sent: true, alreadyVerified: false });
    expect(sent[0]!.template).toBe('auth.email_verify');
    const res = await svc.verifyEmail({ token: lastLinkToken(), brand: ROBO });
    expect(res).toMatchObject({ status: 'verified', next: '/settings#account' });
    expect(db.$rows('user')[0]).toMatchObject({ emailVerified: true, emailVerifiedAt: T0 });
    expect(grants).toEqual([['u1', 'email_verified', 'email_verified']]);
    expect(await svc.sendVerificationEmail({ userId: 'u1', brand: ROBO })).toEqual({ sent: false, alreadyVerified: true });
  });

  it('never emails a GoApply placeholder address', async () => {
    seedUser({ email: 'x@users.goapply.invalid', emailIsPlaceholder: true, brand: 'goapply' });
    expect(await service().sendVerificationEmail({ userId: 'u1', brand: GO })).toEqual({ sent: false, alreadyVerified: false });
    expect(sent).toEqual([]);
  });

  it('reports the status for Settings', async () => {
    seedUser();
    expect(await service().emailStatus('u1')).toEqual({ email: 'ana@example.test', verified: false, canResend: true });
  });
});

describe('Google / LINE sign-in', () => {
  const google = (over: Record<string, unknown> = {}) => ({
    provider: 'google',
    subject: 'g-1',
    email: 'new@example.test',
    emailVerified: true,
    name: 'New Person',
    avatarUrl: null,
    ...over,
  });

  async function startAndFinish(svc: ReturnType<typeof service>, signup: Parameters<ReturnType<typeof service>['startOAuth']>[0]['signup'], brand = ROBO, provider: 'google' | 'line' = 'google') {
    const { url, binder } = await svc.startOAuth({ provider, brand, redirectUri: 'http://localhost:3621/auth/callback/google', next: '/jobs/cm1', signup });
    const state = new URL(url).searchParams.get('state')!;
    return svc.finishOAuthCallback({ provider, brand, code: 'c', state, userAgent: MAC, binder });
  }

  it('creates a seeker from the signup page (agreements carried), stamps brand and the account stage', async () => {
    finish.mockResolvedValue(google());
    const svc = service();
    const res = await startAndFinish(svc, { consents: AGE, marketingOptIn: false, locale: 'ja', timezone: 'Asia/Tokyo', country: null, attribution: { from: 'job', jobId: 'cm1' } });
    expect(res).toMatchObject({ status: 'signed_in', isNewUser: true, next: '/onboarding/situation' });
    const user = db.$rows('user')[0]!;
    expect(user).toMatchObject({ email: 'new@example.test', brand: 'roboapply', role: 'seeker', roles: ['seeker'], market: 'jp', provider: 'google', emailVerified: true, passwordHash: null });
    expect(db.$rows('seekerProfile')[0]).toMatchObject({ onboardingStep: 'account', locale: 'ja', timezone: 'Asia/Tokyo', onboardingEntry: { from: 'job', jobId: 'cm1' } });
    expect(db.$rows('rAAuthIdentity')[0]).toMatchObject({ provider: 'google', subject: 'g-1', brand: 'roboapply', appId: '' });
    expect(db.$rows('seekerConsentRecord').map((c) => c.consentType).sort()).toEqual(['age_16_plus', 'marketing_email', 'seeker_app_optin']);
    expect(grants).toHaveLength(1);
    // The state token is single-use.
    expect(db.$rows('rAAuthToken').find((t) => t.kind === 'oauth_state')!.consumedAt).toEqual(T0);
  });

  it('asks a brand-new user from the login page for the agreements before creating anything', async () => {
    finish.mockResolvedValue(google());
    const svc = service();
    const res = await startAndFinish(svc, null);
    expect(res).toMatchObject({ status: 'consent_required', email: 'new@example.test' });
    expect(db.$rows('user')).toEqual([]);
    const pendingToken = (res as { pendingToken: string }).pendingToken;
    expect(await authCode(svc.completeOAuth({ pendingToken, brand: ROBO, consents: [], marketingOptIn: false }))).toBe('age_consent_required');
    const done = await svc.completeOAuth({ pendingToken, brand: ROBO, consents: AGE, marketingOptIn: true, locale: 'en' });
    expect(done).toMatchObject({ status: 'signed_in', isNewUser: true });
    expect(db.$rows('user')).toHaveLength(1);
  });

  it('links by verified email within the same brand and signs in (a verified account keeps its password)', async () => {
    seedUser({ email: 'new@example.test', emailVerified: true });
    db.$rows('session').push({ id: 'phone', userId: 'u1', token: 'my-phone', createdAt: T0, expiresAt: new Date(T0.getTime() + 1e9) });
    finish.mockResolvedValue(google());
    const res = await startAndFinish(service(), null);
    expect(res).toMatchObject({ status: 'signed_in', isNewUser: false, next: '/jobs/cm1' });
    expect(db.$rows('rAAuthIdentity')[0]).toMatchObject({ userId: 'u1' });
    expect(db.$rows('user')).toHaveLength(1);
    expect(db.$rows('user')[0]!.passwordHash).toBe('old-hash');
    expect(db.$rows('session').map((x) => x.token)).toContain('my-phone');
  });

  it('linking to an account whose email was never verified removes its password, sessions and open links (pre-account takeover)', async () => {
    // Someone signed up with the victim's address and a password of their choosing.
    seedUser({ email: 'new@example.test', emailVerified: false, passwordHash: 'squatter-hash' });
    db.$rows('session').push({ id: 'sq', userId: 'u1', token: 'squatter-session', createdAt: T0, expiresAt: new Date(T0.getTime() + 1e9) });
    const svc = service();
    await svc.requestPasswordReset({ email: 'new@example.test', brand: ROBO });
    const squatterReset = lastLinkToken();
    // The address owner signs in with Google.
    finish.mockResolvedValue(google());
    const res = await startAndFinish(svc, null);
    expect(res).toMatchObject({ status: 'signed_in', isNewUser: false });
    const user = db.$rows('user')[0]!;
    expect(user).toMatchObject({ passwordHash: null, emailVerified: true, emailVerifiedAt: T0 });
    expect(db.$rows('session').map((x) => x.token)).toEqual([(res as { signIn: { sessionToken: string } }).signIn.sessionToken]);
    expect(await authCode(svc.resetPassword({ token: squatterReset, password: 'new-pass-123', brand: ROBO }))).toBe('token_invalid');
    expect(db.$rows('rAAuthIdentity')).toEqual([expect.objectContaining({ userId: 'u1', provider: 'google' })]);
    expect(grants).toEqual([['u1', 'email_verified', 'email_verified']]);
  });

  it('never links or signs in an account without a seeker profile (admins excepted), like the password login', async () => {
    db.$rows('user').push({ id: 'r1', email: 'new@example.test', brand: 'roboapply', role: 'recruiter', isActive: true, emailVerified: true, passwordHash: 'h', createdAt: T0 });
    finish.mockResolvedValue(google());
    expect(await authCode(startAndFinish(service(), null))).toBe('not_a_seeker_account');
    expect(db.$rows('rAAuthIdentity')).toEqual([]);
    expect(sessions).toBe(0);

    // An identity already linked to a non-seeker row is refused too.
    db.$rows('rAAuthIdentity').push({ id: 'i9', userId: 'r1', brand: 'roboapply', provider: 'google', appId: '', subject: 'g-9', createdAt: T0 });
    finish.mockResolvedValue(google({ subject: 'g-9' }));
    expect(await authCode(startAndFinish(service(), null))).toBe('not_a_seeker_account');
    expect(sessions).toBe(0);

    db.$rows('user')[0]!.role = 'admin';
    expect((await startAndFinish(service(), null)).status).toBe('signed_in');
  });

  it('never links an unverified email, and answers 409 for an account of the other brand', async () => {
    seedUser({ email: 'new@example.test', brand: 'goapply' });
    finish.mockResolvedValue(google());
    const err = await startAndFinish(service(), { consents: AGE, marketingOptIn: false, locale: null, timezone: null, country: null }).catch((e) => e);
    expect(err).toMatchObject({ code: 'account_other_brand', status: 409, details: { otherBrandUrl: 'https://www.goapply.top/login' } });
    expect(db.$rows('rAAuthIdentity')).toEqual([]);

    finish.mockResolvedValue(google({ emailVerified: false, subject: 'g-2' }));
    const res = await startAndFinish(service(), null);
    expect(res.status).toBe('email_required');
  });

  it('signs in through an existing link even if the email changed', async () => {
    seedUser();
    db.$rows('rAAuthIdentity').push({ id: 'i1', userId: 'u1', brand: 'roboapply', provider: 'google', appId: '', subject: 'g-1', createdAt: T0 });
    finish.mockResolvedValue(google({ email: 'changed@example.test' }));
    const res = await startAndFinish(service(), null);
    expect(res).toMatchObject({ status: 'signed_in', isNewUser: false });
    expect(db.$rows('rAAuthIdentity')[0]!.lastUsedAt).toEqual(T0);
  });

  it('refuses a deleted or suspended account', async () => {
    seedUser({ email: 'new@example.test', isActive: false });
    finish.mockResolvedValue(google());
    expect(await authCode(startAndFinish(service(), null))).toBe('account_disabled');
  });

  it('rejects a reused or foreign state', async () => {
    finish.mockResolvedValue(google());
    const svc = service();
    const { url, binder } = await svc.startOAuth({ provider: 'google', brand: ROBO, redirectUri: 'http://x/cb', signup: null });
    const state = new URL(url).searchParams.get('state')!;
    expect(await authCode(svc.finishOAuthCallback({ provider: 'line', brand: ROBO, code: 'c', state, binder }))).toBe('oauth_state_invalid');
    expect(await authCode(svc.finishOAuthCallback({ provider: 'google', brand: ROBO, code: 'c', state, binder }))).toBe('oauth_state_invalid');
    expect(await authCode(svc.finishOAuthCallback({ provider: 'google', brand: ROBO, error: 'access_denied' }))).toBe('oauth_failed');
  });

  it('binds the state to the browser that started it (login CSRF)', async () => {
    finish.mockResolvedValue(google());
    const svc = service();
    const attacker = await svc.startOAuth({ provider: 'google', brand: ROBO, redirectUri: 'http://x/cb', signup: { consents: AGE, marketingOptIn: false, locale: null, timezone: null, country: null } });
    const state = new URL(attacker.url).searchParams.get('state')!;
    // Only the hash of the binder is stored.
    const row = db.$rows('rAAuthToken').find((t) => t.kind === 'oauth_state')!;
    expect(JSON.stringify(row.payload)).not.toContain(attacker.binder);
    // The victim's browser has no binder cookie, or a different one.
    expect(await authCode(svc.finishOAuthCallback({ provider: 'google', brand: ROBO, code: 'c', state }))).toBe('oauth_state_invalid');
    const second = await svc.startOAuth({ provider: 'google', brand: ROBO, redirectUri: 'http://x/cb', signup: null });
    const state2 = new URL(second.url).searchParams.get('state')!;
    expect(await authCode(svc.finishOAuthCallback({ provider: 'google', brand: ROBO, code: 'c', state: state2, binder: attacker.binder }))).toBe('oauth_state_invalid');
    expect(finish).not.toHaveBeenCalled();
    expect(sessions).toBe(0);
  });

  it('LINE without an email: verify an email first; the account exists only after the link', async () => {
    finish.mockResolvedValue({ provider: 'line', subject: 'U9', email: null, emailVerified: false, name: '林', avatarUrl: null });
    const svc = service();
    const res = await startAndFinish(svc, null, ROBO, 'line');
    expect(res).toMatchObject({ status: 'email_required', name: '林' });
    const pendingToken = (res as { pendingToken: string }).pendingToken;
    const pdpa = [...AGE, { type: 'tw_pdpa_notice', granted: true, proseVersion: 'v1' }];
    expect(await authCode(svc.oauthEmail({ pendingToken, email: 'lin@example.test', brand: ROBO, consents: AGE, marketingOptIn: false, locale: 'zh-TW' }))).toBe(
      'pdpa_consent_required',
    );
    expect(await svc.oauthEmail({ pendingToken, email: 'Lin@example.test', brand: ROBO, consents: pdpa, marketingOptIn: false, locale: 'zh-TW' })).toEqual({
      status: 'check_email',
    });
    expect(db.$rows('user')).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ template: 'auth.oauth_email_verify', to: 'lin@example.test' });
    const verified = await svc.verifyEmail({ token: lastLinkToken(), brand: ROBO, userAgent: MAC });
    expect(verified).toMatchObject({ status: 'signed_in', isNewUser: true, next: '/onboarding/situation' });
    expect(db.$rows('user')[0]).toMatchObject({ email: 'lin@example.test', market: 'tw', provider: 'line', emailVerified: true });
    expect(db.$rows('rAAuthIdentity')[0]).toMatchObject({ provider: 'line', subject: 'U9', email: 'lin@example.test' });
  });

  it('a pending LINE link for an address that already has an account never attaches LINE to it', async () => {
    seedUser({ email: 'victim@example.test', emailVerified: true });
    finish.mockResolvedValue({ provider: 'line', subject: 'U-attacker', email: null, emailVerified: false, name: 'x', avatarUrl: null });
    const svc = service();
    const res = await startAndFinish(svc, null, ROBO, 'line');
    const pendingToken = (res as { pendingToken: string }).pendingToken;
    await svc.oauthEmail({ pendingToken, email: 'victim@example.test', brand: ROBO, consents: AGE, marketingOptIn: false, locale: 'en' });
    // The victim clicks the link in their inbox.
    const token = lastLinkToken();
    expect(await svc.verifyEmail({ token, brand: ROBO, userAgent: MAC })).toEqual({ status: 'account_exists', next: '/login' });
    expect(db.$rows('rAAuthIdentity')).toEqual([]);
    expect(sessions).toBe(0);
    expect(db.$rows('user')).toHaveLength(1);
    // The link is burned.
    expect(await authCode(svc.verifyEmail({ token, brand: ROBO }))).toBe('token_invalid');
  });

  it('a Google user without a verified email can verify one even when LINE is off; an unconfigured provider is refused', async () => {
    finish.mockResolvedValue(google({ emailVerified: false, subject: 'g-u' }));
    const googleOnly = { GOOGLE_OAUTH_CLIENT_ID: 'g', GOOGLE_OAUTH_CLIENT_SECRET: 'gs' };
    const svc = service({ env: googleOnly });
    const res = await startAndFinish(svc, null);
    expect(res.status).toBe('email_required');
    expect(
      await svc.oauthEmail({ pendingToken: (res as { pendingToken: string }).pendingToken, email: 'g@example.test', brand: ROBO, consents: AGE, marketingOptIn: false, locale: 'en' }),
    ).toEqual({ status: 'check_email' });

    const later = await startAndFinish(svc, null);
    const off = service({ env: {} });
    expect(
      await authCode(off.oauthEmail({ pendingToken: (later as { pendingToken: string }).pendingToken, email: 'g@example.test', brand: ROBO, consents: AGE, marketingOptIn: false })),
    ).toBe('feature_disabled');
  });
});

describe('token retention', () => {
  it('deletes used and expired tokens (also those without a user) and keeps live ones', async () => {
    seedUser();
    const svc = service();
    await svc.requestPasswordReset({ email: 'ana@example.test', brand: ROBO }); // live
    await svc.startOAuth({ provider: 'google', brand: ROBO, redirectUri: 'http://x/cb', signup: null }); // live, no user
    db.$rows('rAAuthToken').push(
      { id: 'used', kind: 'email_verify', brand: 'roboapply', userId: 'u1', tokenHash: 'a', consumedAt: T0, expiresAt: new Date(T0.getTime() + 1e6) },
      { id: 'old-state', kind: 'oauth_state', brand: 'roboapply', userId: null, tokenHash: 'b', consumedAt: null, expiresAt: new Date(T0.getTime() - 1) },
      { id: 'old-device', kind: 'known_device', brand: 'roboapply', userId: 'u1', tokenHash: 'c', consumedAt: null, expiresAt: new Date(T0.getTime() - 1) },
    );
    expect(await purgeAuthTokens(db as never, T0)).toBe(3);
    expect(db.$rows('rAAuthToken').map((t) => t.kind).sort()).toEqual(['oauth_state', 'password_reset']);
  });

  it('a known-device mark lives 90 days after the last sign-in from that device', async () => {
    seedUser();
    await service().notifyIfNewDevice({ userId: 'u1', email: 'ana@example.test', brand: ROBO, userAgent: MAC });
    const mark = db.$rows('rAAuthToken').find((t) => t.kind === 'known_device')!;
    expect((mark.expiresAt as Date).getTime() - T0.getTime()).toBe(90 * 864e5);
  });
});

describe('/auth/me additions', () => {
  it('points a fresh account at the first onboarding screen, per brand', () => {
    expect(onboardingFor(ROBO, { onboardingStep: 'account' })).toMatchObject({ step: 'account', completed: false, nextRoute: '/onboarding/situation' });
    expect(onboardingFor(GO, { onboardingStep: 'account' })).toMatchObject({ nextRoute: '/onboarding/consent' });
    expect(onboardingFor(ROBO, { onboardingStep: 'basics', onboardingPath: 'explore' })).toMatchObject({ nextRoute: '/onboarding/basics', path: 'explore' });
    expect(onboardingFor(ROBO, null)).toMatchObject({ step: 'done', completed: true, nextRoute: null });
  });

  it('returns brand, onboarding, entitlements, flags, unread count and email status', async () => {
    seedUser();
    db.$rows('seekerProfile')[0]!.onboardingStep = 'account';
    const asked: Array<[string, string]> = [];
    const me = await service({
      unreadCount: async (userId, brand) => {
        asked.push([userId, brand.id]);
        return 1;
      },
    }).meAdditions('u1', ROBO);
    // The count comes from the message centre, for this brand.
    expect(asked).toEqual([['u1', 'roboapply']]);
    expect(me).toMatchObject({
      brand: { id: 'roboapply', name: 'RoboApply', market: 'intl' },
      onboarding: { step: 'account', nextRoute: '/onboarding/situation' },
      entitlements: { planKey: 'free' },
      unreadCount: 1,
      emailVerified: false,
    });
    expect(me.flags.hiringContacts).toBe('off');
  });

  it('never invents numbers when a source fails', async () => {
    seedUser();
    const me = await service({
      unreadCount: async () => Promise.reject(new Error('no table')),
      summarizeEntitlements: async () => Promise.reject(new Error('down')),
    }).meAdditions('u1', ROBO);
    expect(me.unreadCount).toBeNull();
    expect(me.entitlements).toBeNull();
  });

  it('offers the edge country to the message centre once per user (signup, login and /auth/me share it); never throws', async () => {
    seedUser({ id: 'region-1' });
    seedUser({ id: 'region-2', email: 'b@example.test' });
    const stored: Array<[string, string | null]> = [];
    const svc = service({
      rememberRegion: async (userId, country) => {
        stored.push([userId, country]);
        if (userId === 'region-2') throw new Error('db down');
      },
    });
    await svc.meAdditions('region-1', ROBO, { country: 'tw' });
    await svc.meAdditions('region-1', ROBO, { country: 'TW' });
    await svc.rememberRegion('region-1', 'TW');
    expect(stored).toEqual([['region-1', 'TW']]);
    // No country, or junk: nothing is stored.
    await svc.rememberRegion('region-3', null);
    await svc.rememberRegion('region-3', 'Taiwan');
    expect(stored).toHaveLength(1);
    // A failure is swallowed and tried again next time.
    await expect(svc.rememberRegion('region-2', 'JP')).resolves.toBeUndefined();
    await svc.rememberRegion('region-2', 'JP');
    expect(stored.filter(([u]) => u === 'region-2')).toHaveLength(2);
  });
});

describe('identities, consents, sessions', () => {
  it('lists sign-in methods with masked values and refuses to remove the last one', async () => {
    seedUser({ passwordHash: null });
    db.$rows('rAAuthIdentity').push({ id: 'i1', userId: 'u1', brand: 'roboapply', provider: 'google', email: 'ana@example.test', subject: 'g', createdAt: T0, lastUsedAt: null });
    const svc = service();
    expect(await svc.listIdentities('u1')).toEqual([
      { id: 'i1', provider: 'google', display: 'a•••@example.test', createdAt: T0.toISOString(), lastUsedAt: null, removable: false },
    ]);
    expect(await authCode(svc.unlinkIdentity('u1', 'i1'))).toBe('last_identity');
    db.$rows('user')[0]!.passwordHash = 'h';
    const after = await svc.unlinkIdentity('u1', 'i1');
    expect(after.map((i) => i.provider)).toEqual(['email']);
    expect(await authCode(svc.unlinkIdentity('u1', 'nope'))).toBe('not_found');
  });

  it('records consents through the compliance ledger: prose hash stored, unknown and locked refused, outdated text → 409', async () => {
    seedUser();
    const svc = service();
    const V = CONSENT_PROSE_VERSION;
    // Not offered on this brand (GoApply's cross-border consent) or made up.
    await expect(svc.recordConsent('u1', ROBO, { type: 'made_up', granted: true, proseVersion: V })).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'consent_unknown' },
    });
    await expect(svc.recordConsent('u1', ROBO, { type: 'pipl_cross_border', granted: true, proseVersion: V })).rejects.toMatchObject({
      details: { reason: 'consent_unknown' },
    });
    // The age confirmation ends only with the account.
    await expect(svc.recordConsent('u1', ROBO, { type: 'age_16_plus', granted: false, proseVersion: V })).rejects.toMatchObject({
      details: { reason: 'consent_not_withdrawable' },
    });
    // The text changed since the client loaded it.
    await expect(svc.recordConsent('u1', ROBO, { type: 'marketing_email', granted: true, proseVersion: 'old' })).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect(db.$rows('seekerConsentRecord')).toEqual([]);

    const on = await svc.recordConsent('u1', ROBO, { type: 'marketing_email', granted: true, proseVersion: V }, { locale: 'en', country: 'US' });
    expect(on).toMatchObject({ type: 'marketing_email', granted: true, proseVersion: V, accountClosing: false });
    expect(on.proseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.$rows('seekerConsentRecord')[0]).toMatchObject({ consentType: 'marketing_email', granted: true, proseVersion: V, proseHash: on.proseHash });

    // The in-memory database has no column defaults: stamp the rows as the database would.
    db.$rows('seekerConsentRecord')[0]!.createdAt = T0;
    await svc.recordConsent('u1', ROBO, { type: 'marketing_email', granted: false, proseVersion: V });
    db.$rows('seekerConsentRecord')[1]!.createdAt = new Date(T0.getTime() + 1000);
    const list = await svc.listConsents('u1', ROBO);
    // Newest answer wins; the version is the record's own.
    expect(list).toEqual([expect.objectContaining({ type: 'marketing_email', granted: false, proseVersion: V })]);
    // Consents the catalog does not offer (the implicit signup row) are not listed.
    db.$rows('seekerConsentRecord').push({ id: 'x', seekerProfileId: 'p-u1', consentType: 'seeker_app_optin', granted: true, proseVersion: 'v1', createdAt: T0 });
    expect((await svc.listConsents('u1', ROBO)).map((c) => c.type)).toEqual(['marketing_email']);
    // No seeker profile: nothing to list.
    expect(await svc.listConsents('nobody', ROBO)).toEqual([]);
  });

  it('lists live sessions with the current one marked and revokes another', async () => {
    seedUser();
    db.$rows('session').push(
      { id: 's-a', userId: 'u1', token: 'tok-a', createdAt: T0, expiresAt: new Date(T0.getTime() + 1e6) },
      { id: 's-b', userId: 'u1', token: 'tok-b', createdAt: new Date(T0.getTime() + 1), expiresAt: new Date(T0.getTime() + 1e6) },
      { id: 's-old', userId: 'u1', token: 'tok-old', createdAt: T0, expiresAt: new Date(T0.getTime() - 1) },
    );
    const svc = service();
    const list = await svc.listSessions('u1', 'tok-a');
    expect(list.map((s) => [s.id, s.current])).toEqual([
      ['s-b', false],
      ['s-a', true],
    ]);
    expect(await svc.revokeSession('u1', 's-b')).toEqual({ revoked: 1 });
    expect(await authCode(svc.revokeSession('u1', 's-b'))).toBe('not_found');
  });
});

describe('new-device sign-in email (F-TRUST-01)', () => {
  it('records the first device silently, stays quiet on a known one, emails on a new one', async () => {
    seedUser();
    const svc = service();
    const input = { userId: 'u1', email: 'ana@example.test', brand: ROBO };
    expect(await svc.notifyIfNewDevice({ ...input, userAgent: MAC })).toBe('first');
    expect(await svc.notifyIfNewDevice({ ...input, userAgent: MAC.replace('129.0', '130.0') })).toBe('known');
    expect(sent).toEqual([]);
    expect(await svc.notifyIfNewDevice({ ...input, userAgent: WIN })).toBe('new');
    expect(sent).toEqual([expect.objectContaining({ template: 'auth.new_device', to: 'ana@example.test', params: { browser: 'Firefox', os: 'Windows', at: '2026-10-10 12:00' } })]);
  });

  it('never throws', async () => {
    const broken = createFakePrisma({ failOn: { 'rAAuthToken.findMany': new Error('down') } });
    expect(await service({ db: broken as unknown as AuthDb }).notifyIfNewDevice({ userId: 'u1', email: 'a@b.c', brand: ROBO, userAgent: MAC })).toBe('error');
  });
});

describe('side mails', () => {
  it('cross-brand notice is sent by the visited brand and links to the account brand', async () => {
    await service().sendOtherBrandNotice({ email: 'ana@example.test', visitingBrand: GO, accountBrand: 'roboapply' });
    expect(sent[0]).toMatchObject({ template: 'auth.other_brand_notice', to: 'ana@example.test', brand: GO, params: { otherOrigin: 'https://www.roboapply.io' } });
  });

  it('deletion email states the purge window (GoApply ≤ 15 days)', async () => {
    seedUser();
    await service().sendAccountDeletedEmail({ userId: 'u1', email: 'ana@example.test', brand: ROBO });
    await service().sendAccountDeletedEmail({ userId: 'u1', email: 'ana@example.test', brand: GO });
    expect(sent.map((s) => s.params.days)).toEqual([30, 15]);
  });
});

it('AuthError carries code and status', () => {
  const e = new AuthError('weak_password', 422, 'x');
  expect([e.code, e.status]).toEqual(['weak_password', 422]);
});

// ── INT-01 ───────────────────────────────────────────────────────────────

describe('signup attribution and the invite attach (WP-23 recipe, WP-60 signals)', () => {
  const FRIEND = { userAgent: MAC, ip: '203.0.113.50', deviceId: 'anon_friend001' };

  /** The real growth and invite services on the same in-memory database. */
  function growthOnFake() {
    const referrals = createReferralService({
      db: db as unknown as ReferralDb,
      signalStore: createDelegateSignalStore(db.rAReferralSignal as unknown as ReferralSignalDelegate),
      grantPracticeCredit: async () => ({ status: 'granted', ledgerId: 'l', balanceAfter: 1 }),
      enqueue: async () => ({ id: 'w1' }),
      sendEmail: async () => ({ status: 'sent' }),
      invitesEnabled: async () => true,
      env: { NODE_ENV: 'test', REFERRAL_SIGNAL_SECRET: 'test-secret' },
      now: () => clock,
    });
    const growth = createGrowthService({ db: db as unknown as GrowthDb, attachReferral: referrals.attachFromSignup, now: () => clock });
    return { referrals, growth };
  }

  function seedInviter() {
    seedUser({ id: 'inviter', email: 'inviter@example.test', emailVerified: true, createdAt: new Date(T0.getTime() - 48 * 3600e3) });
    db.$rows('rAReferralCode').push({ id: 'c1', userId: 'inviter', brand: 'roboapply', code: 'ABCDEFGH', createdAt: new Date(T0.getTime() - 48 * 3600e3) });
  }

  it('stores utm and entry fields when linking is allowed, and only the functional fields when it is not', async () => {
    const { growth } = growthOnFake();
    const svc = service({ recordAttribution: growth.recordAttribution });
    const attribution = { from: 'job', jobId: 'cm1', ref: 'newsletter', utmSource: 'x', utmCampaign: 'spring', landingPath: '/signup' };

    seedUser({ id: 'allowed', email: 'allowed@example.test' });
    await svc.afterAccountCreated('allowed', { attribution }, { ...FRIEND, anonId: 'anon_friend001', linkAllowed: true });
    const allowed = db.$rows('rAAttribution').find((r) => r.userId === 'allowed')!;
    expect(allowed.firstTouch).toMatchObject({ from: 'job', jobId: 'cm1', ref: 'newsletter', utmSource: 'x', utmCampaign: 'spring', landingPath: '/signup' });
    expect(allowed.anonId).toBe('anon_friend001');

    seedUser({ id: 'denied', email: 'denied@example.test' });
    // No consent (EEA/UK/CH): the route passes no anonId and linkAllowed false.
    await svc.afterAccountCreated('denied', { attribution }, { ...FRIEND, anonId: null, linkAllowed: false });
    const denied = db.$rows('rAAttribution').find((r) => r.userId === 'denied')!;
    expect(Object.keys(denied.firstTouch as object).sort()).toEqual(['at', 'jobId', 'ref']);
    expect(denied.anonId ?? null).toBeNull();

    // Marketing fields alone leave nothing to store without linking.
    seedUser({ id: 'utm-only', email: 'utm@example.test' });
    await svc.afterAccountCreated('utm-only', { attribution: { utmSource: 'x', from: 'ad' } }, { ...FRIEND, linkAllowed: false });
    expect(db.$rows('rAAttribution').some((r) => r.userId === 'utm-only')).toBe(false);
  });

  it("reads the client's first and last touch; the signup link is the fallback", async () => {
    const { growth } = growthOnFake();
    const svc = service({ recordAttribution: growth.recordAttribution });
    seedUser({ id: 'u-touch', email: 'touch@example.test' });
    const earlier = new Date(T0.getTime() - 3 * 864e5).toISOString();
    await svc.afterAccountCreated(
      'u-touch',
      { attribution: { from: 'job', jobId: 'cm9' } },
      {
        ...FRIEND,
        anonId: 'anon_friend001',
        linkAllowed: true,
        clientTouches: { firstTouch: { utmSource: 'google', landingPath: '/', at: earlier }, lastTouch: { from: 'alert', alert: 'a1', at: T0.toISOString() } },
      },
    );
    const row = db.$rows('rAAttribution').find((r) => r.userId === 'u-touch')!;
    expect(row.firstTouch).toMatchObject({ utmSource: 'google', landingPath: '/', at: earlier });
    expect(row.lastTouch).toMatchObject({ from: 'alert', alert: 'a1' });

    // Only a first touch from the client: the signup link becomes the last touch.
    seedUser({ id: 'u-touch2', email: 'touch2@example.test' });
    await svc.afterAccountCreated(
      'u-touch2',
      { attribution: { from: 'job', jobId: 'cm9' } },
      { ...FRIEND, linkAllowed: true, clientTouches: { firstTouch: { utmSource: 'google', at: earlier }, lastTouch: null } },
    );
    const row2 = db.$rows('rAAttribution').find((r) => r.userId === 'u-touch2')!;
    expect(row2.firstTouch).toMatchObject({ utmSource: 'google' });
    expect(row2.lastTouch).toMatchObject({ from: 'job', jobId: 'cm9' });
  });

  it('a signup with an invite code creates the invite and records hashed risk signals for the friend', async () => {
    const { growth } = growthOnFake();
    seedInviter();
    seedUser({ id: 'friend', email: 'friend@example.test' });
    const svc = service({ recordAttribution: growth.recordAttribution });
    // No analytics consent: the referral is functional and still attached.
    await svc.afterAccountCreated('friend', { attribution: { ref: 'abcd-efgh', from: 'invite' } }, { ...FRIEND, linkAllowed: false });
    expect(db.$rows('rAReferral')).toEqual([expect.objectContaining({ inviterUserId: 'inviter', inviteeUserId: 'friend', brand: 'roboapply', status: 'pending' })]);
    const signal = db.$rows('rAReferralSignal').find((r) => r.userId === 'friend')!;
    expect(signal).toMatchObject({ brand: 'roboapply' });
    expect(String(signal.ipHash)).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(signal)).not.toContain('203.0.113.50');
    expect(JSON.stringify(signal)).not.toContain('anon_friend001');
  });

  it('attaches an invite code that is only in the later touch (the friend first arrived another way)', async () => {
    const { growth, referrals } = growthOnFake();
    seedInviter();
    seedUser({ id: 'friend', email: 'friend@example.test' });
    const svc = service({ recordAttribution: growth.recordAttribution, attachReferral: referrals.attachFromSignup });
    await svc.afterAccountCreated(
      'friend',
      { attribution: { ref: 'ABCDEFGH', from: 'invite' } },
      { ...FRIEND, linkAllowed: true, clientTouches: { firstTouch: { utmSource: 'google', at: T0.toISOString() }, lastTouch: null } },
    );
    expect(db.$rows('rAReferral')).toEqual([expect.objectContaining({ inviterUserId: 'inviter', inviteeUserId: 'friend' })]);
    // The first touch stays what it was.
    expect((db.$rows('rAAttribution')[0]!.firstTouch as Record<string, unknown>).ref).toBeUndefined();
  });

  // The provider callback is a GET with no body: the touches the browser
  // stored ride the start request and the state row.
  describe('Google / LINE sign-up keeps the stored first and last touch', () => {
    const earlier = new Date(T0.getTime() - 3 * 864e5).toISOString();
    const STORED = {
      firstTouch: { ref: 'abcd-efgh', utmSource: 'newsletter', landingPath: '/r/ABCDEFGH', at: earlier },
      lastTouch: { from: 'job', jobId: 'cm7', at: T0.toISOString() },
    };
    const identity = (over: Record<string, unknown> = {}) => ({ provider: 'google', subject: 'g-friend', email: 'friend@example.test', emailVerified: true, name: 'Friend', avatarUrl: null, ...over });
    const signupPage = { consents: AGE, marketingOptIn: false, locale: 'en', timezone: null, country: null };

    function wired() {
      const { growth, referrals } = growthOnFake();
      seedInviter();
      return service({ recordAttribution: growth.recordAttribution, attachReferral: referrals.attachFromSignup });
    }
    async function start(svc: ReturnType<typeof service>, provider: 'google' | 'line', signup: typeof signupPage | null, touches: unknown) {
      const { url, binder } = await svc.startOAuth({ provider, brand: ROBO, redirectUri: `http://localhost:3621/auth/callback/${provider}`, next: null, signup, touches });
      return { state: new URL(url).searchParams.get('state')!, binder };
    }

    it('signup page → Google: an invite code held only in the stored touch creates the invite; the earlier campaign is the first touch', async () => {
      finish.mockResolvedValue(identity());
      const svc = wired();
      const { state, binder } = await start(svc, 'google', signupPage, STORED);
      // What the state row keeps is the sanitized touches (the landing path of an invite link is scrubbed).
      const stored = db.$rows('rAAuthToken').find((t) => t.kind === 'oauth_state')!.payload as { touches: { firstTouch: Record<string, unknown>; lastTouch: Record<string, unknown> } };
      expect(stored.touches.firstTouch).toMatchObject({ ref: 'abcd-efgh', utmSource: 'newsletter', at: earlier });
      expect(JSON.stringify(stored.touches)).not.toContain('/r/ABCDEFGH');

      const res = await svc.finishOAuthCallback({ provider: 'google', brand: ROBO, code: 'c', state, binder, request: { ...FRIEND, anonId: 'anon_friend001', linkAllowed: true } });
      expect(res).toMatchObject({ status: 'signed_in', isNewUser: true });
      const friend = db.$rows('user').find((u) => u.email === 'friend@example.test')!;
      const row = db.$rows('rAAttribution').find((r) => r.userId === friend.id)!;
      expect(row.firstTouch).toMatchObject({ ref: 'abcd-efgh', utmSource: 'newsletter', at: earlier });
      expect(row.lastTouch).toMatchObject({ from: 'job', jobId: 'cm7' });
      expect(db.$rows('rAReferral')).toEqual([expect.objectContaining({ inviterUserId: 'inviter', inviteeUserId: friend.id, status: 'pending' })]);
      expect(db.$rows('rAReferralSignal').some((r) => r.userId === friend.id)).toBe(true);
    });

    it('without analytics consent only the functional fields of the carried touch are stored (the invite still counts)', async () => {
      finish.mockResolvedValue(identity());
      const svc = wired();
      const { state, binder } = await start(svc, 'google', signupPage, STORED);
      await svc.finishOAuthCallback({ provider: 'google', brand: ROBO, code: 'c', state, binder, request: { ...FRIEND, anonId: null, linkAllowed: false } });
      const friend = db.$rows('user').find((u) => u.email === 'friend@example.test')!;
      const row = db.$rows('rAAttribution').find((r) => r.userId === friend.id)!;
      expect(Object.keys(row.firstTouch as object).sort()).toEqual(['at', 'ref']);
      expect(db.$rows('rAReferral')).toHaveLength(1);
    });

    it('login page → Google → agreements: the touches wait in the pending token and are recorded when the account is created', async () => {
      finish.mockResolvedValue(identity());
      const svc = wired();
      const { state, binder } = await start(svc, 'google', null, STORED);
      const res = await svc.finishOAuthCallback({ provider: 'google', brand: ROBO, code: 'c', state, binder, request: { ...FRIEND, linkAllowed: true } });
      expect(res).toMatchObject({ status: 'consent_required' });
      expect(db.$rows('rAAttribution')).toEqual([]);
      const done = await svc.completeOAuth({
        pendingToken: (res as { pendingToken: string }).pendingToken,
        brand: ROBO,
        consents: AGE,
        marketingOptIn: false,
        locale: 'en',
        request: { ...FRIEND, linkAllowed: true },
      });
      expect(done).toMatchObject({ status: 'signed_in', isNewUser: true });
      const friend = db.$rows('user').find((u) => u.email === 'friend@example.test')!;
      expect(db.$rows('rAAttribution').find((r) => r.userId === friend.id)!.firstTouch).toMatchObject({ ref: 'abcd-efgh', utmSource: 'newsletter' });
      expect(db.$rows('rAReferral')).toEqual([expect.objectContaining({ inviterUserId: 'inviter', inviteeUserId: friend.id })]);
    });

    it('LINE without an email: the touches follow the verification link, even when it is opened elsewhere', async () => {
      finish.mockResolvedValue(identity({ provider: 'line', subject: 'line-friend', email: null, emailVerified: false }));
      const svc = wired();
      const { state, binder } = await start(svc, 'line', signupPage, STORED);
      const res = await svc.finishOAuthCallback({ provider: 'line', brand: ROBO, code: 'c', state, binder, request: { ...FRIEND, linkAllowed: true } });
      expect(res).toMatchObject({ status: 'email_required' });
      await svc.oauthEmail({ pendingToken: (res as { pendingToken: string }).pendingToken, email: 'friend@example.test', brand: ROBO, consents: AGE, marketingOptIn: false, locale: 'en' });
      const verified = await svc.verifyEmail({ token: lastLinkToken(), brand: ROBO, request: { userAgent: 'Another device', linkAllowed: true } });
      expect(verified).toMatchObject({ status: 'signed_in', isNewUser: true });
      const friend = db.$rows('user').find((u) => u.email === 'friend@example.test')!;
      expect(db.$rows('rAAttribution').find((r) => r.userId === friend.id)!.firstTouch).toMatchObject({ ref: 'abcd-efgh' });
      expect(db.$rows('rAReferral')).toEqual([expect.objectContaining({ inviterUserId: 'inviter', inviteeUserId: friend.id })]);
    });

    it('junk in place of touches is dropped and the sign-up goes on; an existing account records nothing', async () => {
      finish.mockResolvedValue(identity());
      const svc = wired();
      const junk = await start(svc, 'google', signupPage, { firstTouch: 'x'.repeat(50), lastTouch: [1, 2], extra: { nested: true } });
      expect((db.$rows('rAAuthToken').find((t) => t.kind === 'oauth_state')!.payload as { touches: unknown }).touches).toBeNull();
      await expect(svc.finishOAuthCallback({ provider: 'google', brand: ROBO, code: 'c', state: junk.state, binder: junk.binder, request: { ...FRIEND, linkAllowed: true } })).resolves.toMatchObject({ isNewUser: true });
      expect(db.$rows('rAAttribution')).toEqual([]);

      // The same person signs in again from a link with a ref: nothing is recorded for an existing account.
      const again = await start(svc, 'google', null, STORED);
      await expect(svc.finishOAuthCallback({ provider: 'google', brand: ROBO, code: 'c', state: again.state, binder: again.binder, request: { ...FRIEND, linkAllowed: true } })).resolves.toMatchObject({ isNewUser: false });
      expect(db.$rows('rAAttribution')).toEqual([]);
      expect(db.$rows('rAReferral')).toEqual([]);
    });
  });

  it('never throws: a failing growth seam does not fail the signup, and the device is still recorded', async () => {
    seedUser();
    const svc = service({
      recordAttribution: async () => Promise.reject(new Error('growth down')),
      attachReferral: async () => Promise.reject(new Error('growth down')),
    });
    await expect(
      svc.afterAccountCreated('u1', { attribution: { ref: 'ABCDEFGH' } }, { ...FRIEND, linkAllowed: true, clientTouches: { firstTouch: { utmSource: 'x', at: T0.toISOString() } } }),
    ).resolves.toBeUndefined();
    expect(db.$rows('rAAuthToken').filter((t) => t.kind === 'known_device')).toHaveLength(1);
    // Callers without a request may still pass the bare user agent.
    await expect(svc.afterAccountCreated('u1', {}, MAC)).resolves.toBeUndefined();
  });
});

describe('invite check after verification and linking (WP-60 #6)', () => {
  const identity = (provider: 'google' | 'line') => ({ provider, subject: `${provider}-1`, email: 'ana@example.test', emailVerified: true, name: 'Ana', avatarUrl: null });

  async function signInWith(svc: ReturnType<typeof service>, provider: 'google' | 'line') {
    finish.mockResolvedValue(identity(provider));
    const { url, binder } = await svc.startOAuth({ provider, brand: ROBO, redirectUri: `http://localhost:3621/auth/callback/${provider}`, next: null, signup: null });
    return svc.finishOAuthCallback({ provider, brand: ROBO, code: 'c', state: new URL(url).searchParams.get('state')!, userAgent: MAC, binder });
  }

  it('checks the invite when the email is verified', async () => {
    seedUser();
    const svc = service();
    await svc.sendVerificationEmail({ userId: 'u1', brand: ROBO });
    await svc.verifyEmail({ token: lastLinkToken(), brand: ROBO });
    expect(referralChecks).toEqual(['u1']);
  });

  it.each(['google', 'line'] as const)('checks the invite when %s is linked to an existing account', async (provider) => {
    seedUser({ emailVerified: true });
    const res = await signInWith(service(), provider);
    expect(res).toMatchObject({ status: 'signed_in', isNewUser: false });
    expect(db.$rows('rAAuthIdentity')).toEqual([expect.objectContaining({ userId: 'u1', provider })]);
    expect(referralChecks).toEqual(['u1']);
    // Signing in again with the linked provider links nothing and checks nothing.
    await signInWith(service(), provider);
    expect(referralChecks).toEqual(['u1']);
  });

  it('is soft: a failing check never fails the verification or the sign-in', async () => {
    seedUser();
    const failing = service({ checkReferral: async () => Promise.reject(new Error('growth down')) });
    await failing.sendVerificationEmail({ userId: 'u1', brand: ROBO });
    await expect(failing.verifyEmail({ token: lastLinkToken(), brand: ROBO })).resolves.toMatchObject({ status: 'verified' });
    expect(db.$rows('user')[0]!.emailVerified).toBe(true);
    await expect(signInWith(failing, 'google')).resolves.toMatchObject({ status: 'signed_in' });
  });
});

describe('`next` to a free tool page (WP-57)', () => {
  it('lists exactly the two tool pages; anything else is not a priority path', () => {
    expect([...PRIORITY_NEXT_PATHS]).toEqual(['/tools/resume-check', '/tools/resume-job-match']);
    expect(isPriorityNext('/tools/resume-check')).toBe(true);
    expect(isPriorityNext('/tools/resume-job-match?x=1#top')).toBe(true);
    expect(isPriorityNext('/tools/resume-check/')).toBe(true);
    expect(isPriorityNext('/tools/resume-check/other')).toBe(false);
    expect(isPriorityNext('/tools')).toBe(false);
    expect(isPriorityNext('/jobs/cm1')).toBe(false);
    expect(isPriorityNext('//evil.example/tools/resume-check')).toBe(false);
    expect(isPriorityNext(null)).toBe(false);
  });

  it('wins over unfinished onboarding at sign-in; an unknown next still waits for onboarding', async () => {
    seedUser();
    db.$rows('seekerProfile')[0]!.onboardingStep = 'account';
    const svc = service();
    expect(await svc.signInRoute(ROBO, 'u1', '/tools/resume-check')).toBe('/tools/resume-check');
    expect(await svc.signInRoute(ROBO, 'u1', '/tools/resume-job-match')).toBe('/tools/resume-job-match');
    expect(await svc.signInRoute(ROBO, 'u1', '/jobs/cm1')).toBe('/onboarding/situation');
    expect(await svc.signInRoute(ROBO, 'u1', '//evil.example/tools/resume-check')).toBe('/onboarding/situation');
    db.$rows('seekerProfile')[0]!.onboardingStep = 'done';
    expect(await svc.signInRoute(ROBO, 'u1', '/jobs/cm1')).toBe('/jobs/cm1');
  });

  it('a new provider account returns to the tool page instead of the first onboarding screen', async () => {
    finish.mockResolvedValue({ provider: 'google', subject: 'g-tool', email: 'tool@example.test', emailVerified: true, name: null, avatarUrl: null });
    const svc = service();
    const start = async (next: string) => {
      const { url, binder } = await svc.startOAuth({
        provider: 'google',
        brand: ROBO,
        redirectUri: 'http://localhost:3621/auth/callback/google',
        next,
        signup: { consents: AGE, marketingOptIn: false, locale: 'en', timezone: null, country: null },
      });
      return svc.finishOAuthCallback({ provider: 'google', brand: ROBO, code: 'c', state: new URL(url).searchParams.get('state')!, userAgent: MAC, binder });
    };
    expect(await start('/tools/resume-job-match')).toMatchObject({ status: 'signed_in', isNewUser: true, next: '/tools/resume-job-match' });
  });
});

describe('GoApply accounts are never created by a provider sign-in', () => {
  it('refuses with signup_closed and creates nothing: Google and LINE stay RoboApply’s methods (the email form, phone and WeChat apply GoApply’s sign-up rules)', async () => {
    finish.mockResolvedValue({ provider: 'google', subject: 'g-cn', email: 'cn@example.test', emailVerified: true, name: null, avatarUrl: null });
    const svc = service();
    const { url, binder } = await svc.startOAuth({
      provider: 'google',
      brand: GO,
      redirectUri: 'http://goapply.localhost:3621/auth/callback/google',
      next: null,
      signup: { consents: AGE, marketingOptIn: false, locale: 'zh', timezone: null, country: null },
    });
    const res = svc.finishOAuthCallback({ provider: 'google', brand: GO, code: 'c', state: new URL(url).searchParams.get('state')!, userAgent: MAC, binder });
    expect(await authCode(res)).toBe('signup_closed');
    expect(db.$rows('user')).toEqual([]);
  });
});
