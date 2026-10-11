// @vitest-environment node
//
// ST-0: the one client factory refuses a live key outside production. The
// Stripe SDK is mocked: nothing here can reach Stripe.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ constructed: [] as Array<{ key: string; config: unknown }> }));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    constructor(key: string, config: unknown) {
      sdk.constructed.push({ key, config });
    }
  },
}));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { logger } from '../../services/LoggerService.js';
import { STRIPE_CLIENT_CONFIG, getStripe, resetStripeClientForTests, setStripeClientForTests } from './stripeClient.js';

// Shaped like Stripe keys, made up for this file.
const TEST_KEY = 'sk_test_example';
const LIVE_KEY = 'sk_live_examplesecretvalue';
const RESTRICTED_LIVE_KEY = 'rk_live_examplesecretvalue';

beforeEach(() => {
  sdk.constructed.length = 0;
  vi.clearAllMocks();
  resetStripeClientForTests();
  setStripeClientForTests(undefined);
});
afterEach(() => {
  setStripeClientForTests(undefined);
  resetStripeClientForTests();
});

describe('getStripe', () => {
  it('no key: null, nothing constructed, nothing logged', () => {
    expect(getStripe({})).toBeNull();
    expect(getStripe({ STRIPE_SECRET_KEY: '  ' })).toBeNull();
    expect(sdk.constructed).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a test key works in any runtime and is built once, with two network retries and our app info', () => {
    const env = { STRIPE_SECRET_KEY: ` ${TEST_KEY} ` };
    const client = getStripe(env);
    expect(client).not.toBeNull();
    expect(getStripe(env)).toBe(client);
    expect(getStripe({ ...env, VERCEL_ENV: 'preview' })).toBe(client);
    expect(getStripe({ ...env, VERCEL_ENV: 'production' })).toBe(client);
    expect(sdk.constructed).toEqual([{ key: TEST_KEY, config: { maxNetworkRetries: 2, appInfo: { name: 'RoboApply', url: 'https://www.roboapply.io' } } }]);
    expect(STRIPE_CLIENT_CONFIG.maxNetworkRetries).toBe(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a live key outside production constructs nothing and returns null', () => {
    for (const env of [{}, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'development' }, { NODE_ENV: 'production' }]) {
      expect(getStripe({ ...env, STRIPE_SECRET_KEY: LIVE_KEY }), JSON.stringify(env)).toBeNull();
      expect(getStripe({ ...env, STRIPE_SECRET_KEY: RESTRICTED_LIVE_KEY }), JSON.stringify(env)).toBeNull();
    }
    expect(sdk.constructed).toEqual([]);
  });

  it.each(['sk_org_live_abc', 'SK_LIVE_abc', 'xx_sk_live_abc', 'pk_test_abc', 'changeme'])(
    'a key that is not a test key (%s) is refused like a live key: nothing is constructed outside production',
    (key) => {
      for (const env of [{}, { VERCEL_ENV: 'preview' }, { NODE_ENV: 'production' }]) expect(getStripe({ ...env, STRIPE_SECRET_KEY: key }), JSON.stringify(env)).toBeNull();
      expect(sdk.constructed).toEqual([]);
      expect(logger.error).toHaveBeenCalledTimes(1);
      const line = JSON.stringify(vi.mocked(logger.error).mock.calls[0]);
      expect(line).toContain('STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION');
      expect(line).not.toContain(key);
      // The operator can still run it where a live key belongs, or say so explicitly.
      expect(getStripe({ STRIPE_SECRET_KEY: key, VERCEL_ENV: 'production' })).not.toBeNull();
      resetStripeClientForTests();
      expect(getStripe({ STRIPE_SECRET_KEY: key, STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION: 'true' })).not.toBeNull();
      expect(sdk.constructed.map((c) => c.key)).toEqual([key, key]);
    },
  );

  it('the refusal is logged once per process, names the variable that allows it, and carries no key material', () => {
    for (let i = 0; i < 5; i++) expect(getStripe({ STRIPE_SECRET_KEY: LIVE_KEY })).toBeNull();
    expect(getStripe({ STRIPE_SECRET_KEY: RESTRICTED_LIVE_KEY, VERCEL_ENV: 'preview' })).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(vi.mocked(logger.error).mock.calls[0]);
    expect(line).toContain('STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION');
    expect(line).toContain('live');
    // Not the key, not its prefix, not its tail.
    expect(line).not.toContain(LIVE_KEY);
    expect(line).not.toContain('sk_live');
    expect(line).not.toContain('rk_live');
    expect(line).not.toContain('examplesecretvalue');
    expect(line).not.toContain(LIVE_KEY.slice(-6));
  });

  it('a live key works in production, and outside it with the explicit override', () => {
    const prod = getStripe({ STRIPE_SECRET_KEY: LIVE_KEY, VERCEL_ENV: 'production' });
    expect(prod).not.toBeNull();
    resetStripeClientForTests();
    const allowed = getStripe({ STRIPE_SECRET_KEY: LIVE_KEY, STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION: 'true' });
    expect(allowed).not.toBeNull();
    expect(sdk.constructed.map((c) => c.key)).toEqual([LIVE_KEY, LIVE_KEY]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a changed key builds a new client; the same key reuses it', () => {
    const a = getStripe({ STRIPE_SECRET_KEY: 'sk_test_one' });
    const b = getStripe({ STRIPE_SECRET_KEY: 'sk_test_two' });
    expect(a).not.toBe(b);
    expect(getStripe({ STRIPE_SECRET_KEY: 'sk_test_two' })).toBe(b);
    expect(sdk.constructed.map((c) => c.key)).toEqual(['sk_test_one', 'sk_test_two']);
  });

  it('setStripeClientForTests still wins over any environment, including a refused one', () => {
    const fake = { fake: true } as never;
    setStripeClientForTests(fake);
    expect(getStripe({})).toBe(fake);
    expect(getStripe({ STRIPE_SECRET_KEY: LIVE_KEY })).toBe(fake);
    setStripeClientForTests(null);
    expect(getStripe({ STRIPE_SECRET_KEY: TEST_KEY })).toBeNull();
    expect(sdk.constructed).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
