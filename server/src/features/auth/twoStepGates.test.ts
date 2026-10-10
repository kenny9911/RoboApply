// @vitest-environment node
//
// Two-step sign-in on every path of features/auth/routes.ts that signs a
// browser in (INT-01; WP-79 acceptance "2FA bypass impossible on login").
// One test per path: with two-step sign-in on, the session just minted is
// revoked, no session cookie leaves the server, and the answer is the same
// as POST /auth/login (401 `two_factor_required` + the challenge cookie) or,
// for link and provider redirects, a 302 to /login/2fa. With it off, the
// path signs in as before. When the check itself fails nobody is signed in.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const finish = vi.hoisted(() => vi.fn());

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./oauth/providers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./oauth/providers.js')>()),
  finishOAuth: finish,
}));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { FLAG_KEYS, setFlagOverrideLoader } from '../../platform/flags.js';
import { SESSION_COOKIE_NAME } from '../../lib/cookieOptions.js';
import { CHALLENGE_COOKIE, CHALLENGE_COOKIE_PATH, createMemoryChallengeStore, hashChallengeToken, type LoginChallengeDeps } from '../account-v2/index.js';
import { createAuthFeatureService, type AuthDb } from './service.js';
import { createAuthRouter, OAUTH_BINDER_COOKIE } from './routes.js';

const ENV = {
  NODE_ENV: 'development',
  GOOGLE_OAUTH_CLIENT_ID: 'gid',
  GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret',
  LINE_LOGIN_CHANNEL_ID: 'lid',
  LINE_LOGIN_CHANNEL_SECRET: 'lsecret',
  RESEND_API_KEY: 're_test',
};
const T0 = new Date('2026-10-10T12:00:00.000Z');
const AGE = [{ type: 'age_16_plus', granted: true, proseVersion: 'v1' }];
const ROBO = 'localhost:3621';
const A = '/api/v1/roboapply/auth';
const JSON_ACCEPT = { accept: 'application/json' };

let db: ReturnType<typeof createFakePrisma>;
let sent: Array<{ params: Record<string, unknown> }>;
let h: RouteHarness;
let challenges: ReturnType<typeof createMemoryChallengeStore>;
/** Who has two-step sign-in on: everyone, nobody, or a broken check. */
let twoStep: 'on' | 'off' | 'broken';

function gateDeps(): LoginChallengeDeps {
  return {
    twoFactor: {
      requiresChallenge: async () => {
        if (twoStep === 'broken') throw new Error('two-factor table unreachable');
        return twoStep === 'on';
      },
      checkSecondFactor: async () => ({ ok: false }),
    },
    challenges,
    now: () => T0,
    invalidateSession: async (token) => {
      const rows = db.$rows('session');
      const at = rows.findIndex((s) => s.token === token);
      if (at >= 0) rows.splice(at, 1);
    },
    createSession: async () => ({ token: 'after-second-step' }),
    accountAllowed: async () => true,
    userAttemptAllowed: async () => true,
  };
}

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  db = createFakePrisma({ uniqueFields: { rAAuthToken: ['tokenHash'], user: ['email'] } });
  let n = 0;
  const service = createAuthFeatureService({
    db: db as unknown as AuthDb,
    env: ENV,
    now: () => T0,
    sendEmail: async (input) => {
      sent.push({ params: input.params });
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
    recordAttribution: async () => undefined,
    checkReferral: async () => undefined,
    rememberRegion: async () => undefined,
  });
  h = await startRouteHarness({
    env: ENV,
    mounts: [['/api/v1/roboapply/auth', createAuthRouter({ env: ENV, service, seekerAuth: [], rateLimits: false, loginChallenge: gateDeps })]],
  });
});

afterAll(async () => {
  setFlagOverrideLoader(null);
  await h.close();
});

beforeEach(() => {
  for (const t of ['user', 'seekerProfile', 'session', 'rAAuthToken', 'rAAuthIdentity', 'seekerConsentRecord']) db.$rows(t).length = 0;
  sent = [];
  twoStep = 'on';
  challenges = createMemoryChallengeStore();
  finish.mockReset();
  db.$rows('user').push({ id: 'u1', email: 'ana@example.test', brand: 'roboapply', role: 'seeker', isActive: true, emailVerified: true, emailIsPlaceholder: false, passwordHash: 'h', createdAt: T0 });
  db.$rows('seekerProfile').push({ id: 'p1', userId: 'u1', locale: 'en', deletedAt: null, onboardingStep: 'done' });
});

const cookies = (headers: Headers) => headers.get('set-cookie') ?? '';
const lastToken = () => String(sent.at(-1)!.params.path).split('/').pop()!;
const binderOf = (headers: Headers) => new RegExp(`${OAUTH_BINDER_COOKIE}=([^;]+)`).exec(cookies(headers))?.[1] ?? '';

interface Challenge401 {
  success: boolean;
  code: string;
  details: { next: string; methods: string[]; expiresInSec: number };
}

/** The answer POST /auth/login gives: 401, the challenge cookie, no session, the minted session revoked. */
function expectChallenge(res: { status: number; headers: Headers; body: Challenge401 }, userId: string, next: string) {
  expect(res.status).toBe(401);
  expect(res.body).toMatchObject({ success: false, code: 'two_factor_required', details: { next, methods: ['totp', 'recovery'], expiresInSec: 300 } });
  expectChallengeCookie(res.headers, userId);
}

function expectChallengeCookie(headers: Headers, userId: string) {
  const set = cookies(headers);
  expect(set).not.toContain(`${SESSION_COOKIE_NAME}=`);
  const token = new RegExp(`${CHALLENGE_COOKIE}=([^;]+)`).exec(set)?.[1];
  expect(token).toBeTruthy();
  expect(set).toMatch(/HttpOnly/i);
  expect(set).toContain(`Path=${CHALLENGE_COOKIE_PATH}`);
  // The challenge belongs to this user, and the session minted by the first step is gone.
  const row = [...challenges.rows.values()].find((r) => r.tokenHash === hashChallengeToken(decodeURIComponent(token!)));
  expect(row).toMatchObject({ userId, brand: 'roboapply' });
  expect(db.$rows('session').filter((s) => s.userId === userId)).toEqual([]);
}

async function oauthStart(provider: 'google' | 'line', query = '') {
  const start = await h.request<{ data: { url: string } }>('GET', `${A}/oauth/${provider}/start${query}`, { host: ROBO, headers: JSON_ACCEPT });
  return { state: new URL(start.body.data.url).searchParams.get('state')!, cookies: { [OAUTH_BINDER_COOKIE]: binderOf(start.headers) } };
}

/** A linked Google identity for the seeded account. */
function linkGoogle() {
  db.$rows('rAAuthIdentity').push({ id: 'i1', userId: 'u1', brand: 'roboapply', provider: 'google', appId: '', subject: 'g1', createdAt: T0 });
  finish.mockResolvedValue({ provider: 'google', subject: 'g1', email: 'ana@example.test', emailVerified: true, name: null, avatarUrl: null });
}

/** A LINE sign-up without an email, up to the emailed link; returns the link's token. */
async function lineEmailLink(): Promise<string> {
  finish.mockResolvedValue({ provider: 'line', subject: 'U1', email: null, emailVerified: false, name: 'Lin', avatarUrl: null });
  const { state, cookies: c } = await oauthStart('line', '?age=1');
  const cb = await h.request<{ data: { pendingToken: string } }>('GET', `${A}/oauth/line/callback?code=c&state=${state}`, { host: ROBO, headers: JSON_ACCEPT, cookies: c });
  await h.request('POST', `${A}/oauth/email`, { host: ROBO, body: { pendingToken: cb.body.data.pendingToken, email: 'lin@example.test', consents: AGE } });
  return lastToken();
}

describe('password reset (2fa-gate:password-reset)', () => {
  async function reset() {
    await h.request('POST', `${A}/password/forgot`, { host: ROBO, body: { email: 'ana@example.test' } });
    return h.request<Challenge401 & { data?: { next: string } }>('POST', `${A}/password/reset`, { host: ROBO, body: { token: lastToken(), password: 'abcdefg1' } });
  }

  it('two-step sign-in on: the new password is saved, but the answer is the challenge and no session', async () => {
    const res = await reset();
    expectChallenge(res, 'u1', '/login/2fa?next=%2Fjobs');
    expect(db.$rows('user')[0]!.passwordHash).toBe('hashed:abcdefg1');
  });

  it('two-step sign-in off: signs in as before', async () => {
    twoStep = 'off';
    const res = await reset();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ next: '/jobs' });
    expect(cookies(res.headers)).toContain(`${SESSION_COOKIE_NAME}=sess-`);
    expect(cookies(res.headers)).not.toContain(`${CHALLENGE_COOKIE}=`);
  });

  it('the check fails: 503 two_factor_unavailable and nobody is signed in', async () => {
    twoStep = 'broken';
    const res = await reset();
    expect([res.status, res.body.code]).toEqual([503, 'two_factor_unavailable']);
    expect(cookies(res.headers)).not.toContain(`${SESSION_COOKIE_NAME}=`);
  });
});

describe('email link that finishes a LINE sign-up', () => {
  it('opened as a link (2fa-gate:email-verify-link): on → 302 /login/2fa with the challenge cookie', async () => {
    const token = await lineEmailLink();
    const res = await fetch(`${h.baseUrl}${A}/email/verify?token=${token}`, { redirect: 'manual', headers: { 'x-forwarded-host': ROBO } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login/2fa?next=%2Fonboarding%2Fsituation');
    const created = db.$rows('user').find((u) => u.email === 'lin@example.test')!;
    expectChallengeCookie(res.headers, String(created.id));
  });

  it('opened as a link: off → session cookie and the onboarding redirect; broken → the sign-in page with an error', async () => {
    twoStep = 'off';
    const ok = await fetch(`${h.baseUrl}${A}/email/verify?token=${await lineEmailLink()}`, { redirect: 'manual', headers: { 'x-forwarded-host': ROBO } });
    expect(ok.headers.get('location')).toBe('/onboarding/situation');
    expect(cookies(ok.headers)).toContain(`${SESSION_COOKIE_NAME}=sess-`);

    db.$rows('user').splice(1);
    db.$rows('rAAuthIdentity').length = 0;
    twoStep = 'on';
    const token = await lineEmailLink();
    twoStep = 'broken';
    const broken = await fetch(`${h.baseUrl}${A}/email/verify?token=${token}`, { redirect: 'manual', headers: { 'x-forwarded-host': ROBO } });
    expect(broken.headers.get('location')).toBe('/login?error=two_factor_unavailable');
    expect(cookies(broken.headers)).not.toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it('read as JSON (2fa-gate:email-verify-json): on → the challenge; off → signed in', async () => {
    const res = await h.request<Challenge401>('GET', `${A}/email/verify?token=${await lineEmailLink()}`, { host: ROBO, headers: JSON_ACCEPT });
    const created = db.$rows('user').find((u) => u.email === 'lin@example.test')!;
    expectChallenge(res, String(created.id), '/login/2fa?next=%2Fonboarding%2Fsituation');

    db.$rows('user').splice(1);
    db.$rows('rAAuthIdentity').length = 0;
    twoStep = 'off';
    const ok = await h.request<{ data: { status: string } }>('GET', `${A}/email/verify?token=${await lineEmailLink()}`, { host: ROBO, headers: JSON_ACCEPT });
    expect(ok.body.data).toMatchObject({ status: 'signed_in', isNewUser: true });
    expect(cookies(ok.headers)).toContain(`${SESSION_COOKIE_NAME}=sess-`);
  });

  it('a link that only verifies an email mints no session and needs no second step', async () => {
    db.$rows('user')[0]!.emailVerified = false;
    const { issueToken } = await import('./tokens.js');
    const { raw: svcToken } = await issueToken(db as unknown as AuthDb, {
      kind: 'email_verify',
      brand: 'roboapply',
      userId: 'u1',
      payload: { email: 'ana@example.test' },
      now: T0,
    });
    const res = await h.request<{ data: { status: string } }>('GET', `${A}/email/verify?token=${svcToken}`, { host: ROBO, headers: JSON_ACCEPT });
    expect(res.body.data).toEqual({ status: 'verified', next: '/settings#account' });
    expect(cookies(res.headers)).not.toContain(`${CHALLENGE_COOKIE}=`);
    expect(challenges.rows.size).toBe(0);
  });
});

describe('Google / LINE callback', () => {
  it('provider redirect to the API (2fa-gate:oauth-callback-redirect): on → 302 /login/2fa, no session', async () => {
    linkGoogle();
    const { state, cookies: c } = await oauthStart('google', '?next=/jobs/cm1');
    const res = await fetch(`${h.baseUrl}${A}/oauth/google/callback?code=c&state=${state}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-host': ROBO, cookie: `${OAUTH_BINDER_COOKIE}=${c[OAUTH_BINDER_COOKIE]}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login/2fa?next=%2Fjobs%2Fcm1');
    expectChallengeCookie(res.headers, 'u1');
  });

  it('provider redirect: off → session and `next`; broken → the sign-in page with an error', async () => {
    linkGoogle();
    twoStep = 'off';
    const a = await oauthStart('google', '?next=/jobs/cm1');
    const ok = await fetch(`${h.baseUrl}${A}/oauth/google/callback?code=c&state=${a.state}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-host': ROBO, cookie: `${OAUTH_BINDER_COOKIE}=${a.cookies[OAUTH_BINDER_COOKIE]}` },
    });
    expect(ok.headers.get('location')).toBe('/jobs/cm1');
    expect(cookies(ok.headers)).toContain(`${SESSION_COOKIE_NAME}=sess-`);

    twoStep = 'broken';
    const b = await oauthStart('google');
    const broken = await fetch(`${h.baseUrl}${A}/oauth/google/callback?code=c&state=${b.state}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-host': ROBO, cookie: `${OAUTH_BINDER_COOKIE}=${b.cookies[OAUTH_BINDER_COOKIE]}` },
    });
    expect(broken.headers.get('location')).toBe('/login?error=two_factor_unavailable');
    expect(cookies(broken.headers)).not.toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it("the web page's JSON call (2fa-gate:oauth-callback-json): on → the challenge; off → signed in", async () => {
    linkGoogle();
    const a = await oauthStart('google', '?next=/jobs/cm1');
    const res = await h.request<Challenge401>('GET', `${A}/oauth/google/callback?code=c&state=${a.state}`, { host: ROBO, headers: JSON_ACCEPT, cookies: a.cookies });
    expectChallenge(res, 'u1', '/login/2fa?next=%2Fjobs%2Fcm1');

    twoStep = 'off';
    const b = await oauthStart('google', '?next=/jobs/cm1');
    const ok = await h.request<{ data: unknown }>('GET', `${A}/oauth/google/callback?code=c&state=${b.state}`, { host: ROBO, headers: JSON_ACCEPT, cookies: b.cookies });
    expect(ok.body.data).toEqual({ status: 'signed_in', next: '/jobs/cm1', isNewUser: false });
    expect(cookies(ok.headers)).toContain(`${SESSION_COOKIE_NAME}=sess-`);

    twoStep = 'broken';
    const c = await oauthStart('google');
    const broken = await h.request<Challenge401>('GET', `${A}/oauth/google/callback?code=c&state=${c.state}`, { host: ROBO, headers: JSON_ACCEPT, cookies: c.cookies });
    expect([broken.status, broken.body.code]).toEqual([503, 'two_factor_unavailable']);
    expect(cookies(broken.headers)).not.toContain(`${SESSION_COOKIE_NAME}=`);
  });
});

describe('POST /oauth/complete (2fa-gate:oauth-complete)', () => {
  async function pending() {
    finish.mockResolvedValue({ provider: 'google', subject: 'g2', email: 'two@example.test', emailVerified: true, name: null, avatarUrl: null });
    const { state, cookies: c } = await oauthStart('google');
    const cb = await h.request<{ data: { status: string; pendingToken: string } }>('GET', `${A}/oauth/google/callback?code=c&state=${state}`, { host: ROBO, headers: JSON_ACCEPT, cookies: c });
    expect(cb.body.data.status).toBe('consent_required');
    return cb.body.data.pendingToken;
  }

  it('on → the challenge and no session; off → signed in', async () => {
    const res = await h.request<Challenge401>('POST', `${A}/oauth/complete`, { host: ROBO, body: { pendingToken: await pending(), consents: AGE } });
    const created = db.$rows('user').find((u) => u.email === 'two@example.test')!;
    expectChallenge(res, String(created.id), '/login/2fa?next=%2Fonboarding%2Fsituation');

    db.$rows('user').splice(1);
    db.$rows('rAAuthIdentity').length = 0;
    twoStep = 'off';
    const ok = await h.request<{ data: { status: string } }>('POST', `${A}/oauth/complete`, { host: ROBO, body: { pendingToken: await pending(), consents: AGE } });
    expect(ok.body.data).toMatchObject({ status: 'signed_in', isNewUser: true });
    expect(cookies(ok.headers)).toContain(`${SESSION_COOKIE_NAME}=sess-`);
  });
});
