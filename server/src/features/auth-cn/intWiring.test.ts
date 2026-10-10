// @vitest-environment node
//
// INT-01 wiring in the GoApply sign-in area (fake database / SMS / WeChat):
//   - two-step sign-in: every session these routes mint goes through the
//     second-factor gate (`issueSessionCookie`); an account with it on gets
//     401 `two_factor_required` (or a redirect to /login/2fa) and no session
//     cookie, an account without it signs in as before, and a failed check
//     signs nobody in;
//   - invite friends (R-60-3): the `ref` from a sign-up link reaches
//     growth.recordAttribution with the request's risk signals when a phone
//     or WeChat account is created, never for an existing account;
//   - the invite check runs after phone binding and after a WeChat link;
//   - the `phone_verified` practice credit is granted when a number is
//     verified at signup, bound later or changed, once per account;
//   - every one of those seams is soft.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getBrand } from '../../platform/brand/registry.js';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import { createMemoryCreditStore, createPracticeCredits } from '../../platform/credits/index.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { SESSION_COOKIE_NAME } from '../../lib/cookieOptions.js';
import { CHALLENGE_COOKIE, CHALLENGE_COOKIE_PATH, CHALLENGE_KIND, hashChallengeToken } from '../account-v2/index.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { createAuthCnServices } from './services.js';
import { routeAfterSignIn } from './accounts.js';
import { PHONE_VERIFIED_GRANT, afterAccountCreated, afterPhoneBound, afterWechatLinked, cleanRef, type AccountHooks } from './hooks.js';
import { createPhoneAuthRouter, createWechatAuthRouter, WECHAT_NONCE_COOKIE } from './routes.js';
import { BASE_ENV, buildServices, clock, CN0_CONSENTS, fakeDb, fakeWechatFetch, recordingHooks, recordingSms } from './__tests__/testkit.js';

const goapply = getBrand('goapply');
const GO = 'goapply.localhost:3621';
const PHONE_API = '/api/v1/roboapply/auth/phone';
const WX_API = '/api/v1/roboapply/auth/wechat';
const PHONE = '+8613812345678';
const OTHER_PHONE = '+8613912345678';
const SIGNALS = { ip: '203.0.113.50', userAgent: 'UA-friend', deviceId: 'anon_friend001' };

beforeAll(() => setFlagOverrideLoader(async () => []));
afterAll(() => setFlagOverrideLoader(null));

let harness: RouteHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

interface Env {
  success: boolean;
  code?: string;
  data?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

type Seed = Record<string, Array<Record<string, unknown>>>;

const phoneUser = (id: string, phone = PHONE, extra: Record<string, unknown> = {}) => ({
  id,
  email: `${id}@users.goapply.invalid`,
  emailIsPlaceholder: true,
  brand: 'goapply',
  phoneE164: phone,
  phoneVerifiedAt: new Date('2026-10-01T00:00:00Z'),
  createdAt: new Date('2026-10-01T00:00:00Z'),
  ...extra,
});
const profile = (userId: string, onboardingStep = 'done') => ({ id: `p_${userId}`, userId, onboardingStep });
/** Two-step sign-in turned on for a user (RATwoFactor row, confirmed). */
const twoFactorOn = (userId: string) => ({ userId, brand: 'goapply', secretSealed: 'sealed', enabledAt: new Date('2026-10-02T00:00:00Z'), lastUsedStep: 1, recoveryCodeHashes: [] });

async function start(opts: { seed?: Seed; env?: EnvSource; user?: { id: string } | null; codes?: Parameters<typeof fakeWechatFetch>[0]; phones?: Record<string, string>; brokenGate?: boolean } = {}) {
  const env = opts.env ?? BASE_ENV;
  const { fake, db } = fakeDb(opts.seed ?? {});
  const c = clock();
  const sms = recordingSms();
  const wx = fakeWechatFetch(opts.codes ?? {}, opts.phones ?? {});
  const recorded = recordingHooks();
  const services = buildServices({
    db,
    env,
    now: c.now,
    sms,
    fetch: wx.fetch,
    hooks: recorded.hooks,
    ...(opts.brokenGate
      ? {
          signInGate: () => {
            throw new Error('two-factor table unreachable');
          },
        }
      : {}),
  });
  const deps = {
    env,
    seekerAuth: [fakeAuth(opts.user ?? null)],
    optionalAuth: [(req: never, _res: never, next: () => void) => {
      if (opts.user) (req as { user?: unknown }).user = opts.user;
      next();
    }],
  };
  harness = await startRouteHarness({
    env,
    mounts: [
      [PHONE_API, createPhoneAuthRouter(deps as never, services)],
      [WX_API, createWechatAuthRouter(deps as never, services)],
    ],
  });
  const sendCode = (phoneE164: string, purpose: 'login' | 'bind', code: string) =>
    services.otp.sendCode({ brand: 'goapply', phoneE164, purpose, ip: '9.9.9.9', code });
  return { fake, c, services, harness, calls: recorded.calls, sendCode };
}

const setCookies = (headers: Headers) => headers.get('set-cookie') ?? '';

/** The answer POST /auth/login gives when a second factor is needed, and what must not have happened. */
function expectChallenge(res: { status: number; headers: Headers; body: Env }, fake: ReturnType<typeof fakeDb>['fake'], userId: string, next: string) {
  expect(res.status).toBe(401);
  expect(res.body).toMatchObject({ success: false, code: 'two_factor_required', details: { next, methods: ['totp', 'recovery'], expiresInSec: 300 } });
  expectChallengeCookie(res.headers, fake, userId);
}

function expectChallengeCookie(headers: Headers, fake: ReturnType<typeof fakeDb>['fake'], userId: string) {
  const set = setCookies(headers);
  expect(set).not.toContain(`${SESSION_COOKIE_NAME}=`);
  const token = new RegExp(`${CHALLENGE_COOKIE}=([^;]+)`).exec(set)?.[1];
  expect(token).toBeTruthy();
  expect(set).toMatch(/HttpOnly/i);
  expect(set).toContain(`Path=${CHALLENGE_COOKIE_PATH}`);
  // A single-use challenge for this user on this brand; only its hash is stored.
  const row = fake.$rows('rAAuthToken').find((r) => r.kind === CHALLENGE_KIND)!;
  expect(row).toMatchObject({ userId, brand: 'goapply', tokenHash: hashChallengeToken(decodeURIComponent(token!)) });
}

// ── Two-step sign-in ─────────────────────────────────────────────────────

describe('two-step sign-in on the phone and WeChat routes (2fa-gate:issue-session-cookie)', () => {
  it('phone code: an account with it on gets the challenge and no session; without it, the session as before', async () => {
    const on = await start({ seed: { user: [phoneUser('u1')], seekerProfile: [profile('u1')], rATwoFactor: [twoFactorOn('u1')] } });
    await on.sendCode(PHONE, 'login', '111111');
    const challenged = await on.harness.request<Env>('POST', `${PHONE_API}/verify`, { host: GO, body: { phone: '13812345678', code: '111111', next: '/jobs/cm1' } });
    expectChallenge(challenged, on.fake, 'u1', '/login/2fa?next=%2Fjobs%2Fcm1');
    await on.harness.close();

    const off = await start({ seed: { user: [phoneUser('u1')], seekerProfile: [profile('u1')] } });
    await off.sendCode(PHONE, 'login', '111111');
    const ok = await off.harness.request<Env>('POST', `${PHONE_API}/verify`, { host: GO, body: { phone: '13812345678', code: '111111' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ userId: 'u1', isNewUser: false });
    expect(setCookies(ok.headers)).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookies(ok.headers)).not.toContain(`${CHALLENGE_COOKIE}=`);
    expect(off.fake.$rows('rAAuthToken').some((r) => r.kind === CHALLENGE_KIND)).toBe(false);
  });

  it('a pending (unconfirmed) enrolment is not a second factor', async () => {
    const t = await start({ seed: { user: [phoneUser('u1')], seekerProfile: [profile('u1')], rATwoFactor: [{ ...twoFactorOn('u1'), enabledAt: null }] } });
    await t.sendCode(PHONE, 'login', '111111');
    const res = await t.harness.request<Env>('POST', `${PHONE_API}/verify`, { host: GO, body: { phone: '13812345678', code: '111111' } });
    expect(res.status).toBe(200);
    expect(setCookies(res.headers)).toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it('the check fails: 503 two_factor_unavailable and no session', async () => {
    const t = await start({ seed: { user: [phoneUser('u1')], seekerProfile: [profile('u1')] }, brokenGate: true });
    await t.sendCode(PHONE, 'login', '111111');
    const res = await t.harness.request<Env>('POST', `${PHONE_API}/verify`, { host: GO, body: { phone: '13812345678', code: '111111' } });
    expect([res.status, res.body.code]).toEqual([503, 'two_factor_unavailable']);
    expect(setCookies(res.headers)).not.toContain(`${SESSION_COOKIE_NAME}=`);
  });

  async function wechatStart(h: RouteHarness) {
    const res = await fetch(`${h.baseUrl}${WX_API}/qr?next=/jobs/cm1`, { redirect: 'manual', headers: { 'x-forwarded-host': GO } });
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    const nonce = new RegExp(`${WECHAT_NONCE_COOKIE}=([^;]+)`).exec(setCookies(res.headers))![1]!;
    return { state, nonce };
  }
  const wechatSeed = (extra: Seed = {}): Seed => ({
    user: [phoneUser('u1')],
    seekerProfile: [profile('u1')],
    rAAuthIdentity: [{ id: 'i1', userId: 'u1', brand: 'goapply', provider: 'wechat', appId: 'wx_open', subject: 'openid-1', unionId: null }],
    ...extra,
  });

  it('WeChat callback: on → 302 to /login/2fa with the challenge cookie; off → the usual return page with a session', async () => {
    const on = await start({ seed: wechatSeed({ rATwoFactor: [twoFactorOn('u1')] }), codes: { wxcode: { openid: 'openid-1' } } });
    const a = await wechatStart(on.harness);
    const challenged = await fetch(`${on.harness.baseUrl}${WX_API}/callback?code=wxcode&state=${a.state}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-host': GO, cookie: `${WECHAT_NONCE_COOKIE}=${a.nonce}` },
    });
    expect(challenged.status).toBe(302);
    expect(challenged.headers.get('location')).toBe('/login/2fa?next=%2Fjobs%2Fcm1');
    expectChallengeCookie(challenged.headers, on.fake, 'u1');
    await on.harness.close();

    const off = await start({ seed: wechatSeed(), codes: { wxcode: { openid: 'openid-1' } } });
    const b = await wechatStart(off.harness);
    const ok = await fetch(`${off.harness.baseUrl}${WX_API}/callback?code=wxcode&state=${b.state}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-host': GO, cookie: `${WECHAT_NONCE_COOKIE}=${b.nonce}` },
    });
    expect(ok.headers.get('location')).toBe('/auth/callback/wechat?result=ok&next=%2Fjobs%2Fcm1');
    expect(setCookies(ok.headers)).toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it('WeChat callback, the check fails: back to the return page with an error and no session', async () => {
    const t = await start({ seed: wechatSeed(), codes: { wxcode: { openid: 'openid-1' } }, brokenGate: true });
    const a = await wechatStart(t.harness);
    const res = await fetch(`${t.harness.baseUrl}${WX_API}/callback?code=wxcode&state=${a.state}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-host': GO, cookie: `${WECHAT_NONCE_COOKIE}=${a.nonce}` },
    });
    expect(res.headers.get('location')).toBe('/auth/callback/wechat?result=error&code=two_factor_unavailable');
    expect(setCookies(res.headers)).not.toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it('mini-program login: on → the challenge and no session token in the body', async () => {
    const seed = wechatSeed({ rATwoFactor: [twoFactorOn('u1')] });
    seed.rAAuthIdentity![0]!.appId = 'wx_mini';
    const t = await start({ seed, codes: { m1: { openid: 'openid-1' } } });
    const res = await t.harness.request<Env>('POST', `${WX_API}/mini/login`, { host: GO, body: { code: 'm1' } });
    // GoApply's first route after sign-in is the campus calendar by default (D5: on with no CN_ value).
    expectChallenge(res, t.fake, 'u1', '/login/2fa?next=%2Fcampus');
    expect(JSON.stringify(res.body)).not.toContain('sessionToken');
  });

  it('mini-program login: the first route is /resume only with both the campus calendar and the job feed switched off', async () => {
    const seed = () => {
      const rows = wechatSeed({ rATwoFactor: [twoFactorOn('u1')] });
      rows.rAAuthIdentity![0]!.appId = 'wx_mini';
      return rows;
    };
    let open: { close(): Promise<void> } | null = null;
    const login = async (env: Record<string, string>) => {
      // One server at a time; the last one is closed by the suite's afterEach.
      await open?.close();
      const t = await start({ seed: seed(), codes: { m1: { openid: 'openid-1' } }, env: { ...BASE_ENV, ...env } });
      open = t.harness;
      const res = await t.harness.request<Env>('POST', `${WX_API}/mini/login`, { host: GO, body: { code: 'm1' } });
      return (res.body.details as { next?: string } | undefined)?.next;
    };
    await expect(login({ CN_CAMPUS_CALENDAR_ENABLED: 'false', CN_RECRUITMENT_INFO_MODE: 'off' })).resolves.toBe('/login/2fa?next=%2Fresume');
    // One switch alone leaves the other surface as the first route.
    await expect(login({ CN_CAMPUS_CALENDAR_ENABLED: 'false' })).resolves.toBe('/login/2fa?next=%2Fjobs');
    await expect(login({ CN_RECRUITMENT_INFO_MODE: 'off' })).resolves.toBe('/login/2fa?next=%2Fcampus');
  });

  it('bind that merges into the account owning the number: that account’s two-step sign-in still applies', async () => {
    const t = await start({
      seed: {
        user: [phoneUser('owner'), phoneUser('fresh', '', { phoneE164: null, phoneVerifiedAt: null, createdAt: new Date('2026-10-10T07:00:00Z') })],
        seekerProfile: [profile('owner'), profile('fresh', 'account')],
        rAAuthIdentity: [{ id: 'i1', userId: 'fresh', brand: 'goapply', provider: 'wechat', appId: 'wx_open', subject: 'openid-9', unionId: null }],
        rATwoFactor: [twoFactorOn('owner')],
      },
      user: { id: 'fresh' },
    });
    await t.sendCode(PHONE, 'bind', '222222');
    const res = await t.harness.request<Env>('POST', `${PHONE_API}/bind`, { host: GO, body: { phone: '13812345678', code: '222222' } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('two_factor_required');
    expectChallengeCookie(res.headers, t.fake, 'owner');
  });
});

// ── Invite friends, invite check, phone credit ───────────────────────────

describe('invite attribution at GoApply sign-up (R-60-3)', () => {
  it('phone sign-up: the ref and this request’s signals reach growth; a verified number grants the phone credit', async () => {
    const t = await start();
    await t.sendCode(PHONE, 'login', '111111');
    const res = await t.harness.request<Env>('POST', `${PHONE_API}/verify`, {
      host: GO,
      headers: { 'user-agent': 'UA-friend', 'x-forwarded-for': '203.0.113.50' },
      cookies: { ra_anon: 'anon_friend001' },
      body: { phone: '13812345678', code: '111111', consents: CN0_CONSENTS, ref: ' GGGG-GGGG ' },
    });
    expect(res.status).toBe(200);
    const userId = String(res.body.data!.userId);
    expect(t.calls.attribution).toHaveLength(1);
    expect(t.calls.attribution[0]).toMatchObject({
      userId,
      touch: { ref: 'GGGG-GGGG', at: t.c.now().toISOString() },
      options: { signals: { ip: '203.0.113.50', userAgent: 'UA-friend', deviceId: 'anon_friend001' } },
    });
    // Functional attribution only: no marketing field is sent on this path.
    expect(Object.keys(t.calls.attribution[0]!.touch).sort()).toEqual(['at', 'ref']);
    expect(t.calls.phoneCredits).toEqual([userId]);
  });

  it('an existing number signing in records nothing (the ref of a link opened later is not an invite)', async () => {
    const t = await start({ seed: { user: [phoneUser('u1')], seekerProfile: [profile('u1')] } });
    await t.sendCode(PHONE, 'login', '111111');
    const res = await t.harness.request<Env>('POST', `${PHONE_API}/verify`, { host: GO, body: { phone: '13812345678', code: '111111', ref: 'GGGGGGGG' } });
    expect(res.status).toBe(200);
    expect(t.calls.attribution).toEqual([]);
    expect(t.calls.phoneCredits).toEqual([]);
  });

  it('no ref → no attribution call; the phone credit is still granted', async () => {
    const { fake, db } = fakeDb();
    const c = clock();
    const recorded = recordingHooks();
    const s = buildServices({ db, now: c.now, sms: recordingSms(), hooks: recorded.hooks });
    await s.otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '9.9.9.9', code: '111111' });
    const r = await s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: CN0_CONSENTS, ip: '1.1.1.1', signals: SIGNALS });
    expect(recorded.calls.attribution).toEqual([]);
    expect(recorded.calls.phoneCredits).toEqual([r.userId]);
    expect(fake.$rows('user')).toHaveLength(1);
  });

  it('WeChat sign-up: the ref rides the POST start body into the state and is attached at the callback with its signals', async () => {
    const t = await start({ codes: { wxnew: { openid: 'openid-new' } } });
    const startRes = await t.harness.request<Env>('POST', `${WX_API}/start`, { host: GO, body: { flow: 'web', consents: CN0_CONSENTS, ref: 'GGGGGGGG' } });
    expect(startRes.status).toBe(200);
    const state = new URL(String(startRes.body.data!.url)).searchParams.get('state')!;
    const nonce = new RegExp(`${WECHAT_NONCE_COOKIE}=([^;]+)`).exec(setCookies(startRes.headers))![1]!;
    const cb = await fetch(`${t.harness.baseUrl}${WX_API}/callback?code=wxnew&state=${state}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-host': GO, 'user-agent': 'UA-friend', 'x-forwarded-for': '203.0.113.50', cookie: `${WECHAT_NONCE_COOKIE}=${nonce}; ra_anon=anon_friend001` },
    });
    expect(cb.headers.get('location')).toContain('result=ok');
    const created = t.fake.$rows('user')[0]!;
    expect(t.calls.attribution).toEqual([
      expect.objectContaining({
        userId: created.id,
        touch: expect.objectContaining({ ref: 'GGGGGGGG' }),
        options: { signals: { ip: '203.0.113.50', userAgent: 'UA-friend', deviceId: 'anon_friend001' } },
      }),
    ]);
    // No number yet: no phone credit until one is bound.
    expect(t.calls.phoneCredits).toEqual([]);
  });

  it('a GET start (returning users, shared links) never carries a ref', async () => {
    const t = await start({ codes: { wxnew: { openid: 'openid-new' } } });
    const res = await fetch(`${t.harness.baseUrl}${WX_API}/qr?ref=GGGGGGGG`, { redirect: 'manual', headers: { 'x-forwarded-host': GO } });
    expect(res.status).toBe(422);
  });

  it('mini-program sign-up with a verified number: ref attached and the phone credit granted', async () => {
    const t = await start({ codes: { m1: { openid: 'openid-m' } }, phones: { pc1: '13912345678' } });
    const res = await t.harness.request<Env>('POST', `${WX_API}/mini/login`, { host: GO, body: { code: 'm1', phoneCode: 'pc1', consents: CN0_CONSENTS, ref: 'GGGGGGGG' } });
    expect(res.status).toBe(200);
    const userId = String(res.body.data!.userId);
    expect(t.calls.attribution).toEqual([expect.objectContaining({ userId, touch: expect.objectContaining({ ref: 'GGGGGGGG' }) })]);
    expect(t.calls.phoneCredits).toEqual([userId]);
  });
});

describe('after a phone is bound or changed, and after a WeChat link', () => {
  it('bind: the phone credit, then the invite check', async () => {
    const t = await start({
      seed: { user: [phoneUser('u1', '', { phoneE164: null, phoneVerifiedAt: null })], seekerProfile: [profile('u1')] },
      user: { id: 'u1' },
    });
    await t.sendCode(PHONE, 'bind', '222222');
    const res = await t.harness.request<Env>('POST', `${PHONE_API}/bind`, { host: GO, body: { phone: '13812345678', code: '222222' } });
    expect(res.status).toBe(200);
    expect(t.calls.phoneCredits).toEqual(['u1']);
    expect(t.calls.referralChecks).toEqual(['u1']);
  });

  it('the credit is granted once per account: binding, then changing the number, grants nothing more', async () => {
    // The real practice-credit ledger on an in-memory store: the key is `phone_verified`.
    const adjusted: number[] = [];
    const credits = createPracticeCredits({
      store: createMemoryCreditStore(),
      hasSeekerProfile: async () => true,
      adjust: async ({ delta }) => {
        adjusted.push(delta);
        return { balanceAfter: adjusted.length };
      },
    });
    const results: string[] = [];
    const hooks: AccountHooks = {
      recordAttribution: async () => undefined,
      checkReferral: async () => undefined,
      grantPhoneCredit: async (userId) => {
        const r = await credits.grantPracticeCredit(userId, PHONE_VERIFIED_GRANT, PHONE_VERIFIED_GRANT);
        results.push(r.status);
        return r;
      },
    };
    const { fake, db } = fakeDb({ user: [phoneUser('u1', '', { phoneE164: null, phoneVerifiedAt: null })], seekerProfile: [profile('u1')] });
    const c = clock();
    const s = buildServices({ db, now: c.now, sms: recordingSms(), hooks });
    const send = (phoneE164: string, purpose: 'bind' | 'change_old' | 'change_new', code: string) =>
      s.otp.sendCode({ brand: 'goapply', phoneE164, purpose, ip: `9.9.9.${Math.floor(Math.random() * 250)}`, code });

    await send(PHONE, 'bind', '111111');
    await s.phone.bind({ brand: goapply, userId: 'u1', phoneE164: PHONE, code: '111111', ip: '1.1.1.1' });
    c.advance(61_000); // one code per number per minute
    await send(PHONE, 'change_old', '222222');
    await send(OTHER_PHONE, 'change_new', '333333');
    await s.phone.change({ brand: goapply, userId: 'u1', oldCode: '222222', newPhoneE164: OTHER_PHONE, newCode: '333333', keepSessionToken: null, ip: '1.1.1.1' });
    expect(fake.$rows('user')[0]!.phoneE164).toBe(OTHER_PHONE);
    expect(results).toEqual(['granted', 'already_granted']);
    expect(adjusted).toEqual([1]);
  });

  it('WeChat: a second WeChat app linked by unionid checks the invite', async () => {
    const t = await start({
      seed: {
        user: [phoneUser('u1')],
        seekerProfile: [profile('u1')],
        rAAuthIdentity: [{ id: 'i1', userId: 'u1', brand: 'goapply', provider: 'wechat', appId: 'wx_mp', subject: 'mp-openid', unionId: 'union-1' }],
      },
      codes: { m1: { openid: 'mini-openid', unionid: 'union-1' } },
    });
    const res = await t.harness.request<Env>('POST', `${WX_API}/mini/login`, { host: GO, body: { code: 'm1' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ userId: 'u1', isNewUser: false });
    expect(t.calls.referralChecks).toEqual(['u1']);
    expect(t.calls.attribution).toEqual([]);
    // Signing in again with the now-linked app links nothing and checks nothing.
    await t.harness.request<Env>('POST', `${WX_API}/mini/login`, { host: GO, body: { code: 'm1' } });
    expect(t.calls.referralChecks).toEqual(['u1']);
  });

  it('mini-program login that attaches a WeChat-verified number to a WeChat-only account: credit and invite check', async () => {
    const t = await start({
      seed: {
        user: [phoneUser('u1', '', { phoneE164: null, phoneVerifiedAt: null })],
        seekerProfile: [profile('u1')],
        rAAuthIdentity: [{ id: 'i1', userId: 'u1', brand: 'goapply', provider: 'wechat', appId: 'wx_mini', subject: 'mini-openid', unionId: null }],
      },
      codes: { m1: { openid: 'mini-openid' } },
      phones: { pc1: '13812345678' },
    });
    const res = await t.harness.request<Env>('POST', `${WX_API}/mini/login`, { host: GO, body: { code: 'm1', phoneCode: 'pc1' } });
    expect(res.status).toBe(200);
    expect(t.fake.$rows('user')[0]!.phoneE164).toBe(PHONE);
    expect(t.calls.phoneCredits).toEqual(['u1']);
    expect(t.calls.referralChecks).toEqual(['u1']);
  });
});

describe('bind that merges a new WeChat account into the number’s account', () => {
  const mergeSeed = (): Seed => ({
    user: [phoneUser('owner'), phoneUser('fresh', '', { phoneE164: null, phoneVerifiedAt: null, createdAt: new Date('2026-10-10T07:00:00Z') })],
    seekerProfile: [profile('owner'), profile('fresh', 'account')],
    rAAuthIdentity: [{ id: 'i1', userId: 'fresh', brand: 'goapply', provider: 'wechat', appId: 'wx_open', subject: 'openid-9', unionId: null }],
  });

  it('the WeChat identity moves to the owner: that is a WeChat link, so the owner’s invite is checked', async () => {
    const t = await start({ seed: mergeSeed(), user: { id: 'fresh' } });
    await t.sendCode(PHONE, 'bind', '222222');
    const res = await t.harness.request<Env>('POST', `${PHONE_API}/bind`, { host: GO, body: { phone: '13812345678', code: '222222' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ userId: 'owner', merged: true });
    expect(t.fake.$rows('rAAuthIdentity')[0]!.userId).toBe('owner');
    expect(t.calls.referralChecks).toEqual(['owner']);
    // The owner's number was verified long ago: no second phone credit, no attribution.
    expect(t.calls.phoneCredits).toEqual([]);
    expect(t.calls.attribution).toEqual([]);
  });

  it('a failing invite check never fails the merge', async () => {
    const { fake, db } = fakeDb(mergeSeed());
    const c = clock();
    const s = buildServices({
      db,
      now: c.now,
      sms: recordingSms(),
      hooks: {
        recordAttribution: async () => undefined,
        checkReferral: async () => Promise.reject(new Error('growth down')),
        grantPhoneCredit: async () => undefined,
      },
    });
    await s.otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'bind', ip: '9.9.9.3', code: '222222' });
    await expect(s.phone.bind({ brand: goapply, userId: 'fresh', phoneE164: PHONE, code: '222222', ip: '1.1.1.1' })).resolves.toMatchObject({ userId: 'owner', merged: true });
    expect(fake.$rows('user').map((u) => u.id)).toEqual(['owner']);
  });
});

// ── A `next` to a free-tool page (WP-57: "create an account to keep this result") ──

describe('next=/tools/* wins over unfinished onboarding on GoApply’s own methods', () => {
  it('phone sign-up: a new account lands on the tool page; any other next waits for onboarding', async () => {
    const t = await start();
    await t.sendCode(PHONE, 'login', '111111');
    const tool = await t.harness.request<Env>('POST', `${PHONE_API}/verify`, {
      host: GO,
      body: { phone: '13812345678', code: '111111', consents: CN0_CONSENTS, next: '/tools/resume-check' },
    });
    expect(tool.status).toBe(200);
    expect(tool.body.data).toMatchObject({ isNewUser: true, nextRoute: '/tools/resume-check' });

    await t.sendCode(OTHER_PHONE, 'login', '333333');
    const other = await t.harness.request<Env>('POST', `${PHONE_API}/verify`, {
      host: GO,
      body: { phone: '13912345678', code: '333333', consents: CN0_CONSENTS, next: '/jobs/cm1' },
    });
    expect(other.status).toBe(200);
    expect(other.body.data!.isNewUser).toBe(true);
    expect(other.body.data!.nextRoute).not.toBe('/jobs/cm1');
    expect(String(other.body.data!.nextRoute)).not.toContain('/tools/');
  });

  it('phone sign-in: an account still in onboarding lands on the tool page (query kept); an off-site next never does', async () => {
    const t = await start({ seed: { user: [phoneUser('u1')], seekerProfile: [profile('u1', 'resume')] } });
    await t.sendCode(PHONE, 'login', '111111');
    const ok = await t.harness.request<Env>('POST', `${PHONE_API}/verify`, { host: GO, body: { phone: '13812345678', code: '111111', next: '/tools/resume-job-match?claim=1' } });
    expect(ok.body.data).toMatchObject({ isNewUser: false, nextRoute: '/tools/resume-job-match?claim=1' });

    // The rule itself: only a same-site free-tool path jumps the queue.
    await expect(routeAfterSignIn(goapply, BASE_ENV, 'resume', '/tools/resume-check/')).resolves.toBe('/tools/resume-check/');
    for (const next of ['//evil.example/tools/resume-check', '/tools', '/tools/resume-check/other', '/jobs/cm1', null]) {
      const route = await routeAfterSignIn(goapply, BASE_ENV, 'resume', next);
      expect(route).not.toContain('evil.example');
      expect(route).not.toContain('/tools');
      expect(route).not.toBe('/jobs/cm1');
    }
    // Onboarding done: any same-site next is honoured, as before.
    await expect(routeAfterSignIn(goapply, BASE_ENV, 'done', '/jobs/cm1')).resolves.toBe('/jobs/cm1');
  });

  it('WeChat sign-up: the next from the start body survives the round trip and the callback lands on the tool page', async () => {
    const t = await start({ codes: { wxnew: { openid: 'openid-new' } } });
    const startRes = await t.harness.request<Env>('POST', `${WX_API}/start`, { host: GO, body: { flow: 'web', consents: CN0_CONSENTS, next: '/tools/resume-check' } });
    expect(startRes.status).toBe(200);
    const state = new URL(String(startRes.body.data!.url)).searchParams.get('state')!;
    const nonce = new RegExp(`${WECHAT_NONCE_COOKIE}=([^;]+)`).exec(setCookies(startRes.headers))![1]!;
    const cb = await fetch(`${t.harness.baseUrl}${WX_API}/callback?code=wxnew&state=${state}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-host': GO, cookie: `${WECHAT_NONCE_COOKIE}=${nonce}` },
    });
    const location = new URL(cb.headers.get('location')!, 'http://x');
    expect(location.searchParams.get('result')).toBe('ok');
    expect(location.searchParams.get('next')).toBe('/tools/resume-check');
    expect(t.fake.$rows('user')).toHaveLength(1);
  });
});

describe('the seams are soft', () => {
  const failing: AccountHooks = {
    recordAttribution: async () => Promise.reject(new Error('growth down')),
    checkReferral: async () => Promise.reject(new Error('growth down')),
    grantPhoneCredit: async () => Promise.reject(new Error('credits down')),
  };

  it('a failing growth or credit seam never fails sign-up, bind or change', async () => {
    const { fake, db } = fakeDb({ user: [phoneUser('wx', '', { phoneE164: null, phoneVerifiedAt: null })], seekerProfile: [profile('wx')] });
    const c = clock();
    const s = buildServices({ db, now: c.now, sms: recordingSms(), hooks: failing });
    await s.otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '9.9.9.1', code: '111111' });
    await expect(
      s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: CN0_CONSENTS, ip: '1.1.1.1', ref: 'GGGGGGGG', signals: SIGNALS }),
    ).resolves.toMatchObject({ isNewUser: true });
    await s.otp.sendCode({ brand: 'goapply', phoneE164: OTHER_PHONE, purpose: 'bind', ip: '9.9.9.2', code: '222222' });
    await expect(s.phone.bind({ brand: goapply, userId: 'wx', phoneE164: OTHER_PHONE, code: '222222', ip: '1.1.1.1' })).resolves.toMatchObject({ merged: false });
    expect(fake.$rows('user').find((u) => u.id === 'wx')!.phoneE164).toBe(OTHER_PHONE);
  });

  it('helpers: nothing runs without hooks; refs are cleaned; errors are swallowed', async () => {
    await expect(afterAccountCreated(undefined, 'u', { ref: 'X', phoneVerified: true, now: new Date() })).resolves.toBeUndefined();
    await expect(afterAccountCreated(failing, 'u', { ref: 'GGGGGGGG', signals: SIGNALS, phoneVerified: true, now: new Date() })).resolves.toBeUndefined();
    await expect(afterPhoneBound(failing, 'u')).resolves.toBeUndefined();
    await expect(afterWechatLinked(failing, 'u')).resolves.toBeUndefined();
    expect(cleanRef('  abcd-efgh \u0000')).toBe('abcd-efgh');
    expect(cleanRef('x'.repeat(100))).toHaveLength(64);
    expect(cleanRef('   ')).toBeNull();
    expect(cleanRef(null)).toBeNull();
  });

  it('services built on an injected database run no production seam unless hooks are passed', async () => {
    const { db } = fakeDb();
    const c = clock();
    // No hooks option: the growth and credit modules are never loaded for a test database.
    const s = createAuthCnServices({ db, env: BASE_ENV, now: c.now, sms: recordingSms(), consume: async () => ({ allowed: true, retryAfterSec: 0, remaining: 1, windows: [] }) });
    await s.otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '9.9.9.3', code: '111111' });
    await expect(s.phone.verifyAndSignIn({ brand: goapply, phoneE164: PHONE, code: '111111', consents: CN0_CONSENTS, ip: '1.1.1.1', ref: 'GGGGGGGG' })).resolves.toMatchObject({
      isNewUser: true,
    });
  });
});
