// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import { createStripeWebhookRouter } from '../../../roboapply/routes/stripeWebhook.js';

const handle = vi.fn();
const stripe = {
  webhooks: {
    constructEvent: vi.fn((_body: unknown, sig: string) => {
      if (sig !== 'good') throw new Error('bad signature');
      return { id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } };
    }),
  },
};
let h: RouteHarness;
let noStripe: RouteHarness;

beforeAll(async () => {
  h = await startRouteHarness({ mounts: [['/wh', createStripeWebhookRouter({ getStripe: () => stripe as never, handle, secret: () => 'whsec' })]] });
  noStripe = await startRouteHarness({ mounts: [['/wh', createStripeWebhookRouter({ getStripe: () => null, handle })]] });
});
afterAll(async () => {
  await Promise.all([h.close(), noStripe.close()]);
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
