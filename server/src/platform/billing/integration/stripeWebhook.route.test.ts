// @vitest-environment node
//
// The Stripe webhook route: signature first, then the handler. ST-3 part 1
// (MARKET_STRATEGY §5.1 "Webhook"): every configured signing secret is tried
// in order and the first that verifies wins, so two secrets can be live during
// a rotation. The SDK's `constructEvent` is stubbed on the fake client: here a
// signature "verifies" when it names the secret it was made with.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import { createStripeWebhookRouter } from '../../../roboapply/routes/stripeWebhook.js';
import { logger } from '../../../services/LoggerService.js';
import { STRIPE_WEBHOOK_TRIES_EVERY_SECRET, stripeRailReady, stripeWebhookSecrets } from '../stripeEnv.js';

const handle = vi.fn();
const stripe = {
  webhooks: {
    constructEvent: vi.fn((_body: unknown, sig: string) => {
      if (sig !== 'good') throw new Error('bad signature');
      return { id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } };
    }),
  },
};

/** A fake SDK whose signatures name their secret: `signed-with:<secret>`. */
const tried: string[] = [];
const signing = {
  webhooks: {
    constructEvent: vi.fn((_body: unknown, sig: string, secret: string) => {
      tried.push(secret);
      if (sig !== `signed-with:${secret}`) throw new Error('No signatures found matching the expected signature for payload');
      return { id: 'evt_signed', type: 'invoice.paid', data: { object: {} } };
    }),
  },
};

let h: RouteHarness;
let noStripe: RouteHarness;
let fromEnv: RouteHarness;
let noSecret: RouteHarness;

beforeAll(async () => {
  h = await startRouteHarness({ mounts: [['/wh', createStripeWebhookRouter({ getStripe: () => stripe as never, handle, secret: () => 'whsec' })]] });
  noStripe = await startRouteHarness({ mounts: [['/wh', createStripeWebhookRouter({ getStripe: () => null, handle })]] });
  // No secret seam: the route reads the environment, as it does in production.
  fromEnv = await startRouteHarness({ mounts: [['/wh', createStripeWebhookRouter({ getStripe: () => signing as never, handle })]] });
  noSecret = await startRouteHarness({ mounts: [['/wh', createStripeWebhookRouter({ getStripe: () => signing as never, handle, secret: () => undefined })]] });
});
afterAll(async () => {
  await Promise.all([h.close(), noStripe.close(), fromEnv.close(), noSecret.close()]);
});
beforeEach(() => {
  handle.mockReset();
  tried.length = 0;
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RoboApply Stripe webhook', () => {
  it('rejects a bad signature without running the handler', async () => {
    const res = await h.request('POST', '/wh', { headers: { 'stripe-signature': 'bad' }, body: {} });
    expect(res.status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it('acknowledges handled and replayed events with 200', async () => {
    handle.mockResolvedValueOnce({ handled: true }).mockResolvedValueOnce({ handled: true, duplicate: true });
    expect((await h.request<any>('POST', '/wh', { headers: { 'stripe-signature': 'good' }, body: {} })).body).toEqual({ received: true, handled: true });
    expect((await h.request<any>('POST', '/wh', { headers: { 'stripe-signature': 'good' }, body: {} })).body).toEqual({ received: true, handled: true, duplicate: true });
  });

  it('answers 500 on a processing failure so Stripe retries (every step is replay-safe)', async () => {
    handle.mockResolvedValueOnce({ handled: false, failed: true });
    expect((await h.request('POST', '/wh', { headers: { 'stripe-signature': 'good' }, body: {} })).status).toBe(500);
    handle.mockRejectedValueOnce(new Error('db down'));
    expect((await h.request('POST', '/wh', { headers: { 'stripe-signature': 'good' }, body: {} })).status).toBe(500);
  });

  it('503 when Stripe is not configured', async () => {
    expect((await noStripe.request('POST', '/wh', { body: {} })).status).toBe(503);
  });
});

describe('several signing secrets (rotation: the CLI secret and the Dashboard endpoint secret)', () => {
  const post = (harness: RouteHarness, signature: string) => harness.request<any>('POST', '/wh', { headers: { 'stripe-signature': signature }, body: {} });

  it('two secrets in one variable: an event signed with either verifies; one signed with a third answers 400', async () => {
    vi.stubEnv('ROBOAPPLY_STRIPE_WEBHOOK_SECRET', '');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_cli,whsec_dashboard');
    handle.mockResolvedValue({ handled: true });

    const first = await post(fromEnv, 'signed-with:whsec_cli');
    expect([first.status, first.body]).toEqual([200, { received: true, handled: true }]);
    expect(tried).toEqual(['whsec_cli']); // the first that verifies wins: the second is not tried

    tried.length = 0;
    const second = await post(fromEnv, 'signed-with:whsec_dashboard');
    expect([second.status, second.body]).toEqual([200, { received: true, handled: true }]);
    expect(tried).toEqual(['whsec_cli', 'whsec_dashboard']);
    expect(handle).toHaveBeenCalledTimes(2);

    tried.length = 0;
    handle.mockClear();
    const third = await post(fromEnv, 'signed-with:whsec_somebody_else');
    expect([third.status, third.body]).toEqual([400, { error: 'invalid_signature' }]);
    expect(tried).toEqual(['whsec_cli', 'whsec_dashboard']);
    expect(handle).not.toHaveBeenCalled();
    // One warning for the request, saying how many were tried; never a secret.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('whsec_');
    expect(vi.mocked(logger.warn).mock.calls[0]![2]).toMatchObject({ secretsTried: 2 });
  });

  it('both variable names are read, the RoboApply one first, each a list, trimmed and without repeats', async () => {
    vi.stubEnv('ROBOAPPLY_STRIPE_WEBHOOK_SECRET', ' whsec_a , whsec_b ');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_b,whsec_c\n');
    handle.mockResolvedValue({ handled: true });
    expect((await post(fromEnv, 'signed-with:whsec_c')).status).toBe(200);
    expect(tried).toEqual(['whsec_a', 'whsec_b', 'whsec_c']);
  });

  it('a secret stored with a stray space or newline verifies: the route tries the trimmed value', async () => {
    vi.stubEnv('ROBOAPPLY_STRIPE_WEBHOOK_SECRET', '');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', ' whsec_newline\n');
    handle.mockResolvedValue({ handled: true });
    expect((await post(fromEnv, 'signed-with:whsec_newline')).status).toBe(200);
    expect(tried).toEqual(['whsec_newline']);
  });

  it('a blank RoboApply variable in front of a real secret no longer hides it', async () => {
    vi.stubEnv('ROBOAPPLY_STRIPE_WEBHOOK_SECRET', '   ');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_real');
    handle.mockResolvedValue({ handled: true });
    expect((await post(fromEnv, 'signed-with:whsec_real')).status).toBe(200);
  });

  it('no secret at all answers 500 webhook_secret_missing, before any verification', async () => {
    vi.stubEnv('ROBOAPPLY_STRIPE_WEBHOOK_SECRET', '');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', ' , ');
    const res = await post(fromEnv, 'signed-with:anything');
    expect([res.status, res.body]).toEqual([500, { error: 'webhook_secret_missing' }]);
    const seam = await post(noSecret, 'signed-with:anything');
    expect([seam.status, seam.body]).toEqual([500, { error: 'webhook_secret_missing' }]);
    expect(tried).toEqual([]);
    expect(handle).not.toHaveBeenCalled();
  });

  it('a processing failure still answers 500 with several secrets', async () => {
    vi.stubEnv('ROBOAPPLY_STRIPE_WEBHOOK_SECRET', '');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_cli,whsec_dashboard');
    handle.mockResolvedValueOnce({ handled: false, failed: true });
    expect((await post(fromEnv, 'signed-with:whsec_dashboard')).status).toBe(500);
  });

  // The two halves of one change (MKT-2B item 1): the rail opens on a list
  // BECAUSE this route verifies with every secret of that list.
  it('the rail is open on exactly the secrets this route verifies with', async () => {
    expect(STRIPE_WEBHOOK_TRIES_EVERY_SECRET).toBe(true);
    const env = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_cli, whsec_dashboard' };
    expect(stripeRailReady(env)).toBe(true);
    vi.stubEnv('ROBOAPPLY_STRIPE_WEBHOOK_SECRET', '');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', env.STRIPE_WEBHOOK_SECRET);
    handle.mockResolvedValue({ handled: true });
    for (const secret of stripeWebhookSecrets(env)) {
      expect((await post(fromEnv, `signed-with:${secret}`)).status, secret).toBe(200);
    }
  });
});
