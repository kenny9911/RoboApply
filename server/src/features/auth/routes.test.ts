// @vitest-environment node
//
// Route tests for every new /auth and /account path (WP-10): status codes,
// error codes, the capability gates (404 feature_disabled), auth (401), the
// session cookie on reset / OAuth / email-link sign-in, and JSON vs redirect.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const finish = vi.hoisted(() => vi.fn());

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./oauth/providers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./oauth/providers.js')>()),
  finishOAuth: finish,
}));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { FLAG_KEYS, setFlagOverrideLoader } from '../../platform/flags.js';
import { SESSION_COOKIE_NAME } from '../../lib/cookieOptions.js';
import { createAuthFeatureService, type AuthDb } from './service.js';
import { createAccountRouter, createAuthRouter, OAUTH_BINDER_COOKIE, oauthRedirectUri } from './routes.js';
import { getBrand } from '../../platform/brand/registry.js';

const ENV_ON = {
  NODE_ENV: 'development',
  GOOGLE_OAUTH_CLIENT_ID: 'gid',
  GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret',
  LINE_LOGIN_CHANNEL_ID: 'lid',
  LINE_LOGIN_CHANNEL_SECRET: 'lsecret',
  RESEND_API_KEY: 're_test',
};
const ENV_OFF = { NODE_ENV: 'development' };
const T0 = new Date('2026-10-10T12:00:00.000Z');
const AGE = [{ type: 'age_16_plus', granted: true, proseVersion: 'v1' }];
const ROBO = 'localhost:3621';

let db: ReturnType<typeof createFakePrisma>;
let sent: Array<{ template: string; params: Record<string, unknown> }>;
let signedIn: { id: string } | null;

function seed() {
  db.$rows('user').push({
    id: 'u1',
    email: 'ana@example.test',
    brand: 'roboapply',
    role: 'seeker',
    isActive: true,
    emailVerified: false,
    emailIsPlaceholder: false,
    passwordHash: 'h',
    createdAt: T0,
  });
  db.$rows('seekerProfile').push({ id: 'p1', userId: 'u1', locale: 'en', deletedAt: null, onboardingStep: 'done' });
}

function makeService(env: Record<string, string>) {
  let n = 0;
  return createAuthFeatureService({
    db: db as unknown as AuthDb,
    env,
    now: () => T0,
    sendEmail: async (input) => {
      sent.push({ template: String(input.template), params: input.params });
      return { status: 'sent' };
    },
    createSession: async (userId) => {
      n += 1;
      db.$rows('session').push({ id: `s${n}`, userId, token: `sess-${n}`, createdAt: T0, expiresAt: new Date(T0.getTime() + 1e9) });
      return { token: `sess-${n}`, expiresAt: new Date(T0.getTime() + 1e9) };
    },
    hashPassword: async (p) => `hashed:${p}`,
    grantPracticeCredit: async () => ({ status: 'granted', ledgerId: 'l', balanceAfter: 1 }),
    summarizeEntitlements: async () => ({}) as never,
    resolveFlags: async () => Object.fromEntries([...FLAG_KEYS.map((k) => [k, false]), ['hiringContacts', 'off']]) as never,
  });
}

let on: RouteHarness;
let off: RouteHarness;

function build(env: typeof ENV_ON | typeof ENV_OFF) {
  const service = makeService(env);
  const auth = [fakeAuth(() => signedIn)];
  return startRouteHarness({
    env,
    mounts: [
      ['/api/v1/roboapply/auth', createAuthRouter({ env, service, seekerAuth: auth, rateLimits: false })],
      ['/api/v1/roboapply/account', createAccountRouter({ env, service, seekerAuth: auth })],
    ],
  });
}

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  db = createFakePrisma({ uniqueFields: { rAAuthToken: ['tokenHash'], user: ['email'] } });
  on = await build(ENV_ON);
  off = await build(ENV_OFF);
});

afterAll(async () => {
  setFlagOverrideLoader(null);
  await Promise.all([on.close(), off.close()]);
});

beforeEach(() => {
  for (const t of ['user', 'seekerProfile', 'session', 'rAAuthToken', 'rAAuthIdentity', 'seekerConsentRecord', 'seekerNotification']) db.$rows(t).length = 0;
  sent = [];
  signedIn = null;
  finish.mockReset();
  seed();
});

const A = '/api/v1/roboapply/auth';
const ACC = '/api/v1/roboapply/account';
const JSON_ACCEPT = { accept: 'application/json' };
const cookieOf = (h: Headers) => h.get('set-cookie') ?? '';
const tokenFromLastEmail = () => String(sent.at(-1)!.params.path).split('/').pop()!;
const binderOf = (h: Headers) => new RegExp(`${OAUTH_BINDER_COOKIE}=([^;]+)`).exec(cookieOf(h))?.[1] ?? '';

/** Start an OAuth attempt (JSON form) and return the state plus this browser's binding cookie. */
async function startJson(path: string): Promise<{ state: string; cookies: Record<string, string> }> {
  const start = await on.request<{ data: { url: string } }>('GET', path, { host: ROBO, headers: JSON_ACCEPT });
  return { state: new URL(start.body.data.url).searchParams.get('state')!, cookies: { [OAUTH_BINDER_COOKIE]: binderOf(start.headers) } };
}

describe('GET /auth/methods', () => {
  it('lists only configured methods; LINE only for zh-TW or Taiwan', async () => {
    const res = await on.request<{ data: { methods: Array<{ id: string; startUrl: string | null }> } }>('GET', `${A}/methods?locale=en`, {
      host: ROBO,
      headers: { 'x-vercel-ip-country': 'US' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.methods).toEqual([
      { id: 'email_password', startUrl: null },
      { id: 'google', startUrl: '/api/v1/roboapply/auth/oauth/google/start' },
    ]);
    const tw = await on.request<{ data: { methods: Array<{ id: string }> } }>('GET', `${A}/methods?locale=en`, { host: ROBO, headers: { 'x-vercel-ip-country': 'TW' } });
    expect(tw.body.data.methods.map((m) => m.id)).toEqual(['line', 'email_password', 'google']);
    const bare = await off.request<{ data: { methods: unknown[]; pdpaNoticeRequired: boolean } }>('GET', `${A}/methods?locale=zh-TW`, { host: ROBO });
    expect(bare.body.data.methods).toEqual([{ id: 'email_password', startUrl: null }]);
    expect(bare.body.data.pdpaNoticeRequired).toBe(true);
  });
});

describe('password reset', () => {
  it('forgot → 204 always; 422 on a bad email; 404 when no email transport', async () => {
    expect((await on.request('POST', `${A}/password/forgot`, { host: ROBO, body: { email: 'nobody@example.test' } })).status).toBe(204);
    expect(sent).toEqual([]);
    expect((await on.request('POST', `${A}/password/forgot`, { host: ROBO, body: { email: 'ana@example.test' } })).status).toBe(204);
    expect(sent).toHaveLength(1);
    expect((await on.request('POST', `${A}/password/forgot`, { host: ROBO, body: { email: 'nope' } })).status).toBe(422);
    const disabled = await off.request<{ code: string }>('POST', `${A}/password/forgot`, { host: ROBO, body: { email: 'ana@example.test' } });
    expect([disabled.status, disabled.body.code]).toEqual([404, 'feature_disabled']);
  });

  it('reset → session cookie and the sign-in route; reuse → 400 token_invalid', async () => {
    await on.request('POST', `${A}/password/forgot`, { host: ROBO, body: { email: 'ana@example.test' } });
    const token = tokenFromLastEmail();
    const weak = await on.request<{ code: string }>('POST', `${A}/password/reset`, { host: ROBO, body: { token, password: 'abcdefgh' } });
    expect([weak.status, weak.body.code]).toEqual([422, 'invalid_request']);
    const ok = await on.request<{ data: { next: string } }>('POST', `${A}/password/reset`, { host: ROBO, body: { token, password: 'abcdefg1' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.next).toBe('/jobs');
    expect(cookieOf(ok.headers)).toContain(`${SESSION_COOKIE_NAME}=sess-1`);
    const again = await on.request<{ code: string }>('POST', `${A}/password/reset`, { host: ROBO, body: { token, password: 'abcdefg1' } });
    expect([again.status, again.body.code]).toEqual([400, 'token_invalid']);
  });
});

describe('email verification', () => {
  it('send needs a session; verify answers JSON or redirects', async () => {
    expect((await on.request('POST', `${A}/email/verify/send`, { host: ROBO })).status).toBe(401);
    signedIn = { id: 'u1' };
    expect((await on.request('POST', `${A}/email/verify/send`, { host: ROBO })).status).toBe(204);
    const status = await on.request<{ data: { verified: boolean } }>('GET', `${A}/email/status`, { host: ROBO });
    expect(status.body.data.verified).toBe(false);

    const token = tokenFromLastEmail();
    const json = await on.request<{ data: { status: string; next: string } }>('GET', `${A}/email/verify?token=${token}`, { host: ROBO, headers: JSON_ACCEPT });
    expect(json.body.data).toEqual({ status: 'verified', next: '/settings#account' });

    signedIn = { id: 'u1' };
    db.$rows('user')[0]!.emailVerified = false;
    await on.request('POST', `${A}/email/verify/send`, { host: ROBO });
    const res = await fetch(`${on.baseUrl}${A}/email/verify?token=${tokenFromLastEmail()}`, { redirect: 'manual', headers: { 'x-forwarded-host': ROBO } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/settings?verified=1#account');
    const bad = await fetch(`${on.baseUrl}${A}/email/verify?token=${'x'.repeat(32)}`, { redirect: 'manual', headers: { 'x-forwarded-host': ROBO } });
    expect(bad.headers.get('location')).toBe('/settings?verified=0&reason=token_invalid#account');
  });
});

describe('OAuth', () => {
  it('start → 302 to Google with state; 404 when Google is not configured', async () => {
    const res = await fetch(`${on.baseUrl}${A}/oauth/google/start?next=/jobs/cm1&age=1`, { redirect: 'manual', headers: { 'x-forwarded-host': ROBO } });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.host).toBe('accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3621/auth/callback/google');
    // Browser binding: short-lived, httpOnly, Lax (rides the provider's redirect back).
    const binding = cookieOf(res.headers);
    expect(binding).toMatch(new RegExp(`${OAUTH_BINDER_COOKIE}=[\\w-]{20,}`));
    expect(binding).toMatch(/HttpOnly/i);
    expect(binding).toMatch(/SameSite=Lax/i);
    expect(binding).toMatch(/Max-Age=900/i);
    const disabled = await off.request<{ code: string }>('GET', `${A}/oauth/google/start`, { host: ROBO });
    expect([disabled.status, disabled.body.code]).toEqual([404, 'feature_disabled']);
    const badNext = await on.request('GET', `${A}/oauth/google/start?next=https://evil.example`, { host: ROBO, headers: JSON_ACCEPT });
    expect(badNext.status).toBe(422);
  });

  it('callback (JSON) creates the account, sets the cookie and sends the user to onboarding', async () => {
    finish.mockResolvedValue({ provider: 'google', subject: 'g1', email: 'new@example.test', emailVerified: true, name: null, avatarUrl: null });
    const { state, cookies } = await startJson(`${A}/oauth/google/start?age=1&locale=en`);
    const cb = await on.request<{ data: { status: string; next: string; isNewUser: boolean } }>('GET', `${A}/oauth/google/callback?code=c&state=${state}`, {
      host: ROBO,
      headers: JSON_ACCEPT,
      cookies,
    });
    expect(cb.status).toBe(200);
    expect(cb.body.data).toEqual({ status: 'signed_in', next: '/onboarding/situation', isNewUser: true });
    expect(cookieOf(cb.headers)).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(db.$rows('seekerProfile').find((p) => p.userId !== 'u1')!.onboardingStep).toBe('account');
    // The binding cookie is cleared once used.
    expect(cookieOf(cb.headers)).toMatch(new RegExp(`${OAUTH_BINDER_COOKIE}=;`));
  });

  it('callback without the binding cookie of the browser that started it → 400 oauth_state_invalid (login CSRF)', async () => {
    finish.mockResolvedValue({ provider: 'google', subject: 'g-att', email: 'attacker@example.test', emailVerified: true, name: null, avatarUrl: null });
    const { state } = await startJson(`${A}/oauth/google/start?age=1`);
    // The victim opens the attacker's callback link: no cookie, or another attempt's cookie.
    const bare = await on.request<{ code: string }>('GET', `${A}/oauth/google/callback?code=c&state=${state}`, { host: ROBO, headers: JSON_ACCEPT });
    expect([bare.status, bare.body.code]).toEqual([400, 'oauth_state_invalid']);
    const other = await startJson(`${A}/oauth/google/start?age=1`);
    const mixed = await on.request<{ code: string }>('GET', `${A}/oauth/google/callback?code=c&state=${other.state}`, {
      host: ROBO,
      headers: JSON_ACCEPT,
      cookies: { [OAUTH_BINDER_COOKIE]: 'x'.repeat(43) },
    });
    expect([mixed.status, mixed.body.code]).toEqual([400, 'oauth_state_invalid']);
    expect(cookieOf(mixed.headers)).not.toContain(`${SESSION_COOKIE_NAME}=`);
    expect(finish).not.toHaveBeenCalled();
    const redirect = await fetch(`${on.baseUrl}${A}/oauth/google/callback?code=c&state=${state}`, { redirect: 'manual', headers: { 'x-forwarded-host': ROBO } });
    expect(redirect.headers.get('location')).toBe('/login?error=oauth_state_invalid');
  });

  it('callback: other-brand account → 409 account_other_brand; bad state → 400', async () => {
    db.$rows('user')[0]!.brand = 'goapply';
    finish.mockResolvedValue({ provider: 'google', subject: 'g1', email: 'ana@example.test', emailVerified: true, name: null, avatarUrl: null });
    const { state, cookies } = await startJson(`${A}/oauth/google/start`);
    const cb = await on.request<{ code: string; details: { otherBrandUrl: string } }>('GET', `${A}/oauth/google/callback?code=c&state=${state}`, {
      host: ROBO,
      headers: JSON_ACCEPT,
      cookies,
    });
    expect([cb.status, cb.body.code, cb.body.details.otherBrandUrl]).toEqual([409, 'account_other_brand', 'https://www.goapply.top/login']);
    const bad = await on.request<{ code: string }>('GET', `${A}/oauth/google/callback?code=c&state=${'s'.repeat(30)}`, { host: ROBO, headers: JSON_ACCEPT });
    expect([bad.status, bad.body.code]).toEqual([400, 'oauth_state_invalid']);
    const redirect = await fetch(`${on.baseUrl}${A}/oauth/google/callback?error=access_denied`, { redirect: 'manual', headers: { 'x-forwarded-host': ROBO } });
    expect(redirect.headers.get('location')).toBe('/login?error=oauth_failed');
  });

  it('consent_required → POST /oauth/complete (422 without age, then signed in)', async () => {
    finish.mockResolvedValue({ provider: 'google', subject: 'g2', email: 'two@example.test', emailVerified: true, name: null, avatarUrl: null });
    const { state, cookies } = await startJson(`${A}/oauth/google/start`);
    const cb = await on.request<{ data: { status: string; pendingToken: string } }>('GET', `${A}/oauth/google/callback?code=c&state=${state}`, {
      host: ROBO,
      headers: JSON_ACCEPT,
      cookies,
    });
    expect(cb.body.data.status).toBe('consent_required');
    const missing = await on.request<{ code: string }>('POST', `${A}/oauth/complete`, { host: ROBO, body: { pendingToken: cb.body.data.pendingToken, consents: [] } });
    expect([missing.status, missing.body.code]).toEqual([422, 'age_consent_required']);
    const ok = await on.request<{ data: { status: string } }>('POST', `${A}/oauth/complete`, {
      host: ROBO,
      body: { pendingToken: cb.body.data.pendingToken, consents: AGE },
    });
    expect(ok.body.data.status).toBe('signed_in');
    expect(cookieOf(ok.headers)).toContain(SESSION_COOKIE_NAME);
  });

  it('LINE without email → POST /oauth/email → link signs in', async () => {
    finish.mockResolvedValue({ provider: 'line', subject: 'U1', email: null, emailVerified: false, name: 'Lin', avatarUrl: null });
    const { state, cookies } = await startJson(`${A}/oauth/line/start?age=1`);
    const cb = await on.request<{ data: { status: string; pendingToken: string } }>('GET', `${A}/oauth/line/callback?code=c&state=${state}`, {
      host: ROBO,
      headers: JSON_ACCEPT,
      cookies,
    });
    expect(cb.body.data.status).toBe('email_required');
    const emailRes = await on.request<{ data: { status: string } }>('POST', `${A}/oauth/email`, {
      host: ROBO,
      body: { pendingToken: cb.body.data.pendingToken, email: 'lin@example.test', consents: AGE },
    });
    expect(emailRes.body.data).toEqual({ status: 'check_email' });
    const link = await on.request<{ data: { status: string; isNewUser: boolean } }>('GET', `${A}/email/verify?token=${tokenFromLastEmail()}`, {
      host: ROBO,
      headers: JSON_ACCEPT,
    });
    expect(link.body.data).toMatchObject({ status: 'signed_in', isNewUser: true });
    expect(cookieOf(link.headers)).toContain(SESSION_COOKIE_NAME);
    // A pending token from an unknown attempt is refused.
    const unknown = await off.request<{ code: string }>('POST', `${A}/oauth/email`, { host: ROBO, body: { pendingToken: 'p'.repeat(20), email: 'a@b.co', consents: AGE } });
    expect([unknown.status, unknown.body.code]).toEqual([400, 'token_invalid']);
  });

  it('a LINE email link for an address that already has an account → account_exists, nothing linked', async () => {
    finish.mockResolvedValue({ provider: 'line', subject: 'U-x', email: null, emailVerified: false, name: null, avatarUrl: null });
    const { state, cookies } = await startJson(`${A}/oauth/line/start?age=1`);
    const cb = await on.request<{ data: { pendingToken: string } }>('GET', `${A}/oauth/line/callback?code=c&state=${state}`, { host: ROBO, headers: JSON_ACCEPT, cookies });
    await on.request('POST', `${A}/oauth/email`, { host: ROBO, body: { pendingToken: cb.body.data.pendingToken, email: 'ana@example.test', consents: AGE } });
    const link = await on.request<{ data: { status: string; next: string } }>('GET', `${A}/email/verify?token=${tokenFromLastEmail()}`, { host: ROBO, headers: JSON_ACCEPT });
    expect(link.body.data).toEqual({ status: 'account_exists', next: '/login' });
    expect(cookieOf(link.headers)).not.toContain(SESSION_COOKIE_NAME);
    expect(db.$rows('rAAuthIdentity')).toEqual([]);
  });

  it('redirect URI uses the canonical origin in production', () => {
    const req = { get: () => 'evil.example' } as unknown as import('express').Request;
    expect(oauthRedirectUri(req, getBrand('goapply'), 'google', { NODE_ENV: 'production' })).toBe('https://www.goapply.top/auth/callback/google');
  });
});

describe('/account identities, consents, sessions', () => {
  it('401 without a session', async () => {
    for (const [m, p] of [
      ['GET', `${ACC}/identities`],
      ['DELETE', `${ACC}/identities/x`],
      ['GET', `${ACC}/consents`],
      ['POST', `${ACC}/consents`],
      ['GET', `${ACC}/sessions`],
      ['DELETE', `${ACC}/sessions/x`],
    ] as const) {
      expect((await on.request(m, p, { host: ROBO })).status).toBe(401);
    }
  });

  it('identities: list and 409 last_identity', async () => {
    signedIn = { id: 'u1' };
    const list = await on.request<{ data: { identities: Array<{ id: string; removable: boolean }> } }>('GET', `${ACC}/identities`, { host: ROBO });
    expect(list.body.data.identities).toEqual([expect.objectContaining({ id: 'email', removable: false })]);
    const del = await on.request<{ code: string }>('DELETE', `${ACC}/identities/email`, { host: ROBO });
    expect([del.status, del.body.code]).toEqual([409, 'last_identity']);
  });

  it('consents: record, 422 on unknown or locked, list', async () => {
    signedIn = { id: 'u1' };
    const ok = await on.request<{ data: { type: string } }>('POST', `${ACC}/consents`, { host: ROBO, body: { type: 'analytics', granted: true, proseVersion: 'v1' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.type).toBe('analytics');
    expect((await on.request<{ code: string }>('POST', `${ACC}/consents`, { host: ROBO, body: { type: 'x', granted: true, proseVersion: 'v1' } })).body.code).toBe('unknown_consent');
    expect(
      (await on.request<{ code: string }>('POST', `${ACC}/consents`, { host: ROBO, body: { type: 'age_16_plus', granted: false, proseVersion: 'v1' } })).body.code,
    ).toBe('consent_locked');
    expect((await on.request('POST', `${ACC}/consents`, { host: ROBO, body: { type: 'analytics' } })).status).toBe(422);
    const list = await on.request<{ data: { consents: unknown[] } }>('GET', `${ACC}/consents`, { host: ROBO });
    expect(list.body.data.consents).toHaveLength(1);
  });

  it('sessions: current flagged; revoke', async () => {
    signedIn = { id: 'u1' };
    db.$rows('session').push({ id: 's-x', userId: 'u1', token: 'tok-x', createdAt: T0, expiresAt: new Date(Date.now() + 1e9) });
    const list = await on.request<{ data: { sessions: Array<{ id: string; current: boolean }> } }>('GET', `${ACC}/sessions`, {
      host: ROBO,
      cookies: { [SESSION_COOKIE_NAME]: 'tok-x' },
    });
    expect(list.body.data.sessions).toEqual([expect.objectContaining({ id: 's-x', current: true })]);
    expect((await on.request('DELETE', `${ACC}/sessions/s-x`, { host: ROBO })).status).toBe(200);
    expect((await on.request('DELETE', `${ACC}/sessions/s-x`, { host: ROBO })).status).toBe(404);
  });
});
