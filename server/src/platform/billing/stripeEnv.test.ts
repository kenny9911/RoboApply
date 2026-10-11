// @vitest-environment node
//
// ST-0 (MARKET_STRATEGY §5.1 "Safety first"): what the environment says about
// Stripe. Pure functions; no SDK, no network.
import { describe, expect, it } from 'vitest';
import {
  STRIPE_WEBHOOK_TRIES_EVERY_SECRET,
  liveKeyAllowed,
  stripeKeyMode,
  stripeKeyUsable,
  stripeRailBlocker,
  stripeRailReady,
  stripeSecretKey,
  stripeWebhookCanVerify,
  stripeWebhookSecrets,
} from './stripeEnv.js';

// Shaped like Stripe keys, made up for this file.
const TEST_KEY = 'sk_test_example';
const LIVE_KEY = 'sk_live_example';
const RESTRICTED_LIVE_KEY = 'rk_live_example';
const RESTRICTED_TEST_KEY = 'rk_test_example';

describe('stripeSecretKey / stripeKeyMode', () => {
  it('reads the trimmed key; unset and blank are no key', () => {
    expect(stripeSecretKey({})).toBeNull();
    expect(stripeSecretKey({ STRIPE_SECRET_KEY: '   ' })).toBeNull();
    expect(stripeSecretKey({ STRIPE_SECRET_KEY: `  ${TEST_KEY}\n` })).toBe(TEST_KEY);
  });

  it('a secret or restricted TEST key is a test key; every other key is live', () => {
    expect(stripeKeyMode({})).toBe('none');
    expect(stripeKeyMode({ STRIPE_SECRET_KEY: '' })).toBe('none');
    expect(stripeKeyMode({ STRIPE_SECRET_KEY: TEST_KEY })).toBe('test');
    expect(stripeKeyMode({ STRIPE_SECRET_KEY: RESTRICTED_TEST_KEY })).toBe('test');
    expect(stripeKeyMode({ STRIPE_SECRET_KEY: ` ${RESTRICTED_TEST_KEY}\n` })).toBe('test');
    expect(stripeKeyMode({ STRIPE_SECRET_KEY: LIVE_KEY })).toBe('live');
    expect(stripeKeyMode({ STRIPE_SECRET_KEY: ` ${RESTRICTED_LIVE_KEY} ` })).toBe('live');
  });

  // The guard fails closed: a key in a format it does not recognise is never taken for a test key.
  it.each([
    ['an organisation-style live key', 'sk_org_live_abc'],
    ['a live prefix in another case', 'SK_LIVE_abc'],
    ['a live key with something pasted in front', 'xx_sk_live_abc'],
    ['a test prefix in another case', 'SK_TEST_abc'],
    ['a test prefix that is not at the start', 'xx_sk_test_abc'],
    ['a publishable key', 'pk_test_abc'],
    ['a bare prefix without its underscore', 'sk_testabc'],
    ['a word', 'changeme'],
  ])('%s is treated as live: refused outside production, usable in production or with the override', (_name, key) => {
    expect(stripeKeyMode({ STRIPE_SECRET_KEY: key })).toBe('live');
    for (const env of [{}, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'development' }, { NODE_ENV: 'production' }]) {
      expect(stripeKeyUsable({ ...env, STRIPE_SECRET_KEY: key }), JSON.stringify(env)).toEqual({ usable: false, reason: 'live_key_outside_production' });
      expect(stripeRailReady({ ...env, STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: 'whsec_x' }), JSON.stringify(env)).toBe(false);
    }
    expect(stripeKeyUsable({ STRIPE_SECRET_KEY: key, VERCEL_ENV: 'production' })).toEqual({ usable: true, reason: null });
    expect(stripeKeyUsable({ STRIPE_SECRET_KEY: key, STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION: 'true' })).toEqual({ usable: true, reason: null });
  });
});

describe('the live-key rule', () => {
  it('a live key is allowed in a production runtime, or with the explicit override', () => {
    expect(liveKeyAllowed({})).toBe(false);
    expect(liveKeyAllowed({ VERCEL_ENV: 'preview' })).toBe(false);
    expect(liveKeyAllowed({ VERCEL_ENV: 'development' })).toBe(false);
    // NODE_ENV says nothing about where the money goes: a local `next start` is production too.
    expect(liveKeyAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(liveKeyAllowed({ VERCEL_ENV: 'production' })).toBe(true);
    for (const on of ['true', '1', 'yes', 'on', 'TRUE']) expect(liveKeyAllowed({ STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION: on }), on).toBe(true);
    for (const off of ['', 'false', '0', 'no', 'maybe']) expect(liveKeyAllowed({ STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION: off }), off).toBe(false);
  });

  it('usable: a test key anywhere; a live key only where it is allowed; and the reason when it is not', () => {
    expect(stripeKeyUsable({})).toEqual({ usable: false, reason: 'missing' });
    expect(stripeKeyUsable({ STRIPE_SECRET_KEY: ' ' })).toEqual({ usable: false, reason: 'missing' });
    for (const env of [{}, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'production' }, { NODE_ENV: 'production' }]) {
      expect(stripeKeyUsable({ ...env, STRIPE_SECRET_KEY: TEST_KEY }), JSON.stringify(env)).toEqual({ usable: true, reason: null });
    }
    for (const key of [LIVE_KEY, RESTRICTED_LIVE_KEY]) {
      expect(stripeKeyUsable({ STRIPE_SECRET_KEY: key })).toEqual({ usable: false, reason: 'live_key_outside_production' });
      expect(stripeKeyUsable({ STRIPE_SECRET_KEY: key, VERCEL_ENV: 'preview' })).toEqual({ usable: false, reason: 'live_key_outside_production' });
      expect(stripeKeyUsable({ STRIPE_SECRET_KEY: key, NODE_ENV: 'production' })).toEqual({ usable: false, reason: 'live_key_outside_production' });
      expect(stripeKeyUsable({ STRIPE_SECRET_KEY: key, VERCEL_ENV: 'production' })).toEqual({ usable: true, reason: null });
      expect(stripeKeyUsable({ STRIPE_SECRET_KEY: key, STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION: 'true' })).toEqual({ usable: true, reason: null });
    }
  });
});

describe('stripeWebhookSecrets', () => {
  it('reads both variables, the RoboApply one first', () => {
    expect(stripeWebhookSecrets({})).toEqual([]);
    expect(stripeWebhookSecrets({ STRIPE_WEBHOOK_SECRET: 'whsec_b' })).toEqual(['whsec_b']);
    expect(stripeWebhookSecrets({ ROBOAPPLY_STRIPE_WEBHOOK_SECRET: 'whsec_a' })).toEqual(['whsec_a']);
    expect(stripeWebhookSecrets({ STRIPE_WEBHOOK_SECRET: 'whsec_b', ROBOAPPLY_STRIPE_WEBHOOK_SECRET: 'whsec_a' })).toEqual(['whsec_a', 'whsec_b']);
  });

  it('splits comma-separated lists, trims, and drops empties and repeats (rotation)', () => {
    expect(stripeWebhookSecrets({ STRIPE_WEBHOOK_SECRET: ' whsec_cli , whsec_dashboard ,, ' })).toEqual(['whsec_cli', 'whsec_dashboard']);
    expect(
      stripeWebhookSecrets({ ROBOAPPLY_STRIPE_WEBHOOK_SECRET: 'whsec_a,whsec_b', STRIPE_WEBHOOK_SECRET: 'whsec_b, whsec_c ,whsec_a' }),
    ).toEqual(['whsec_a', 'whsec_b', 'whsec_c']);
    expect(stripeWebhookSecrets({ STRIPE_WEBHOOK_SECRET: ' , ,' })).toEqual([]);
  });
});

describe('stripeRailReady: a usable key AND a webhook secret the webhook can verify with', () => {
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ['nothing set', {}, false],
    ['a test key alone (money would be taken and never fulfilled)', { STRIPE_SECRET_KEY: TEST_KEY }, false],
    ['a webhook secret alone', { STRIPE_WEBHOOK_SECRET: 'whsec_x' }, false],
    ['a test key and a webhook secret', { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: 'whsec_x' }, true],
    ['a test key and the RoboApply-named secret', { STRIPE_SECRET_KEY: TEST_KEY, ROBOAPPLY_STRIPE_WEBHOOK_SECRET: 'whsec_x' }, true],
    ['a test key and one secret in each variable (the route reads the RoboApply one)', { STRIPE_SECRET_KEY: TEST_KEY, ROBOAPPLY_STRIPE_WEBHOOK_SECRET: 'whsec_a', STRIPE_WEBHOOK_SECRET: 'whsec_b' }, true],
    ['a test key and a blank secret', { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: ' , ' }, false],
    ['a live key and a secret outside production', { STRIPE_SECRET_KEY: LIVE_KEY, STRIPE_WEBHOOK_SECRET: 'whsec_x' }, false],
    ['a live key and a secret on a preview deployment', { STRIPE_SECRET_KEY: LIVE_KEY, STRIPE_WEBHOOK_SECRET: 'whsec_x', VERCEL_ENV: 'preview' }, false],
    ['a live key and a secret in production', { STRIPE_SECRET_KEY: LIVE_KEY, STRIPE_WEBHOOK_SECRET: 'whsec_x', VERCEL_ENV: 'production' }, true],
    ['a live key in production with no secret', { STRIPE_SECRET_KEY: LIVE_KEY, VERCEL_ENV: 'production' }, false],
    ['a live key and a secret with the override', { STRIPE_SECRET_KEY: LIVE_KEY, STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION: 'true' }, true],
  ];
  it.each(cases)('%s', (_name, env, ready) => {
    expect(stripeRailReady(env)).toBe(ready);
  });

  it('names the first reason the rail is closed, and null when it is ready', () => {
    expect(stripeRailBlocker({})).toBe('missing');
    expect(stripeRailBlocker({ STRIPE_WEBHOOK_SECRET: 'whsec_x' })).toBe('missing');
    expect(stripeRailBlocker({ STRIPE_SECRET_KEY: LIVE_KEY, STRIPE_WEBHOOK_SECRET: 'whsec_x' })).toBe('live_key_outside_production');
    expect(stripeRailBlocker({ STRIPE_SECRET_KEY: TEST_KEY })).toBe('webhook_secret_missing');
    expect(stripeRailBlocker({ STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: ' , ' })).toBe('webhook_secret_missing');
    expect(stripeRailBlocker({ STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: 'whsec_x' })).toBeNull();
  });
});

// The webhook route (roboapply/routes/stripeWebhook.ts) still hands the ONE
// string it reads to constructEvent. A rail that opened on a list would take
// money while every signature fails. MKT-2B item 1 makes the route loop over
// stripeWebhookSecrets() and sets STRIPE_WEBHOOK_TRIES_EVERY_SECRET to true in
// the same change. The ONE line of the test suite to flip then is the first
// test of this block: everything else here and in planCatalog, registry and
// flags tests follows the constant.
describe('until the webhook tries every secret, the rail needs the one string the route reads to be a single secret', () => {
  const KEY = { STRIPE_SECRET_KEY: TEST_KEY };
  const notOne: Array<[string, Record<string, string>]> = [
    ['a comma-separated list in STRIPE_WEBHOOK_SECRET', { STRIPE_WEBHOOK_SECRET: 'whsec_a,whsec_b' }],
    ['a comma-separated list in ROBOAPPLY_STRIPE_WEBHOOK_SECRET', { ROBOAPPLY_STRIPE_WEBHOOK_SECRET: 'whsec_a, whsec_b' }],
    ['a list in the RoboApply variable in front of a single secret', { ROBOAPPLY_STRIPE_WEBHOOK_SECRET: 'whsec_a,whsec_b', STRIPE_WEBHOOK_SECRET: 'whsec_c' }],
    ['a trailing comma', { STRIPE_WEBHOOK_SECRET: 'whsec_a,' }],
    ['a whitespace-only RoboApply variable in front of a real secret (the route reads the blank one)', { ROBOAPPLY_STRIPE_WEBHOOK_SECRET: '  ', STRIPE_WEBHOOK_SECRET: 'whsec_b' }],
  ];

  it('the route does not try every secret yet (flip this with the route change, MKT-2B item 1)', () => {
    expect(STRIPE_WEBHOOK_TRIES_EVERY_SECRET).toBe(false);
  });

  it.each(notOne)('%s: the secrets are listed, a one-secret webhook cannot verify, and the rail follows the route', (_name, secrets) => {
    const env = { ...KEY, ...secrets };
    expect(stripeWebhookSecrets(env).length).toBeGreaterThan(0);
    expect(stripeWebhookCanVerify(env, false)).toBe(false);
    expect(stripeWebhookCanVerify(env, true)).toBe(true);
    // The default is what the route does today.
    expect(stripeWebhookCanVerify(env)).toBe(STRIPE_WEBHOOK_TRIES_EVERY_SECRET);
    expect(stripeRailReady(env)).toBe(STRIPE_WEBHOOK_TRIES_EVERY_SECRET);
    expect(stripeRailBlocker(env)).toBe(STRIPE_WEBHOOK_TRIES_EVERY_SECRET ? null : 'webhook_secret_unverifiable');
    // In production with a live key too: this is about fulfilment, not about the key.
    expect(stripeRailReady({ ...secrets, STRIPE_SECRET_KEY: LIVE_KEY, VERCEL_ENV: 'production' })).toBe(STRIPE_WEBHOOK_TRIES_EVERY_SECRET);
  });

  it('a single secret verifies either way: in either variable, and an empty RoboApply variable falls through to the other', () => {
    for (const tries of [false, true]) {
      expect(stripeWebhookCanVerify({}, tries)).toBe(false);
      expect(stripeWebhookCanVerify({ STRIPE_WEBHOOK_SECRET: ' , ' }, tries)).toBe(false);
      expect(stripeWebhookCanVerify({ STRIPE_WEBHOOK_SECRET: 'whsec_b' }, tries)).toBe(true);
      expect(stripeWebhookCanVerify({ ROBOAPPLY_STRIPE_WEBHOOK_SECRET: 'whsec_a' }, tries)).toBe(true);
      expect(stripeWebhookCanVerify({ ROBOAPPLY_STRIPE_WEBHOOK_SECRET: '', STRIPE_WEBHOOK_SECRET: 'whsec_b' }, tries)).toBe(true);
      // The route reads the RoboApply variable first, so a list behind a single secret is never read.
      expect(stripeWebhookCanVerify({ ROBOAPPLY_STRIPE_WEBHOOK_SECRET: 'whsec_a', STRIPE_WEBHOOK_SECRET: 'whsec_b,whsec_c' }, tries)).toBe(true);
    }
  });
});
