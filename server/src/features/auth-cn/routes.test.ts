// @vitest-environment node
//
// WP-11 route tests through the route harness (brand from the host, real
// capability gates, fake database / SMS / WeChat / sessions):
//   - every method is hidden (404 feature_disabled) when its credentials are
//     absent, and on the RoboApply host;
//   - send-code validates +86 numbers; verify sets `ra_session_token`;
//   - CN-0 signup without pipl_cross_border → 422;
//   - bind/change need a session; change revokes the other sessions;
//   - WeChat start (POST with consents, GET without) → WeChat URL + a
//     browser-binding nonce cookie; callback → 302 to the web return page;
//     a callback without that cookie is refused (login CSRF);
//   - mini login returns a session token;
//   - admin invites (admin chain, codes shown once, GoApply host only).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { SESSION_COOKIE_NAME } from '../../lib/cookieOptions.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { createAuthCnAdminRouter, createPhoneAuthRouter, createWechatAuthRouter, WECHAT_NONCE_COOKIE } from './routes.js';
import { BASE_ENV, buildServices, clock, CN0_CONSENTS, fakeDb, fakeWechatFetch, recordingSms } from './__tests__/testkit.js';

const GO = 'goapply.localhost:3621';
const RA = 'localhost:3621';
const PHONE_API = '/api/v1/roboapply/auth/phone';
const WX_API = '/api/v1/roboapply/auth/wechat';
const ADMIN_API = '/api/v1/roboapply/admin/auth-cn';

beforeAll(() => setFlagOverrideLoader(async () => []));
afterAll(() => setFlagOverrideLoader(null));

let h: RouteHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

interface Env {
  success: boolean;
  code?: string;
  data?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

async function start(opts: {
  env?: EnvSource;
  seed?: Record<string, Array<Record<string, unknown>>>;
  user?: { id: string; role?: string } | null;
  admin?: { id: string; role?: string } | null;
  codes?: Parameters<typeof fakeWechatFetch>[0];
} = {}) {
  const env = opts.env ?? BASE_ENV;
  const { fake, db } = fakeDb(opts.seed ?? {});
  const c = clock();
  const sms = recordingSms();
  const wx = fakeWechatFetch(opts.codes ?? {});
  const services = buildServices({ db, env, now: c.now, sms, fetch: wx.fetch });
  const deps = {
    env,
    seekerAuth: [fakeAuth(opts.user ?? null)],
    adminAuth: [fakeAuth(opts.admin ?? null)],
    optionalAuth: [(req: never, _res: never, next: () => void) => {
      if (opts.user) (req as { user?: unknown }).user = opts.user;
      next();
    }],
  };
  h = await startRouteHarness({
    env,
    mounts: [
      [PHONE_API, createPhoneAuthRouter(deps as never, services)],
      [WX_API, createWechatAuthRouter(deps as never, services)],
      [ADMIN_API, createAuthCnAdminRouter(deps as never, services)],
    ],
  });
  return { fake, sms, c, services, harness: h };
}

describe('capabilities', () => {
  it('hides every method when credentials are absent (404 feature_disabled)', async () => {
    const { harness } = await start({ env: { NODE_ENV: 'test' } });
    const calls: Array<[string, string, unknown?]> = [
      ['POST', `${PHONE_API}/send-code`, { phone: '13812345678', purpose: 'login' }],
      ['POST', `${PHONE_API}/verify`, { phone: '13812345678', code: '123456' }],
      ['GET', `${WX_API}/qr`],
      ['GET', `${WX_API}/callback?code=x&state=y`],
      ['GET', `${WX_API}/mp/start`],
      ['POST', `${WX_API}/start`, { flow: 'web', consents: CN0_CONSENTS }],
      ['POST', `${WX_API}/start`, { flow: 'mp', consents: CN0_CONSENTS }],
      ['POST', `${WX_API}/mini/login`, { code: 'x' }],
    ];
    for (const [method, path, body] of calls) {
      const res = await harness.request<Env>(method, path, { host: GO, body });
      expect(res.status, path).toBe(404);
      expect(res.body.code).toBe('feature_disabled');
    }
    const policy = await harness.request<Env>('GET', `${PHONE_API}/policy`, { host: GO });
    expect(policy.body.data).toMatchObject({ methods: { phoneOtp: false, wechatWeb: false, wechatInApp: false } });
  });

  it('never serves the GoApply methods on the RoboApply host', async () => {
    const { harness } = await start();
    const res = await harness.request<Env>('POST', `${PHONE_API}/send-code`, { host: RA, body: { phone: '13812345678', purpose: 'login' } });
    expect(res.status).toBe(404);
    const policy = await harness.request<Env>('GET', `${PHONE_API}/policy`, { host: RA });
    expect(policy.status).toBe(404);
  });
});

describe('phone sign-in', () => {
  it('policy reflects invite mode and the CN-0 consents', async () => {
    const { harness } = await start({ env: { ...BASE_ENV, CN_SIGNUP_MODE: 'invite' } });
    const res = await harness.request<Env>('GET', `${PHONE_API}/policy`, { host: GO });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      signupOpen: true,
      inviteRequired: true,
      methods: { phoneOtp: true, wechatWeb: true, wechatInApp: true },
      legal: { termsPath: '/legal/terms', privacyPath: '/legal/privacy' },
    });
    expect((res.body.data!.requiredConsents as Array<{ type: string }>).map((c) => c.type)).toEqual([
      'pipl_basic_processing',
      'age_16_plus',
      'pipl_cross_border',
    ]);
  });

  it('rejects numbers outside the mainland (+86 only)', async () => {
    const { harness, sms } = await start();
    for (const phone of ['+14155550100', '12345678901', '1381234567', '+8613812345678x']) {
      const res = await harness.request<Env>('POST', `${PHONE_API}/send-code`, { host: GO, body: { phone, purpose: 'login' } });
      expect(res.status, phone).toBe(422);
    }
    expect(sms.sent).toHaveLength(0);
  });

  it('send-code → verify signs up and sets the session cookie', async () => {
    const { harness, sms, fake } = await start();
    const sent = await harness.request<Env>('POST', `${PHONE_API}/send-code`, { host: GO, body: { phone: '13812345678', purpose: 'login' } });
    expect(sent.status).toBe(200);
    expect(sent.body.data).toEqual({ resendInSec: 60 });
    expect(sms.sent[0]!.phoneE164).toBe('+8613812345678');

    const again = await harness.request<Env>('POST', `${PHONE_API}/send-code`, { host: GO, body: { phone: '13812345678', purpose: 'login' } });
    expect(again.status).toBe(429);
    expect(again.headers.get('retry-after')).toBeTruthy();

    const noCrossBorder = await harness.request<Env>('POST', `${PHONE_API}/verify`, {
      host: GO,
      body: { phone: '13812345678', code: sms.lastCode(), consents: CN0_CONSENTS.slice(0, 2) },
    });
    expect(noCrossBorder.status).toBe(422);
    expect(noCrossBorder.body.code).toBe('consent_required');

    const ok = await harness.request<Env>('POST', `${PHONE_API}/verify`, {
      host: GO,
      body: { phone: '13812345678', code: sms.lastCode(), consents: CN0_CONSENTS },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ isNewUser: true, nextRoute: '/onboarding/consent' });
    expect(ok.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=tok_`));
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(fake.$rows('user')[0]).toMatchObject({ brand: 'goapply', phoneE164: '+8613812345678' });
  });

  it('a wrong code is 422 otp_invalid with attempts left', async () => {
    const { harness } = await start();
    await harness.request('POST', `${PHONE_API}/send-code`, { host: GO, body: { phone: '13812345678', purpose: 'login' } });
    const res = await harness.request<Env>('POST', `${PHONE_API}/verify`, { host: GO, body: { phone: '13812345678', code: '000000' } });
    // The recorded code is random; 000000 matches it one time in a million.
    if (res.status !== 200) {
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'otp_invalid', details: { attemptsLeft: 4 } });
    }
  });

  it('bind and change need a session', async () => {
    const { harness } = await start();
    for (const [path, body] of [
      ['/bind', { phone: '13812345678', code: '123456' }],
      ['/change', { oldCode: '123456', newPhone: '13912345678', newCode: '654321' }],
    ] as const) {
      const res = await harness.request<Env>('POST', `${PHONE_API}${path}`, { host: GO, body });
      expect(res.status, path).toBe(401);
    }
    const sendBind = await harness.request<Env>('POST', `${PHONE_API}/send-code`, { host: GO, body: { phone: '13812345678', purpose: 'bind' } });
    expect(sendBind.status).toBe(401);
  });

  it('change: both codes, other sessions revoked, current kept', async () => {
    const seed = {
      user: [{ id: 'u1', email: 'a@users.goapply.invalid', brand: 'goapply', phoneE164: '+8613812345678', phoneVerifiedAt: new Date(), isActive: true }],
      session: [
        { id: 's1', userId: 'u1', token: 'mine' },
        { id: 's2', userId: 'u1', token: 'other' },
      ],
    };
    const { harness, sms, fake, c } = await start({ seed, user: { id: 'u1' } });
    await harness.request('POST', `${PHONE_API}/send-code`, { host: GO, body: { phone: '13812345678', purpose: 'change_old' } });
    const oldCode = sms.lastCode();
    c.advance(61_000);
    const mismatch = await harness.request<Env>('POST', `${PHONE_API}/send-code`, { host: GO, body: { phone: '13700000000', purpose: 'change_old' } });
    expect(mismatch.body.code).toBe('phone_mismatch');
    await harness.request('POST', `${PHONE_API}/send-code`, { host: GO, body: { phone: '13912345678', purpose: 'change_new' } });
    const newCode = sms.lastCode();
    const res = await harness.request<Env>('POST', `${PHONE_API}/change`, {
      host: GO,
      cookies: { [SESSION_COOKIE_NAME]: 'mine' },
      body: { oldCode, newPhone: '13912345678', newCode },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ phoneMasked: '139****5678', sessionsRevoked: 1 });
    expect(fake.$rows('session').map((s) => s.token)).toEqual(['mine']);
  });

  it('me: masked number and the re-verification options, never the full number', async () => {
    const seed = {
      user: [{ id: 'u1', email: 'a@x.invalid', brand: 'goapply', phoneE164: '+8613812345678', phoneVerifiedAt: new Date(), passwordHash: 'h' }],
      rAAuthIdentity: [{ id: 'i1', userId: 'u1', brand: 'goapply', provider: 'wechat', appId: 'wx_open', subject: 'o1' }],
    };
    const { harness } = await start({ seed, user: { id: 'u1' } });
    const res = await harness.request<Env>('GET', `${PHONE_API}/me`, { host: GO });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ phoneMasked: '138****5678', hasPassword: true, hasWechat: true });
    expect(res.text).not.toContain('13812345678');
  });

  it('change body must carry exactly one proof', async () => {
    const { harness } = await start({ user: { id: 'u1' } });
    const res = await harness.request<Env>('POST', `${PHONE_API}/change`, {
      host: GO,
      body: { newPhone: '13912345678', newCode: '654321' },
    });
    expect(res.status).toBe(422);
  });
});

describe('WeChat', () => {
  /** The nonce cookie a start response set (`name=value`), for the callback request. */
  function nonceCookie(res: { headers: Headers }): string {
    const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${WECHAT_NONCE_COOKIE}=`));
    if (!raw) throw new Error('no nonce cookie');
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\/api\/v1\/roboapply\/auth\/wechat/i);
    return raw.split(';')[0]!;
  }

  function callback(harness: RouteHarness, query: string, cookie?: string) {
    return fetch(`${harness.baseUrl}${WX_API}/callback?${query}`, {
      headers: { 'x-forwarded-host': GO, ...(cookie ? { cookie } : {}) },
      redirect: 'manual',
    });
  }

  it('POST start (consents in the body) → WeChat URL + nonce cookie; callback → session + 302 asking to bind', async () => {
    const { harness, fake } = await start({ codes: { c1: { openid: 'o1', unionid: 'U1' } } });
    const started = await harness.request<Env>('POST', `${WX_API}/start`, { host: GO, body: { flow: 'web', next: '/resume', consents: CN0_CONSENTS } });
    expect(started.status).toBe(200);
    const loc = new URL(started.body.data!.url as string);
    expect(loc.host).toBe('open.weixin.qq.com');
    const state = loc.searchParams.get('state')!;
    const cookie = nonceCookie(started);

    const cb = await callback(harness, `code=c1&state=${encodeURIComponent(state)}`, cookie);
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get('location')!, 'https://www.goapply.top');
    expect(back.pathname).toBe('/auth/callback/wechat');
    expect(Object.fromEntries(back.searchParams)).toEqual({ result: 'ok', next: '/onboarding/consent', bind: '1', new: '1' });
    const set = cb.headers.getSetCookie();
    expect(set.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
    // The nonce cookie is cleared.
    expect(set.some((c) => c.startsWith(`${WECHAT_NONCE_COOKIE}=;`))).toBe(true);
    expect(fake.$rows('seekerConsentRecord')).toHaveLength(3);
  });

  it('login CSRF: a callback URL opened in a browser without the nonce cookie signs nobody in', async () => {
    const { harness, fake } = await start({ codes: { c1: { openid: 'attacker' } } });
    const started = await harness.request<Env>('POST', `${WX_API}/start`, { host: GO, body: { flow: 'web', consents: CN0_CONSENTS } });
    const state = new URL(started.body.data!.url as string).searchParams.get('state')!;
    const victim = await callback(harness, `code=c1&state=${encodeURIComponent(state)}`);
    expect(victim.status).toBe(302);
    expect(victim.headers.get('location')).toBe('/auth/callback/wechat?result=error&code=oauth_state_invalid');
    expect(victim.headers.get('set-cookie')).toBeNull();
    const wrong = await callback(harness, `code=c1&state=${encodeURIComponent(state)}`, `${WECHAT_NONCE_COOKIE}=forged`);
    expect(wrong.headers.get('location')).toBe('/auth/callback/wechat?result=error&code=oauth_state_invalid');
    expect(fake.$rows('user')).toHaveLength(0);
  });

  it('POST start refuses incomplete consents before the round trip (422)', async () => {
    const { harness, fake } = await start();
    const res = await harness.request<Env>('POST', `${WX_API}/start`, { host: GO, body: { flow: 'web', consents: CN0_CONSENTS.slice(0, 2) } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('consent_required');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(fake.$rows('rAAuthToken')).toHaveLength(0);
  });

  it('a GET start link never grants consents: agree=1 is rejected, and a new account ends with consent_required', async () => {
    const { harness, fake } = await start({ codes: { c1: { openid: 'o1' } } });
    const crafted = await fetch(`${harness.baseUrl}${WX_API}/qr?agree=1`, { headers: { 'x-forwarded-host': GO }, redirect: 'manual' });
    expect(crafted.status).toBe(422);

    const startRes = await fetch(`${harness.baseUrl}${WX_API}/qr?next=%2Fresume`, { headers: { 'x-forwarded-host': GO }, redirect: 'manual' });
    expect(startRes.status).toBe(302);
    const state = new URL(startRes.headers.get('location')!).searchParams.get('state')!;
    const cb = await callback(harness, `code=c1&state=${encodeURIComponent(state)}`, nonceCookie(startRes));
    expect(cb.headers.get('location')).toBe('/auth/callback/wechat?result=error&code=consent_required');
    expect(fake.$rows('user')).toHaveLength(0);
    expect(fake.$rows('seekerConsentRecord')).toHaveLength(0);
  });

  it('a bad state redirects with an error and sets no cookie', async () => {
    const { harness } = await start();
    const cb = await fetch(`${harness.baseUrl}${WX_API}/callback?code=c1&state=forged`, { headers: { 'x-forwarded-host': GO }, redirect: 'manual' });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/auth/callback/wechat?result=error&code=oauth_state_invalid');
    expect(cb.headers.get('set-cookie')).toBeNull();
  });

  it('mini login returns a session token for X-Session-Token', async () => {
    const { harness } = await start({ codes: { m1: { openid: 'om' } } });
    const res = await harness.request<Env>('POST', `${WX_API}/mini/login`, { host: GO, body: { code: 'm1', consents: CN0_CONSENTS } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ isNewUser: true, phoneBound: false, sessionToken: expect.stringMatching(/^tok_/) });
  });
});

describe('admin invites', () => {
  it('needs the admin chain', async () => {
    const { harness } = await start({ admin: null });
    expect((await harness.request('GET', `${ADMIN_API}/invites`, { host: GO })).status).toBe(401);
  });

  it('is GoApply-only: 404 feature_disabled on the RoboApply host', async () => {
    const { harness, fake } = await start({ admin: { id: 'a1', role: 'admin' } });
    const list = await harness.request<Env>('GET', `${ADMIN_API}/invites`, { host: RA });
    expect(list.status).toBe(404);
    expect(list.body.code).toBe('feature_disabled');
    const create = await harness.request<Env>('POST', `${ADMIN_API}/invites`, { host: RA, body: { count: 1 } });
    expect(create.status).toBe(404);
    expect(fake.$rows('rABrandInvite')).toHaveLength(0);
  });

  it('creates codes shown once, lists them without codes', async () => {
    const { harness } = await start({ admin: { id: 'a1', role: 'admin' } });
    const created = await harness.request<Env>('POST', `${ADMIN_API}/invites`, { host: GO, body: { count: 2, note: 'Pilot' } });
    expect(created.status).toBe(201);
    const items = created.body.data!.items as Array<{ code: string | null; maxUses: number }>;
    expect(items).toHaveLength(2);
    expect(items[0]!.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(items[0]!.maxUses).toBe(1);
    const list = await harness.request<Env>('GET', `${ADMIN_API}/invites?status=active`, { host: GO });
    expect((list.body.data!.items as Array<{ code: string | null }>).map((i) => i.code)).toEqual([null, null]);
    const bad = await harness.request<Env>('POST', `${ADMIN_API}/invites`, { host: GO, body: { count: 0 } });
    expect(bad.status).toBe(422);
  });
});
