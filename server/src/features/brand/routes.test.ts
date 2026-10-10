// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrandPublicRouter, buildPublicBrand } from './routes.js';
import { PublicBrandSchema, type PublicBrand } from './contract.js';
import { BRANDS } from '../../platform/brand/registry.js';
import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';

describe('GET /api/v1/public/brand', () => {
  let h: RouteHarness;
  const env = { NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_test_x', GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 's' };
  beforeAll(async () => {
    h = await startRouteHarness({ env, mounts: [['/api/v1/public/brand', createBrandPublicRouter({ env })]] });
  });
  afterAll(() => h.close());

  it('returns RoboApply on localhost with only configured methods and rails', async () => {
    const res = await h.request<{ success: boolean; data: PublicBrand }>('GET', '/api/v1/public/brand', { host: 'localhost:3621' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(PublicBrandSchema.safeParse(d).success).toBe(true);
    expect(d).toMatchObject({ id: 'roboapply', market: 'intl', name: 'RoboApply', defaultLocale: 'en', currency: 'USD' });
    expect(d.authMethods).toEqual(['email_password', 'google']);
    expect(d.paymentRails).toEqual(['stripe']);
    expect(d.flags['pay.stripe']).toBe(true);
    expect(d.flags.hiringContacts).toBe('deeplinks_only');
    expect(d.otherBrand).toEqual({ id: 'goapply', name: 'GoApply', canonicalOrigin: 'https://www.goapply.top' });
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
  });

  it('returns GoApply on goapply.localhost with the same capabilities and nothing it cannot deliver', async () => {
    const res = await h.request<{ data: PublicBrand }>('GET', '/api/v1/public/brand', { host: 'goapply.localhost:3621' });
    const d = res.body.data;
    expect(PublicBrandSchema.safeParse(d).success).toBe(true);
    expect(d).toMatchObject({ id: 'goapply', market: 'cn', defaultLocale: 'zh', locales: ['zh', 'en'], currency: 'CNY' });
    // Email + password is always offered; phone and WeChat only with their credentials; never Google.
    expect(d.authMethods).toEqual(['email_password']);
    // No ALIPAY_CALLBACK_SECRET in this env: plans can be listed but no payment can be opened. Never Stripe.
    expect(d.paymentRails).toEqual([]);
    expect(d.flags['pay.stripe']).toBe(false);
    // On by default (D5): no CN_ value is set in this env.
    expect(d.flags['jobs.feed']).toBe(true);
    expect(d.flags['ai.text']).toBe(true);
    expect(d.flags.coaching).toBe(true);
    expect(d.flags.student).toBe(true);
    expect(d.flags.eeoAnswers).toBe(false);
    expect(res.headers.get('x-ra-brand')).toBe('goapply');
  });

  it('is publicly cacheable on production hosts and exposes no secrets', async () => {
    const prodEnv = { NODE_ENV: 'production', ALLOWED_BRANDS: 'intl,cn', STRIPE_SECRET_KEY: 'sk_live_secret' };
    const prod = await startRouteHarness({ env: prodEnv, mounts: [['/b', createBrandPublicRouter({ env: prodEnv })]] });
    try {
      const res = await prod.request('GET', '/b', { host: 'www.goapply.top' });
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      expect(res.text).not.toContain('sk_live_secret');
    } finally {
      await prod.close();
    }
  });

  it('buildPublicBrand validates for both brands', () => {
    for (const brand of [BRANDS.roboapply, BRANDS.goapply]) {
      expect(PublicBrandSchema.safeParse(buildPublicBrand(brand, {})).success).toBe(true);
    }
  });
});

/**
 * D5 acceptance (GOAPPLY_PARITY_PLAN §3.2, G37): with only the shared
 * credentials, the two hosts of one deployment answer with the same
 * capabilities, except the six that belong to RoboApply's market.
 */
describe('GET /api/v1/public/brand: the two hosts compared (shared-only env)', () => {
  const SHARED = {
    NODE_ENV: 'development',
    RESEND_API_KEY: 'k',
    LIVEKIT_URL: 'wss://x',
    LIVEKIT_API_KEY: 'k',
    LIVEKIT_API_SECRET: 's',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    VAPID_SUBJECT: 'mailto:push@example.com',
    ALIPAY_CALLBACK_SECRET: 'secret',
    STRIPE_SECRET_KEY: 'sk_test_x',
  };
  const ROBOAPPLY_ONLY = ['h1bHistory', 'eeoAnswers', 'fx.reference', 'pay.stripe', 'auth.google', 'auth.line'];

  async function bothHosts(env: Record<string, string>, hosts: { robo: string; go: string }): Promise<{ robo: PublicBrand; go: PublicBrand }> {
    const harness = await startRouteHarness({ env, mounts: [['/api/v1/public/brand', createBrandPublicRouter({ env })]] });
    try {
      const robo = await harness.request<{ data: PublicBrand }>('GET', '/api/v1/public/brand', { host: hosts.robo });
      const go = await harness.request<{ data: PublicBrand }>('GET', '/api/v1/public/brand', { host: hosts.go });
      expect(robo.status).toBe(200);
      expect(go.status).toBe(200);
      return { robo: robo.body.data, go: go.body.data };
    } finally {
      await harness.close();
    }
  }

  function booleanFlags(d: PublicBrand): Array<[string, boolean]> {
    return Object.entries(d.flags).filter((e): e is [string, boolean] => typeof e[1] === 'boolean');
  }

  it.each([
    ['the dev hosts', SHARED, { robo: 'localhost:3621', go: 'goapply.localhost:3621' }],
    ['the production hosts, no deployment scope set', { ...SHARED, NODE_ENV: 'production' }, { robo: 'www.roboapply.io', go: 'www.goapply.top' }],
  ])('%s: every flag on for RoboApply is on for GoApply, except the market six', async (_label, env, hosts) => {
    const { robo, go } = await bothHosts(env, hosts);
    expect(robo.id).toBe('roboapply');
    expect(go.id).toBe('goapply');
    expect(PublicBrandSchema.safeParse(go).success).toBe(true);
    const goFlags = go.flags as unknown as Record<string, boolean>;
    const missing = booleanFlags(robo)
      .filter(([key, on]) => on && goFlags[key] !== true)
      .map(([key]) => key);
    expect(missing.filter((key) => !ROBOAPPLY_ONLY.includes(key))).toEqual([]);
    for (const key of ROBOAPPLY_ONLY) expect(goFlags[key], key).toBe(false);
    expect(go.flags.hiringContacts).toBe(robo.flags.hiringContacts);

    // Sign-in: email + password first on both; nothing unconfigured is listed.
    expect(go.authMethods[0]).toBe('email_password');
    expect(robo.authMethods[0]).toBe('email_password');
    expect(go.authMethods).toEqual(['email_password']);
    expect(go.authMethods).not.toContain('google');

    // Rails follow the market (D6): Alipay for GoApply once its callback secret is set, Stripe for RoboApply.
    expect(go.paymentRails).toContain('alipay');
    expect(go.paymentRails).not.toContain('stripe');
    expect(robo.paymentRails).toEqual(['stripe']);

    // What stays per market.
    expect(go).toMatchObject({ market: 'cn', currency: 'CNY', defaultLocale: 'zh', defaultCountry: 'CN' });
    expect(robo).toMatchObject({ market: 'intl', currency: 'USD', defaultLocale: 'en' });
  });

  it('GoApply lists phone and WeChat after email when their credentials exist', async () => {
    const env = { ...SHARED, SMS_DEV_CONSOLE: 'true', WECHAT_OPEN_APP_ID: 'a', WECHAT_OPEN_APP_SECRET: 'b' };
    const { robo, go } = await bothHosts(env, { robo: 'localhost:3621', go: 'goapply.localhost:3621' });
    expect(go.authMethods).toEqual(['email_password', 'phone_otp', 'wechat']);
    expect(robo.authMethods).toEqual(['email_password']);
  });

  it('without ALIPAY_CALLBACK_SECRET GoApply lists no rail, and CN_PAYMENTS_ENABLED=false closes it', async () => {
    const { ALIPAY_CALLBACK_SECRET: _secret, ...noSecret } = SHARED;
    const hosts = { robo: 'localhost:3621', go: 'goapply.localhost:3621' };
    expect((await bothHosts(noSecret, hosts)).go.paymentRails).toEqual([]);
    const killed = await bothHosts({ ...SHARED, CN_PAYMENTS_ENABLED: 'false' }, hosts);
    expect(killed.go.paymentRails).toEqual([]);
    expect(killed.robo.paymentRails).toEqual(['stripe']);
  });

  it('each off switch reaches the payload, for GoApply only', async () => {
    const hosts = { robo: 'localhost:3621', go: 'goapply.localhost:3621' };
    const base = await bothHosts(SHARED, hosts);
    const off = await bothHosts(
      { ...SHARED, CN_RECRUITMENT_INFO_MODE: 'off', CN_CAMPUS_CALENDAR_ENABLED: 'false', CN_EMAIL_TRANSPORT: 'none', FLAG_GOAPPLY_COACHING: 'false' },
      hosts,
    );
    const goOff = off.go.flags as unknown as Record<string, boolean>;
    for (const key of ['jobs.feed', 'jobs.recommendations', 'jobs.alerts', 'campusCalendar', 'jobs.campusCalendar', 'notify.email', 'auth.passwordReset', 'coaching']) {
      expect((base.go.flags as unknown as Record<string, boolean>)[key], key).toBe(true);
      expect(goOff[key], key).toBe(false);
    }
    expect(off.robo.flags).toEqual(base.robo.flags);
  });
});
