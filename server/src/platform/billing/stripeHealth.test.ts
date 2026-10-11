// @vitest-environment node
//
// ST-3 part 4 (MARKET_STRATEGY §5.1 "Endpoint health"): read-only checks of
// the Stripe account. Fake `webhookEndpoints.list` and `prices.*`; nothing
// reaches Stripe, and the fakes fail the test on any write call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../test/fakePrisma.js');
  fake.db = createFakePrisma({ uniqueFields: { rACreditLedger: ['idempotencyKey'] } });
  return { default: fake.db };
});
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { HANDLED_STRIPE_EVENTS, handleRoboApplyStripeEvent, setBillingServiceDepsForTests } from '../../roboapply/services/RoboApplyBillingService.js';
import { registerStripeEventHandler, unregisterStripeEventHandlerForTests } from './stripeEvents.js';
import {
  EXPECTED_STRIPE_EVENTS,
  STRIPE_EVENTS_REGISTERED_ELSEWHERE,
  STRIPE_WEBHOOK_PATH,
  checkStripePrices,
  checkStripeWebhookEndpoint,
} from './stripeHealth.js';

const OUR_URL = `https://www.roboapply.io${STRIPE_WEBHOOK_PATH}`;

function stripeError(type: string, code: string, statusCode: number) {
  return Object.assign(new Error(`${type}: ${code}`), { type, code, statusCode });
}

/** Every method that would change the Stripe account. A read-only check must call none of them. */
function writeSpies() {
  return {
    webhookEndpoints: { create: vi.fn(), update: vi.fn(), del: vi.fn() },
    prices: { create: vi.fn(), update: vi.fn() },
    products: { create: vi.fn(), update: vi.fn(), del: vi.fn() },
  };
}
function expectNoWrites(w: ReturnType<typeof writeSpies>) {
  for (const group of Object.values(w)) for (const fn of Object.values(group)) expect(fn).not.toHaveBeenCalled();
}

function endpointStripe(endpoints: Array<Record<string, any>>, pageSize = 100) {
  const w = writeSpies();
  const list = vi.fn(async (params: { limit?: number; starting_after?: string }) => {
    const from = params.starting_after ? endpoints.findIndex((e) => e.id === params.starting_after) + 1 : 0;
    const page = endpoints.slice(from, from + Math.min(params.limit ?? 10, pageSize));
    return { data: page, has_more: from + page.length < endpoints.length };
  });
  return { client: { webhookEndpoints: { list, ...w.webhookEndpoints }, prices: w.prices, products: w.products } as never, list, w };
}

const endpoint = (over: Record<string, any> = {}) => ({ id: 'we_1', status: 'enabled', url: OUR_URL, enabled_events: [...EXPECTED_STRIPE_EVENTS], ...over });

describe('EXPECTED_STRIPE_EVENTS: the fourteen types of the event table', () => {
  it('is exactly the table of MARKET_STRATEGY §5.1', () => {
    expect([...EXPECTED_STRIPE_EVENTS]).toEqual([
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.async_payment_failed',
      'checkout.session.expired',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'customer.subscription.pending_update_applied',
      'customer.subscription.pending_update_expired',
      'invoice.paid',
      'invoice.payment_failed',
      'invoice.payment_action_required',
      'charge.refunded',
      'charge.dispute.created',
    ]);
    expect(new Set(EXPECTED_STRIPE_EVENTS).size).toBe(14);
  });

  it('the two refund types are the ones registered elsewhere, and the service names the other twelve', () => {
    expect([...STRIPE_EVENTS_REGISTERED_ELSEWHERE]).toEqual(['charge.refunded', 'charge.dispute.created']);
    const own = EXPECTED_STRIPE_EVENTS.filter((t) => !STRIPE_EVENTS_REGISTERED_ELSEWHERE.includes(t));
    expect([...HANDLED_STRIPE_EVENTS].sort()).toEqual([...own].sort());
  });

  // Not by reading a list: by asking the webhook. A type the service handles
  // itself never reaches a registered handler; every other type does. So a
  // type that is in the table but in neither place would show up here.
  describe('every expected type is handled by the service or has a handler slot in the registry', () => {
    beforeEach(() => {
      for (const t of ['seekerSubscription', 'rACreditLedger', 'user', 'seekerProfile']) fake.db[t].deleteMany({});
      setBillingServiceDepsForTests({ db: fake.db as never, getStripe: () => null, sendEmail: (async () => ({ status: 'sent' })) as never, invalidate: () => {} });
    });
    afterEach(() => {
      for (const type of EXPECTED_STRIPE_EVENTS) unregisterStripeEventHandlerForTests(type);
      setBillingServiceDepsForTests();
    });

    it.each([...EXPECTED_STRIPE_EVENTS])('%s', async (type) => {
      const slot = vi.fn(async () => ({ handled: true }));
      registerStripeEventHandler(type, slot);
      // An object of nobody we know: the service's own cases answer handled false without touching anything.
      const event = { id: 'evt_h', type, data: { object: { id: 'obj_1', customer: 'cus_stranger', metadata: {} } } };
      const result = await handleRoboApplyStripeEvent(event as never, {} as never);
      if (STRIPE_EVENTS_REGISTERED_ELSEWHERE.includes(type)) {
        expect(slot).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ handled: true });
      } else {
        expect(slot).not.toHaveBeenCalled();
        expect(result).toEqual({ handled: false });
      }
    });

    it('a type outside the table is not handled by the service (so the table is not missing one of its cases)', async () => {
      const slot = vi.fn(async () => ({ handled: true }));
      for (const type of ['customer.created', 'payout.paid', 'invoice.finalized', 'customer.subscription.paused']) {
        registerStripeEventHandler(type, slot);
        await handleRoboApplyStripeEvent({ id: 'evt_o', type, data: { object: {} } } as never, {} as never);
        unregisterStripeEventHandlerForTests(type);
      }
      expect(slot).toHaveBeenCalledTimes(4);
    });
  });
});

describe('checkStripeWebhookEndpoint', () => {
  it('an endpoint subscribed to every expected type reports none missing', async () => {
    const s = endpointStripe([endpoint()]);
    expect(await checkStripeWebhookEndpoint(s.client)).toEqual({ checked: true, url: OUR_URL, missingEvents: [] });
    expect(s.list).toHaveBeenCalledWith({ limit: 100 });
    expectNoWrites(s.w);
  });

  it('an endpoint missing invoice.payment_action_required is reported with exactly that event', async () => {
    const s = endpointStripe([endpoint({ enabled_events: EXPECTED_STRIPE_EVENTS.filter((t) => t !== 'invoice.payment_action_required') })]);
    expect(await checkStripeWebhookEndpoint(s.client)).toEqual({ checked: true, url: OUR_URL, missingEvents: ['invoice.payment_action_required'] });
    expectNoWrites(s.w);
  });

  it('missing events are listed in the order of the table; extra subscriptions are not a problem', async () => {
    const s = endpointStripe([endpoint({ enabled_events: ['checkout.session.completed', 'invoice.paid', 'customer.created', 'payout.paid'] })]);
    const out = await checkStripeWebhookEndpoint(s.client);
    expect(out.missingEvents).toEqual(EXPECTED_STRIPE_EVENTS.filter((t) => t !== 'checkout.session.completed' && t !== 'invoice.paid'));
  });

  it('an endpoint subscribed to \'*\' reports none', async () => {
    const s = endpointStripe([endpoint({ enabled_events: ['*'] })]);
    expect(await checkStripeWebhookEndpoint(s.client)).toEqual({ checked: true, url: OUR_URL, missingEvents: [] });
  });

  it('no endpoint points at our path: every event is missing, reason not_found', async () => {
    const others = [
      endpoint({ id: 'we_a', url: 'https://www.robohire.io/api/v1/stripe/webhook' }),
      endpoint({ id: 'we_b', url: `https://www.roboapply.io${STRIPE_WEBHOOK_PATH}/extra` }),
      endpoint({ id: 'we_c', url: 'not a url' }),
    ];
    for (const list of [[], others]) {
      const s = endpointStripe(list);
      expect(await checkStripeWebhookEndpoint(s.client)).toEqual({ checked: true, url: null, missingEvents: [...EXPECTED_STRIPE_EVENTS], reason: 'not_found' });
      expectNoWrites(s.w);
    }
  });

  it('a disabled endpoint on our path does not count', async () => {
    const s = endpointStripe([endpoint({ status: 'disabled' })]);
    expect(await checkStripeWebhookEndpoint(s.client)).toMatchObject({ checked: true, url: null, reason: 'not_found' });
  });

  it('the path is what matters: any host, a trailing slash or a query string still match', async () => {
    for (const url of [`https://roboapply-preview.vercel.app${STRIPE_WEBHOOK_PATH}`, `${OUR_URL}/`, `${OUR_URL}?source=dashboard`]) {
      const s = endpointStripe([endpoint({ url })]);
      expect(await checkStripeWebhookEndpoint(s.client), url).toEqual({ checked: true, url, missingEvents: [] });
    }
  });

  describe('several enabled endpoints on our path (production plus a preview or staging deployment)', () => {
    const PROD_MISSING = ['invoice.payment_action_required'];
    const prod = () => endpoint({ id: 'we_prod', enabled_events: EXPECTED_STRIPE_EVENTS.filter((t) => !PROD_MISSING.includes(t)) });
    const staging = () => endpoint({ id: 'we_staging', url: `https://staging.roboapply.io${STRIPE_WEBHOOK_PATH}`, enabled_events: ['*'] });

    it('a healthy endpoint of another deployment never hides a broken one: the one that misses the MOST events is reported', async () => {
      for (const endpoints of [
        [prod(), staging()],
        [staging(), prod()],
      ]) {
        const s = endpointStripe(endpoints);
        expect(await checkStripeWebhookEndpoint(s.client)).toEqual({ checked: true, url: OUR_URL, missingEvents: PROD_MISSING });
        expectNoWrites(s.w);
      }
    });

    it('with the origin of this deployment, the endpoint at that origin is the one reported', async () => {
      const s = endpointStripe([staging(), prod()]);
      expect(await checkStripeWebhookEndpoint(s.client, { origin: 'https://www.roboapply.io' })).toEqual({ checked: true, url: OUR_URL, missingEvents: PROD_MISSING });
      expect(await checkStripeWebhookEndpoint(s.client, { origin: 'https://staging.roboapply.io' })).toEqual({
        checked: true,
        url: `https://staging.roboapply.io${STRIPE_WEBHOOK_PATH}`,
        missingEvents: [],
      });
    });

    it('the origin is compared as an origin: case, a path or a trailing slash on it do not matter', async () => {
      const s = endpointStripe([staging(), prod()]);
      for (const origin of ['https://WWW.RoboApply.io', 'https://www.roboapply.io/', 'https://www.roboapply.io/pricing?x=1']) {
        expect((await checkStripeWebhookEndpoint(s.client, { origin })).missingEvents, origin).toEqual(PROD_MISSING);
      }
    });

    it('two endpoints at the same origin: the worse one is reported', async () => {
      const s = endpointStripe([endpoint({ id: 'we_a' }), endpoint({ id: 'we_b', url: `${OUR_URL}/`, enabled_events: ['checkout.session.completed'] })]);
      const check = await checkStripeWebhookEndpoint(s.client, { origin: 'https://www.roboapply.io' });
      expect(check.url).toBe(`${OUR_URL}/`);
      expect(check.missingEvents).toHaveLength(EXPECTED_STRIPE_EVENTS.length - 1);
    });

    it('no endpoint at the given origin, an empty origin or one that is not a URL: the worst endpoint on our path is reported', async () => {
      const s = endpointStripe([staging(), prod()]);
      for (const origin of ['https://preview-123.vercel.app', '', null, 'not a url']) {
        expect(await checkStripeWebhookEndpoint(s.client, { origin }), String(origin)).toEqual({ checked: true, url: OUR_URL, missingEvents: PROD_MISSING });
      }
    });
  });

  it('reads every page of a busy shared account', async () => {
    const others = Array.from({ length: 5 }, (_, i) => endpoint({ id: `we_o_${i}`, url: `https://other-${i}.example.test/hook` }));
    const s = endpointStripe([...others, endpoint({ id: 'we_ours' })], 2);
    expect(await checkStripeWebhookEndpoint(s.client)).toEqual({ checked: true, url: OUR_URL, missingEvents: [] });
    expect(s.list).toHaveBeenCalledTimes(3);
  });

  it('a restricted key that cannot read endpoints reports checked false and never throws', async () => {
    for (const err of [stripeError('StripePermissionError', 'permission_denied', 403), Object.assign(new Error('The provided key does not have the required permissions'), { statusCode: 403 })]) {
      const s = endpointStripe([]);
      s.list.mockRejectedValueOnce(err);
      expect(await checkStripeWebhookEndpoint(s.client)).toEqual({ checked: false, url: null, missingEvents: [], reason: 'restricted_key' });
      expectNoWrites(s.w);
    }
  });

  it('any other failure reports checked false with reason error, and never throws', async () => {
    for (const err of [stripeError('StripeConnectionError', 'network', 0), new Error('boom'), 'a string', null]) {
      const s = endpointStripe([]);
      s.list.mockRejectedValueOnce(err);
      expect(await checkStripeWebhookEndpoint(s.client)).toEqual({ checked: false, url: null, missingEvents: [], reason: 'error' });
    }
  });
});

describe('checkStripePrices: pinned prices are compared with the catalog; archived synced prices are reported', () => {
  const READY = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test' };

  function priceStripe(held: Array<Record<string, any>>) {
    const w = writeSpies();
    const retrieve = vi.fn(async (id: string) => {
      const found = held.find((p) => p.id === id);
      if (!found) throw stripeError('StripeInvalidRequestError', 'resource_missing', 404);
      return found;
    });
    const list = vi.fn(async (params: { lookup_keys?: string[]; active?: boolean }) => ({
      data: held.filter((p) => (params.lookup_keys ?? []).includes(p.lookup_key) && (params.active === undefined || p.active === params.active)),
      has_more: false,
    }));
    return { client: { prices: { retrieve, list, ...w.prices }, products: w.products, webhookEndpoints: w.webhookEndpoints } as never, retrieve, list, w };
  }

  const monthly = (over: Record<string, any> = {}) => ({ id: 'price_m', active: true, currency: 'usd', unit_amount: 2499, recurring: { interval: 'month', interval_count: 1 }, lookup_key: null, ...over });

  it('with no pins and nothing synced yet there is nothing to report (the first checkout creates the price)', async () => {
    const s = priceStripe([]);
    const out = await checkStripePrices(s.client, READY);
    expect(out).toMatchObject({ checked: true, pinsChecked: 0, issues: [] });
    expect(out.lookupKeysChecked).toBeGreaterThanOrEqual(6); // the six MVP plans at least
    expect(s.retrieve).not.toHaveBeenCalled();
    // An archived price keeps its lookup key, so the lookup must not filter on `active`.
    for (const call of s.list.mock.calls) expect(call[0]).not.toHaveProperty('active');
    expectNoWrites(s.w);
  });

  it('a pin that matches the catalog is fine and is retrieved once', async () => {
    const s = priceStripe([monthly()]);
    const out = await checkStripePrices(s.client, { ...READY, STRIPE_PRICE_PRO_MONTHLY: 'price_m', STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499' });
    expect(out).toMatchObject({ checked: true, pinsChecked: 1, issues: [] });
    expect(s.retrieve).toHaveBeenCalledTimes(1);
    expect(s.retrieve).toHaveBeenCalledWith('price_m');
  });

  it('a pin next to ONE wrong amount is reported: the buyer is shown one price and charged another', async () => {
    // The operator says 19.99; the pinned price charges 24.99.
    const s = priceStripe([monthly()]);
    const out = await checkStripePrices(s.client, { ...READY, STRIPE_PRICE_PRO_MONTHLY: 'price_m', STRIPE_PRICE_PRO_MONTHLY_CENTS: '1999' });
    expect(out.issues).toEqual([
      {
        planKey: 'pro_monthly',
        currency: 'USD',
        problem: 'pin_mismatch',
        priceId: 'price_m',
        expected: { amountMinor: 1999, currency: 'USD', recurring: { interval: 'month', intervalCount: 1 } },
        found: { amountMinor: 2499, currency: 'USD', recurring: { interval: 'month', intervalCount: 1 }, active: true },
      },
    ]);
    expectNoWrites(s.w);
  });

  it('a pin with the wrong currency or the wrong renewal is a mismatch too', async () => {
    const env = { ...READY, STRIPE_PRICE_PRO_MONTHLY: 'price_m', STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499' };
    for (const wrong of [monthly({ currency: 'eur' }), monthly({ recurring: { interval: 'month', interval_count: 3 } }), monthly({ recurring: { interval: 'year', interval_count: 1 } }), monthly({ recurring: null })]) {
      const out = await checkStripePrices(priceStripe([wrong]).client, env);
      expect(out.issues.map((i) => [i.planKey, i.problem])).toEqual([['pro_monthly', 'pin_mismatch']]);
    }
  });

  it('a one-time plan pinned to a recurring price is a mismatch; pinned to a one-time price of the right amount it is fine', async () => {
    const env = { ...READY, STRIPE_PRICE_PRO_WEEK_PASS: 'price_p', STRIPE_PRICE_PRO_WEEK_PASS_CENTS: '999' };
    const good = await checkStripePrices(priceStripe([{ id: 'price_p', active: true, currency: 'usd', unit_amount: 999, recurring: null }]).client, env);
    expect(good.issues).toEqual([]);
    const bad = await checkStripePrices(priceStripe([{ id: 'price_p', active: true, currency: 'usd', unit_amount: 999, recurring: { interval: 'week', interval_count: 1 } }]).client, env);
    expect(bad.issues.map((i) => [i.planKey, i.problem])).toEqual([['pro_week_pass', 'pin_mismatch']]);
  });

  it('a pinned price that was archived, or that Stripe does not know, is reported', async () => {
    const env = { ...READY, STRIPE_PRICE_PRO_MONTHLY: 'price_m', STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499' };
    const archived = await checkStripePrices(priceStripe([monthly({ active: false })]).client, env);
    expect(archived.issues.map((i) => [i.problem, i.priceId])).toEqual([['pin_archived', 'price_m']]);
    const unknown = await checkStripePrices(priceStripe([]).client, env);
    expect(unknown.issues.map((i) => [i.problem, i.priceId, i.found])).toEqual([['pin_not_found', 'price_m', null]]);
  });

  it('a Taiwan pin is checked against the TWD amount', async () => {
    const env = { ...READY, STRIPE_PRICE_PRO_MONTHLY_TWD: 'price_tw', STRIPE_PRICE_PRO_MONTHLY_TWD_CENTS: '74900' };
    const s = priceStripe([{ id: 'price_tw', active: true, currency: 'twd', unit_amount: 79900, recurring: { interval: 'month', interval_count: 1 } }]);
    const out = await checkStripePrices(s.client, env);
    expect(out.issues).toEqual([
      expect.objectContaining({ planKey: 'pro_monthly', currency: 'TWD', problem: 'pin_mismatch', expected: expect.objectContaining({ amountMinor: 74900, currency: 'TWD' }), found: expect.objectContaining({ amountMinor: 79900, currency: 'TWD' }) }),
    ]);
  });

  it('a synced price archived in the Dashboard is reported, never repaired', async () => {
    const s = priceStripe([monthly({ id: 'price_synced_m', active: false, lookup_key: 'ra_pro_monthly_usd_2499_incl' })]);
    const out = await checkStripePrices(s.client, READY);
    expect(out.issues).toEqual([
      expect.objectContaining({ planKey: 'pro_monthly', currency: 'USD', problem: 'synced_archived', priceId: 'price_synced_m', found: expect.objectContaining({ active: false }) }),
    ]);
    expectNoWrites(s.w);
  });

  it('an archived price next to an active one under the same key is fine', async () => {
    const s = priceStripe([
      monthly({ id: 'price_old', active: false, lookup_key: 'ra_pro_monthly_usd_2499_incl' }),
      monthly({ id: 'price_now', active: true, lookup_key: 'ra_pro_monthly_usd_2499_incl' }),
    ]);
    expect((await checkStripePrices(s.client, READY)).issues).toEqual([]);
  });

  it('an active price under our lookup key that differs from the catalog is reported', async () => {
    const s = priceStripe([monthly({ id: 'price_edited', lookup_key: 'ra_pro_monthly_usd_2499_incl', unit_amount: 2999 })]);
    expect((await checkStripePrices(s.client, READY)).issues.map((i) => [i.planKey, i.problem, i.priceId])).toEqual([['pro_monthly', 'synced_mismatch', 'price_edited']]);
  });

  it('a restricted key that cannot read prices reports checked false and never throws', async () => {
    const s = priceStripe([]);
    s.list.mockRejectedValueOnce(stripeError('StripePermissionError', 'permission_denied', 403));
    expect(await checkStripePrices(s.client, READY)).toEqual({ checked: false, pinsChecked: 0, lookupKeysChecked: 0, issues: [], reason: 'restricted_key' });
    const t = priceStripe([]);
    t.list.mockRejectedValueOnce(new Error('boom'));
    expect(await checkStripePrices(t.client, READY)).toMatchObject({ checked: false, reason: 'error' });
    expectNoWrites(s.w);
  });

  it('no more than 10 lookup keys go into one list call', async () => {
    const s = priceStripe([]);
    await checkStripePrices(s.client, { ...READY, PRICE_PRO_MONTHLY_TWD_CENTS: '74900', PRICE_PRO_WEEKLY_TWD_CENTS: '29900', PRICE_PRO_QUARTERLY_TWD_CENTS: '169900', PRICE_PRO_WEEK_PASS_TWD_CENTS: '29900' });
    expect(s.list.mock.calls.length).toBeGreaterThan(1);
    for (const call of s.list.mock.calls) expect((call[0] as { lookup_keys: string[] }).lookup_keys.length).toBeLessThanOrEqual(10);
  });
});
