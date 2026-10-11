// @vitest-environment node
//
// The Stripe routes of /api/v1/roboapply/billing added by the market wave:
//
//   POST /checkout/reconcile   the return page's lost-event recovery (ST-3
//                              part 3; MARKET_STRATEGY §5.1 "Lost-event
//                              recovery"): the caller's own Checkout Session
//                              is fulfilled under the webhook's claim.
//   POST /portal               a portal session on our own configuration,
//                              optionally straight on "update payment method"
//                              (ST-7).
//
// Route harness, fake Prisma, fake Stripe: nothing reaches a database or
// Stripe. The Alipay rule tests of this router live in billing.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../test/fakePrisma.js');
  fake.db = createFakePrisma({ uniqueFields: { rACreditLedger: ['idempotencyKey'] } });
  return { default: fake.db };
});
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-user'];
    if (!id) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED' });
    req.user = { id, email: `${id}@example.test`, name: 'Test', brand: 'roboapply' };
    next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { handleRoboApplyStripeEvent, setBillingServiceDepsForTests } from '../services/RoboApplyBillingService.js';
import { setStripeClientForTests } from '../../platform/billing/index.js';
import { desiredPortalConfiguration, resetStripePortalCacheForTests } from '../../platform/billing/stripePortal.js';
import { getBrand } from '../../platform/brand/registry.js';
import billingRouter, { CHECKOUT_SESSION_ID_PATTERN } from './billing.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const PERIOD_END_S = NOW_S + 30 * 86400;
const BASE = '/api/v1/roboapply/billing';

function stripeError(type: string, code: string, statusCode: number) {
  return Object.assign(new Error(`${type}: ${code}`), { type, code, statusCode });
}

const OUR_META = { product: 'roboapply', brand: 'roboapply', planKey: 'pro_week_pass', userId: 'u_1', seekerProfileId: 'sp_1' };

const session = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  id: 'cs_test_pass0001',
  object: 'checkout.session',
  mode: 'payment',
  status: 'complete',
  payment_status: 'paid',
  amount_total: 999,
  currency: 'usd',
  customer: 'cus_1',
  client_reference_id: 'u_1',
  payment_intent: 'pi_secret_1',
  customer_details: { email: 'buyer@example.test', address: { country: 'us' } },
  metadata: { ...OUR_META, ...meta },
  ...over,
});

const account = { sessions: new Map<string, Record<string, any>>(), subs: new Map<string, Record<string, any>>(), configs: [] as Array<Record<string, any>> };

const stripe = {
  checkout: {
    sessions: {
      retrieve: vi.fn(async (id: string) => {
        const found = account.sessions.get(id);
        if (!found) throw stripeError('StripeInvalidRequestError', 'resource_missing', 404);
        return found;
      }),
      create: vi.fn(),
    },
  },
  subscriptions: {
    retrieve: vi.fn(async (id: string) => {
      const found = account.subs.get(id);
      if (!found) throw stripeError('StripeInvalidRequestError', 'resource_missing', 404);
      return found;
    }),
    update: vi.fn(),
  },
  customers: { create: vi.fn() },
  billingPortal: {
    configurations: {
      list: vi.fn(async () => ({ data: account.configs.filter((c) => c.active), has_more: false })),
      create: vi.fn(async (params: Record<string, any>) => {
        const created = { ...params, id: `bpc_${account.configs.length + 1}`, active: true, is_default: false };
        account.configs.push(created);
        return created;
      }),
      update: vi.fn(),
    },
    sessions: { create: vi.fn(async (_params: Record<string, any>) => ({ id: 'bps_1', url: 'https://billing.stripe.test/p/session/bps_1' })) },
  },
};

function stripeCalls(): number {
  return (
    stripe.checkout.sessions.retrieve.mock.calls.length +
    stripe.checkout.sessions.create.mock.calls.length +
    stripe.subscriptions.retrieve.mock.calls.length +
    stripe.subscriptions.update.mock.calls.length +
    stripe.customers.create.mock.calls.length +
    stripe.billingPortal.configurations.list.mock.calls.length +
    stripe.billingPortal.configurations.create.mock.calls.length +
    stripe.billingPortal.sessions.create.mock.calls.length
  );
}

const credits = { renewedAt: null as Date | null, grants: 0 };
const grantIfNewPeriod = vi.fn(async (p: { force?: boolean; periodStart: Date | null }) => {
  if (!p.force && credits.renewedAt && (p.periodStart == null || credits.renewedAt >= p.periodStart)) return 'skipped' as const;
  credits.renewedAt = NOW;
  credits.grants++;
  return 'granted' as const;
});
const packs = { keys: new Set<string>(), credits: 0 };
const grantPack = vi.fn(async (p: { credits: number; idempotencyKey: string }) => {
  if (!packs.keys.has(p.idempotencyKey)) {
    packs.keys.add(p.idempotencyKey);
    packs.credits += p.credits;
  }
  return {};
});
const invalidate = vi.fn();
/** A real fixed window per key, so the limit itself is under test. */
const limiter = { hits: new Map<string, number>(), down: false };
const consumeRateLimit = vi.fn(async (key: string, windows: ReadonlyArray<{ limit: number; windowSec: number }>) => {
  if (limiter.down) throw new Error('rate counter table unavailable');
  const n = (limiter.hits.get(key) ?? 0) + 1;
  limiter.hits.set(key, n);
  const w = windows[0]!;
  return n > w.limit ? { allowed: false, retryAfterSec: w.windowSec } : { allowed: true, retryAfterSec: 0 };
});

let h: RouteHarness;
let stripeOn = true;

beforeAll(async () => {
  h = await startRouteHarness({ mounts: [[BASE, billingRouter]] });
});
afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  credits.renewedAt = null;
  credits.grants = 0;
  packs.keys.clear();
  packs.credits = 0;
  limiter.hits.clear();
  limiter.down = false;
  account.sessions.clear();
  account.subs.clear();
  account.configs = [];
  stripeOn = true;
  resetStripePortalCacheForTests();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_x');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
  vi.stubEnv('NEXT_PUBLIC_ROBOAPPLY_URL', '');
  vi.stubEnv('ROBOAPPLY_URL', '');
  setStripeClientForTests(stripe as never);
  for (const t of ['seekerSubscription', 'seekerConsentRecord', 'rACreditLedger', 'user', 'seekerProfile', 'alipayOrder']) fake.db[t].deleteMany({});
  fake.db.user.create({ data: { id: 'u_1', email: 'u_1@example.test', name: 'U', brand: 'roboapply' } });
  fake.db.seekerProfile.create({ data: { id: 'sp_1', userId: 'u_1', locale: 'en', deletedAt: null } });
  fake.db.user.create({ data: { id: 'u_2', email: 'u_2@example.test', name: 'V', brand: 'roboapply' } });
  fake.db.seekerProfile.create({ data: { id: 'sp_2', userId: 'u_2', locale: 'en', deletedAt: null } });
  fake.db.user.create({ data: { id: 'u_cn', email: 'u_cn@example.test', name: 'W', brand: 'goapply' } });
  fake.db.seekerProfile.create({ data: { id: 'sp_cn', userId: 'u_cn', locale: 'zh', deletedAt: null } });
  setBillingServiceDepsForTests({
    db: fake.db as never,
    getStripe: () => (stripeOn ? (stripe as never) : null),
    now: () => NOW,
    grantIfNewPeriod: grantIfNewPeriod as never,
    grantPack: grantPack as never,
    sendEmail: (async () => ({ status: 'sent' })) as never,
    getBalance: async () => ({ credits: 0, tier: 'free', periodAllotment: 1, renewedAt: null, currentPeriodEnd: null, ephemeral: false }),
    invalidate,
    studentEnabled: async () => false,
    isStudentVerified: async () => false,
    consumeRateLimit,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  setStripeClientForTests(undefined);
  setBillingServiceDepsForTests();
});

const ROBO_HOST = 'localhost:3621';
const GO_HOST = 'goapply.localhost:3621';
const as = (user: string, host = ROBO_HOST) => ({ host, headers: { 'x-test-user': user } });
const reconcile = (body: unknown, who = as('u_1')) => h.request<any>('POST', `${BASE}/checkout/reconcile`, { ...who, body });
const row = (id = 'row_1') => fake.db.seekerSubscription.findUnique({ where: { id } });
const everything = async () => JSON.stringify({ subs: await fake.db.seekerSubscription.findMany({}), ledger: await fake.db.rACreditLedger.findMany({}) });
const customerRow = (over: Record<string, unknown> = {}) =>
  fake.db.seekerSubscription.create({ data: { id: 'row_1', seekerProfileId: 'sp_1', tier: 'free', status: 'active', brand: 'roboapply', stripeCustomerId: 'cus_1', cancelAtPeriodEnd: false, ...over } });

// ── POST /checkout/reconcile ──────────────────────────────────────────────

describe('POST /checkout/reconcile', () => {
  it('needs a signed-in user', async () => {
    const res = await h.request<any>('POST', `${BASE}/checkout/reconcile`, { host: ROBO_HOST, body: { sessionId: 'cs_test_pass0001' } });
    expect(res.status).toBe(401);
    expect(stripeCalls()).toBe(0);
  });

  it('a paid pass whose webhook never arrives is fulfilled once by the reconcile call; a later webhook is a duplicate', async () => {
    await customerRow();
    account.sessions.set('cs_test_pass0001', session());
    const first = await reconcile({ sessionId: 'cs_test_pass0001' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ success: true, data: { status: 'fulfilled', mode: 'payment', planKey: 'pro_week_pass' } });
    const end = ((await row()).currentPeriodEnd as Date).toISOString();
    expect(end).toBe(new Date(NOW.getTime() + 7 * 86_400_000).toISOString());
    expect(await row()).toMatchObject({ tier: 'pro', status: 'active', planKey: 'pro_week_pass', interval: 'pass', rail: 'stripe', brand: 'roboapply' });
    expect(credits.grants).toBe(1);
    expect(invalidate).toHaveBeenCalledWith('u_1');

    // The webhook finally arrives: same claim, nothing changes twice.
    const late = await handleRoboApplyStripeEvent({ id: 'evt_late', type: 'checkout.session.completed', data: { object: session() } } as never, stripe as never);
    expect(late).toEqual({ handled: true, duplicate: true });
    expect(((await row()).currentPeriodEnd as Date).toISOString()).toBe(end);
    expect(credits.grants).toBe(1);

    // And the return page is opened again.
    const again = await reconcile({ sessionId: 'cs_test_pass0001' });
    expect(again.body.data).toEqual({ status: 'already_fulfilled', mode: 'payment', planKey: 'pro_week_pass' });
    expect(((await row()).currentPeriodEnd as Date).toISOString()).toBe(end);
    expect(credits.grants).toBe(1);
  });

  it('a paid pack is granted once by reconcile + webhook in either order', async () => {
    const pack = session({ id: 'cs_test_pack0001' }, { planKey: 'practice_pack_15' });
    account.sessions.set('cs_test_pack0001', pack);
    const event = { id: 'evt_pack', type: 'checkout.session.completed', data: { object: pack } };

    // Reconcile first.
    await customerRow();
    expect((await reconcile({ sessionId: 'cs_test_pack0001' })).body.data).toEqual({ status: 'fulfilled', mode: 'payment', planKey: 'practice_pack_15' });
    expect(await handleRoboApplyStripeEvent(event as never, stripe as never)).toEqual({ handled: true, duplicate: true });
    expect(packs.credits).toBe(15);

    // Webhook first (a fresh account).
    await fake.db.rACreditLedger.deleteMany({});
    packs.keys.clear();
    packs.credits = 0;
    expect(await handleRoboApplyStripeEvent(event as never, stripe as never)).toEqual({ handled: true });
    expect((await reconcile({ sessionId: 'cs_test_pack0001' })).body.data).toEqual({ status: 'already_fulfilled', mode: 'payment', planKey: 'practice_pack_15' });
    expect(packs.credits).toBe(15);
    expect([...packs.keys]).toEqual(['stripe:cs_test_pack0001']);
  });

  it('a subscription session reconciles through the same claim', async () => {
    await customerRow();
    const subSession = session({ id: 'cs_test_sub00001', mode: 'subscription', subscription: 'sub_1', amount_total: 2499 }, { planKey: 'pro_monthly' });
    account.sessions.set('cs_test_sub00001', subSession);
    account.subs.set('sub_1', {
      id: 'sub_1',
      status: 'active',
      customer: 'cus_1',
      cancel_at_period_end: false,
      start_date: NOW_S,
      metadata: { ...OUR_META, planKey: 'pro_monthly' },
      items: { data: [{ id: 'si_1', price: { id: 'price_m', lookup_key: 'ra_pro_monthly_usd_2499_incl', currency: 'usd', unit_amount: 2499 }, current_period_start: NOW_S, current_period_end: PERIOD_END_S }] },
    });
    const res = await reconcile({ sessionId: 'cs_test_sub00001' });
    expect(res.body.data).toEqual({ status: 'fulfilled', mode: 'subscription', planKey: 'pro_monthly' });
    expect(await row()).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', interval: 'month', stripeSubscriptionId: 'sub_1', billingCountry: 'US' });
    expect(credits.grants).toBe(1);
    const late = await handleRoboApplyStripeEvent({ id: 'evt_sub', type: 'checkout.session.completed', data: { object: subSession } } as never, stripe as never);
    expect(late).toEqual({ handled: true, duplicate: true });
    expect(credits.grants).toBe(1);
    expect((await reconcile({ sessionId: 'cs_test_sub00001' })).body.data.status).toBe('already_fulfilled');
  });

  it('an unpaid session answers pending and changes nothing', async () => {
    await customerRow();
    const before = await everything();
    for (const unpaid of [{ payment_status: 'unpaid', status: 'open' }, { payment_status: 'unpaid', status: 'complete' }, { payment_status: 'unpaid', status: 'expired' }, { payment_status: undefined }]) {
      account.sessions.set('cs_test_pass0001', session(unpaid));
      const res = await reconcile({ sessionId: 'cs_test_pass0001' });
      expect([res.status, res.body.data]).toEqual([200, { status: 'pending', mode: 'payment', planKey: 'pro_week_pass' }]);
    }
    expect(await everything()).toBe(before);
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
    expect(grantPack).not.toHaveBeenCalled();
  });

  describe('a session that is not the caller\'s own is refused with 403 and no detail', () => {
    const refused = async (res: { status: number; body: any }) => {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, code: 'forbidden', error: 'This payment does not belong to you' });
    };

    it('another user\'s session id', async () => {
      await customerRow();
      await fake.db.seekerSubscription.create({ data: { id: 'row_2', seekerProfileId: 'sp_2', tier: 'free', status: 'active', brand: 'roboapply', stripeCustomerId: 'cus_2', cancelAtPeriodEnd: false } });
      account.sessions.set('cs_test_pass0001', session());
      const before = await everything();
      await refused(await reconcile({ sessionId: 'cs_test_pass0001' }, as('u_2')));
      expect(await everything()).toBe(before);
      expect(grantIfNewPeriod).not.toHaveBeenCalled();
      // The owner can still reconcile it.
      expect((await reconcile({ sessionId: 'cs_test_pass0001' })).body.data.status).toBe('fulfilled');
    });

    it('a session stamped with the caller\'s user id but paid by another Stripe customer', async () => {
      await customerRow();
      account.sessions.set('cs_test_pass0001', session({ customer: 'cus_someone_else' }));
      await refused(await reconcile({ sessionId: 'cs_test_pass0001' }));
      account.sessions.set('cs_test_pass0001', session({ customer: { id: 'cus_someone_else', object: 'customer' } }));
      await refused(await reconcile({ sessionId: 'cs_test_pass0001' }));
      account.sessions.set('cs_test_pass0001', session({ customer: null }));
      await refused(await reconcile({ sessionId: 'cs_test_pass0001' }));
      expect(await fake.db.rACreditLedger.findMany({})).toEqual([]);
    });

    it('a session with no user id in its metadata, even when client_reference_id names the caller', async () => {
      await customerRow();
      account.sessions.set('cs_test_pass0001', session({}, { userId: undefined }));
      await refused(await reconcile({ sessionId: 'cs_test_pass0001' }));
    });

    it('a goapply-branded session', async () => {
      await customerRow();
      account.sessions.set('cs_test_pass0001', session({}, { brand: 'goapply' }));
      const before = await everything();
      await refused(await reconcile({ sessionId: 'cs_test_pass0001' }));
      expect(await everything()).toBe(before);
    });

    it('a session of another product on the same Stripe account, with or without metadata', async () => {
      await customerRow();
      for (const meta of [{ product: 'robohire' }, { product: undefined }]) {
        account.sessions.set('cs_test_pass0001', session({}, meta));
        await refused(await reconcile({ sessionId: 'cs_test_pass0001' }));
      }
      account.sessions.set('cs_test_pass0001', session({ metadata: null }));
      await refused(await reconcile({ sessionId: 'cs_test_pass0001' }));
      account.sessions.set('cs_test_pass0001', session({ mode: 'setup' }));
      await refused(await reconcile({ sessionId: 'cs_test_pass0001' }));
    });

    it('a request on the GoApply host never reaches Stripe', async () => {
      await fake.db.seekerSubscription.create({ data: { id: 'row_cn', seekerProfileId: 'sp_cn', tier: 'free', status: 'active', brand: 'goapply', cancelAtPeriodEnd: false } });
      account.sessions.set('cs_test_pass0001', session({}, { userId: 'u_cn', seekerProfileId: 'sp_cn' }));
      await refused(await reconcile({ sessionId: 'cs_test_pass0001' }, as('u_cn', GO_HOST)));
      expect(stripeCalls()).toBe(0);
      expect(consumeRateLimit).not.toHaveBeenCalled();
    });

    it('a GoApply account asking on the RoboApply host', async () => {
      await fake.db.seekerSubscription.create({ data: { id: 'row_cn', seekerProfileId: 'sp_cn', tier: 'free', status: 'active', brand: 'goapply', cancelAtPeriodEnd: false } });
      account.sessions.set('cs_test_pass0001', session({}, { userId: 'u_cn', seekerProfileId: 'sp_cn' }));
      const before = await everything();
      await refused(await reconcile({ sessionId: 'cs_test_pass0001' }, as('u_cn')));
      expect(await everything()).toBe(before);
      expect(stripeCalls()).toBe(0);
    });
  });

  it('an account that has no Stripe customer yet can reconcile its own session (the first purchase)', async () => {
    // No SeekerSubscription row at all: nothing to compare the customer with.
    account.sessions.set('cs_test_pack0001', session({ id: 'cs_test_pack0001' }, { planKey: 'practice_pack_5' }));
    const res = await reconcile({ sessionId: 'cs_test_pack0001' });
    expect(res.body.data).toEqual({ status: 'fulfilled', mode: 'payment', planKey: 'practice_pack_5' });
    expect(packs.credits).toBe(5);
  });

  it('a session Stripe does not know answers 404 not_found', async () => {
    await customerRow();
    const res = await reconcile({ sessionId: 'cs_test_unknown01' });
    expect([res.status, res.body.code]).toEqual([404, 'not_found']);
  });

  it('a Stripe failure answers 502 payment_provider_error, on the session read and on the subscription read', async () => {
    await customerRow();
    stripe.checkout.sessions.retrieve.mockRejectedValueOnce(stripeError('StripeAPIError', 'api_error', 500));
    const res = await reconcile({ sessionId: 'cs_test_pass0001' });
    expect([res.status, res.body.code, res.body.details]).toEqual([502, 'payment_provider_error', { provider: 'stripe' }]);

    account.sessions.set('cs_test_sub00001', session({ id: 'cs_test_sub00001', mode: 'subscription', subscription: 'sub_1' }, { planKey: 'pro_monthly' }));
    stripe.subscriptions.retrieve.mockRejectedValueOnce(stripeError('StripeConnectionError', 'network', 0));
    const sub = await reconcile({ sessionId: 'cs_test_sub00001' });
    expect([sub.status, sub.body.code]).toEqual([502, 'payment_provider_error']);
  });

  it('without a Stripe client it answers 503 stripe_not_configured', async () => {
    stripeOn = false;
    const res = await reconcile({ sessionId: 'cs_test_pass0001' });
    expect([res.status, res.body.code]).toEqual([503, 'stripe_not_configured']);
    expect(stripeCalls()).toBe(0);
  });

  it.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['a number', { sessionId: 12345678901 }],
    ['not a session id', { sessionId: 'pi_3Abcdefgh12345' }],
    ['too short', { sessionId: 'cs_1234567' }],
    ['a path in it', { sessionId: 'cs_test_abc/../../v1/customers' }],
    ['a query in it', { sessionId: 'cs_test_abcdefgh?expand[]=customer' }],
    ['spaces around it', { sessionId: ' cs_test_pass0001 ' }],
    ['longer than 200', { sessionId: `cs_${'a'.repeat(201)}` }],
    ['an extra field', { sessionId: 'cs_test_pass0001', userId: 'u_2' }],
  ])('422 invalid_request for %s, before Stripe is asked', async (_name, body) => {
    const res = await reconcile(body);
    expect([res.status, res.body.code]).toEqual([422, 'invalid_request']);
    expect(stripeCalls()).toBe(0);
  });

  it('accepts the session ids Stripe hands out', () => {
    for (const id of ['cs_test_a1B2c3D4e5F6g7H8i9J0', 'cs_live_a1B2c3D4e5F6g7H8i9J0', `cs_${'a'.repeat(200)}`, 'cs_12345678']) expect(CHECKOUT_SESSION_ID_PATTERN.test(id), id).toBe(true);
  });

  it('is limited to 10 calls a minute per user: the 11th answers 429 rate_limited with Retry-After, and another user is not affected', async () => {
    await customerRow();
    account.sessions.set('cs_test_pass0001', session({ payment_status: 'unpaid' }));
    for (let i = 0; i < 10; i += 1) expect((await reconcile({ sessionId: 'cs_test_pass0001' })).status).toBe(200);
    const blocked = await reconcile({ sessionId: 'cs_test_pass0001' });
    expect([blocked.status, blocked.body.code, blocked.body.details]).toEqual([429, 'rate_limited', { retryAfterSec: 60 }]);
    expect(blocked.headers.get('retry-after')).toBe('60');
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(10);
    expect(consumeRateLimit.mock.calls[0]![1]).toEqual([{ limit: 10, windowSec: 60 }]);
    expect(consumeRateLimit.mock.calls[0]![0]).toContain('u_1');
    const other = await reconcile({ sessionId: 'cs_test_pass0001' }, as('u_2'));
    expect(other.status).toBe(403); // not theirs, but not rate limited
  });

  it('a rate limiter that cannot answer does not block the recovery of a paid order', async () => {
    await customerRow();
    limiter.down = true;
    account.sessions.set('cs_test_pass0001', session());
    expect((await reconcile({ sessionId: 'cs_test_pass0001' })).body.data.status).toBe('fulfilled');
  });

  it('the route never returns Stripe\'s session object', async () => {
    await customerRow();
    account.sessions.set('cs_test_pass0001', session());
    const res = await reconcile({ sessionId: 'cs_test_pass0001' });
    expect(Object.keys(res.body.data).sort()).toEqual(['mode', 'planKey', 'status']);
    expect(res.text).not.toMatch(/pi_secret_1|buyer@example\.test|cus_1|client_reference_id|payment_intent|cs_test_pass0001/);
  });
});

// ── POST /portal ──────────────────────────────────────────────────────────

describe('POST /portal', () => {
  const portal = (body?: unknown, who = as('u_1')) => h.request<any>('POST', `${BASE}/portal`, { ...who, ...(body === undefined ? {} : { body }) });

  it('opens a session on OUR portal configuration, created on first use, and returns only the url', async () => {
    await customerRow();
    const res = await portal();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { url: 'https://billing.stripe.test/p/session/bps_1' } });
    expect(stripe.billingPortal.configurations.create).toHaveBeenCalledTimes(1);
    const desired = desiredPortalConfiguration(getBrand('roboapply'));
    expect(stripe.billingPortal.configurations.create.mock.calls[0]![0]).toEqual(desired);
    expect(desired.features!.subscription_update).toEqual({ enabled: false });
    expect(desired.business_profile).toEqual({ privacy_policy_url: 'https://www.roboapply.io/legal/privacy', terms_of_service_url: 'https://www.roboapply.io/legal/terms' });
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({ customer: 'cus_1', return_url: 'https://www.roboapply.io/settings/billing', configuration: 'bpc_1' });
  });

  it('every portal session carries the configuration; the configuration is created once and then reused without a Stripe call', async () => {
    await customerRow();
    await portal();
    await portal({});
    await portal({ flow: 'payment_method_update' });
    expect(stripe.billingPortal.configurations.list).toHaveBeenCalledTimes(1);
    expect(stripe.billingPortal.configurations.create).toHaveBeenCalledTimes(1);
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledTimes(3);
    for (const call of stripe.billingPortal.sessions.create.mock.calls) expect(call[0]).toMatchObject({ configuration: 'bpc_1', customer: 'cus_1' });
  });

  it('flow payment_method_update is passed through as flow_data; without it no flow_data is sent', async () => {
    await customerRow();
    await portal({ flow: 'payment_method_update' });
    expect(stripe.billingPortal.sessions.create).toHaveBeenLastCalledWith({
      customer: 'cus_1',
      return_url: 'https://www.roboapply.io/settings/billing',
      configuration: 'bpc_1',
      flow_data: { type: 'payment_method_update' },
    });
    await portal();
    expect(stripe.billingPortal.sessions.create.mock.calls[1]![0]).not.toHaveProperty('flow_data');
  });

  it('a user without a Stripe customer gets 409 no_customer and Stripe is not called', async () => {
    const none = await portal();
    expect([none.status, none.body.code]).toEqual([409, 'no_customer']);
    await customerRow({ stripeCustomerId: null });
    const empty = await portal({ flow: 'payment_method_update' });
    expect([empty.status, empty.body.code]).toEqual([409, 'no_customer']);
    expect(stripeCalls()).toBe(0);
  });

  it('503 stripe_not_configured without a Stripe client', async () => {
    await customerRow();
    stripeOn = false;
    const res = await portal();
    expect([res.status, res.body.code]).toEqual([503, 'stripe_not_configured']);
  });

  it('a Stripe failure answers 502 payment_provider_error, from the configuration and from the session', async () => {
    await customerRow();
    stripe.billingPortal.configurations.list.mockRejectedValueOnce(stripeError('StripeAPIError', 'api_error', 500));
    const cfg = await portal();
    expect([cfg.status, cfg.body.code]).toEqual([502, 'payment_provider_error']);
    stripe.billingPortal.sessions.create.mockRejectedValueOnce(stripeError('StripeInvalidRequestError', 'parameter_invalid', 400));
    const sess = await portal();
    expect([sess.status, sess.body.code]).toEqual([502, 'payment_provider_error']);
    // The failure was not remembered.
    expect((await portal()).status).toBe(200);
  });

  it.each([
    ['an unknown flow', { flow: 'subscription_update' }],
    ['a flow that is not a string', { flow: true }],
    ['an extra field', { flow: 'payment_method_update', customer: 'cus_2' }],
    ['a return url from the client', { returnUrl: 'https://evil.example/' }],
  ])('422 invalid_request for %s, before Stripe is asked', async (_name, body) => {
    await customerRow();
    const res = await portal(body);
    expect([res.status, res.body.code]).toEqual([422, 'invalid_request']);
    expect(stripeCalls()).toBe(0);
  });

  it('a GoApply request never opens a Stripe portal, even for a row that carries a customer id', async () => {
    await fake.db.seekerSubscription.create({ data: { id: 'row_cn', seekerProfileId: 'sp_cn', tier: 'free', status: 'active', brand: 'goapply', stripeCustomerId: 'cus_cn', cancelAtPeriodEnd: false } });
    const res = await portal({}, as('u_cn', GO_HOST));
    expect([res.status, res.body.code]).toEqual([409, 'no_customer']);
    expect(stripeCalls()).toBe(0);
  });

  it('needs a signed-in user', async () => {
    const res = await h.request<any>('POST', `${BASE}/portal`, { host: ROBO_HOST, body: {} });
    expect(res.status).toBe(401);
  });
});
