// @vitest-environment node
//
// WP-10 service acceptance on an in-memory Prisma (no network, no database):
// password reset (30 min, single use, revokes other sessions), email
// verification (non-blocking; grants the practice credit once), Google/LINE
// (find or create a seeker; link by verified email only within the brand;
// other-brand → 409; LINE without email verifies one first), /auth/me
// additions, identities, consents, sessions and the new-device email.

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
    db.$rows('seekerNotification').push({ id: 'n1', userId: 'u1', readAt: null }, { id: 'n2', userId: 'u1', readAt: T0 });
    const me = await service().meAdditions('u1', ROBO);
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
    const failing = createFakePrisma({ failOn: { 'seekerNotification.count': new Error('no table') } });
    for (const [k, rows] of [['user', db.$rows('user')], ['seekerProfile', db.$rows('seekerProfile')]] as const) failing.$rows(k).push(...rows);
    const me = await service({ db: failing as unknown as AuthDb, summarizeEntitlements: async () => Promise.reject(new Error('down')) }).meAdditions('u1', ROBO);
    expect(me.unreadCount).toBeNull();
    expect(me.entitlements).toBeNull();
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

  it('records consents (canonical type, newest wins) and locks the age agreement', async () => {
    seedUser();
    const svc = service();
    expect(await authCode(svc.recordConsent('u1', { type: 'made_up', granted: true, proseVersion: 'v' }))).toBe('unknown_consent');
    expect(await authCode(svc.recordConsent('u1', { type: 'age_16_plus', granted: false, proseVersion: 'v' }))).toBe('consent_locked');
    await svc.recordConsent('u1', { type: 'analytics', granted: true, proseVersion: 'v1' });
    clock = new Date(T0.getTime() + 1000);
    await svc.recordConsent('u1', { type: 'analytics', granted: false, proseVersion: 'v2' }, { ip: '1.2.3.4', userAgent: MAC });
    await svc.recordConsent('u1', { type: 'ai_resume_parse', granted: true, proseVersion: 'v1' });
    const list = await svc.listConsents('u1');
    expect(list.find((c) => c.type === 'analytics')).toMatchObject({ granted: false, proseVersion: 'v2' });
    expect(list.map((c) => c.type)).toContain('ai_resume_parsing');
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
