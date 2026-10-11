// @vitest-environment node
//
// The Stripe webhook lifecycle (requirement ST-3; MARKET_STRATEGY.md §5.1,
// "shared account" paragraph and the event table). Fake Prisma, fake Stripe,
// fake mail: nothing here reaches a database, Stripe or a mail provider.
//
//   1. Objects that are not ours are ignored (HTTP 200, handled false) for
//      every event type of the table; a GoApply object is never activated,
//      synced or re-branded by a Stripe event (rule A11).
//   2. The two log-only events change nothing.
//   3. Subscription events: `created` attaches the id, every event re-reads
//      the subscription before it syncs, the plan comes from the price first.
//   4. Lost-event recovery: `created` + `invoice.paid` activate without
//      `checkout.session.completed`; the return-page reconcile and the webhook
//      share one claim.
//   5. The mails the webhook owes: payment action required, and the cancel
//      confirmation for a cancellation made outside the app.
//
// The fake Stripe keeps a CURRENT copy of each subscription, apart from the
// snapshot an event carries: that difference is what the re-read is for.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('../../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../../test/fakePrisma.js');
  fake.db = createFakePrisma({ uniqueFields: { rACreditLedger: ['idempotencyKey'] } });
  return { default: fake.db };
});
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import { createStripeWebhookRouter } from '../../../roboapply/routes/stripeWebhook.js';
import { cancelPlan, handleRoboApplyStripeEvent, reconcileCheckoutSession, setBillingServiceDepsForTests } from '../../../roboapply/services/RoboApplyBillingService.js';
import { logger } from '../../../services/LoggerService.js';
import { getBrand } from '../../brand/registry.js';
import { describePlan, loadBillingAccount, resetStripeCatalogCacheForTests, setStripeClientForTests, unregisterStripeEventHandlerForTests } from '../index.js';
import { EXPECTED_STRIPE_EVENTS } from '../stripeHealth.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY_S = 86400;
const PERIOD_END_S = NOW_S + 30 * DAY_S;
const ROBOAPPLY = getBrand('roboapply');

// Prices as the catalog sync makes them: the plan is on the price itself.
const PRICE = {
  weekly: { id: 'price_w', lookup_key: 'ra_pro_weekly_usd_999_incl', currency: 'usd', unit_amount: 999, metadata: { product: 'roboapply', planKey: 'pro_weekly' } },
  monthly: { id: 'price_m', lookup_key: 'ra_pro_monthly_usd_2499_incl', currency: 'usd', unit_amount: 2499, metadata: { product: 'roboapply', planKey: 'pro_monthly' } },
  quarterly: { id: 'price_q', lookup_key: 'ra_pro_quarterly_usd_5499_incl', currency: 'usd', unit_amount: 5499, metadata: { product: 'roboapply', planKey: 'pro_quarterly' } },
};

const OUR_META = { product: 'roboapply', brand: 'roboapply', planKey: 'pro_monthly', userId: 'u_1', seekerProfileId: 'sp_1' };

function sub(id: string, over: Record<string, unknown> = {}, price: Record<string, unknown> = PRICE.monthly) {
  return {
    id,
    object: 'subscription',
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    start_date: NOW_S,
    metadata: { ...OUR_META },
    items: { data: [{ id: 'si_1', price, current_period_start: NOW_S, current_period_end: PERIOD_END_S }] },
    ...over,
  };
}

function stripeError(type: string, code: string, statusCode: number) {
  return Object.assign(new Error(`${type}: ${code}`), { type, code, statusCode });
}

/** What the fake Stripe account holds right now. */
const account = { subs: new Map<string, Record<string, any>>(), sessions: new Map<string, Record<string, any>>() };

const stripe = {
  subscriptions: {
    retrieve: vi.fn(async (id: string) => {
      const found = account.subs.get(id);
      if (!found) throw stripeError('StripeInvalidRequestError', 'resource_missing', 404);
      return found;
    }),
    update: vi.fn(async (id: string, params: Record<string, any>) => {
      const cur = account.subs.get(id) ?? sub(id);
      const next = { ...cur, ...('cancel_at_period_end' in params ? { cancel_at_period_end: params.cancel_at_period_end } : {}), metadata: { ...cur.metadata, ...(params.metadata ?? {}) } };
      account.subs.set(id, next);
      return next;
    }),
  },
  checkout: {
    sessions: {
      retrieve: vi.fn(async (id: string) => {
        const found = account.sessions.get(id);
        if (!found) throw stripeError('StripeInvalidRequestError', 'resource_missing', 404);
        return found;
      }),
    },
  },
};

/** Every Stripe call the fake saw, of any kind. */
function stripeCalls(): number {
  return stripe.subscriptions.retrieve.mock.calls.length + stripe.subscriptions.update.mock.calls.length + stripe.checkout.sessions.retrieve.mock.calls.length;
}

// Stands in for mockCreditService.grantForPlanIfNewPeriod: a grant stamps
// renewedAt; without `force` a grant is skipped when renewedAt ≥ periodStart.
const credits = { renewedAt: null as Date | null, grants: 0 };
const grantIfNewPeriod = vi.fn(async (p: { force?: boolean; periodStart: Date | null }) => {
  if (!p.force && credits.renewedAt && (p.periodStart == null || credits.renewedAt >= p.periodStart)) return 'skipped' as const;
  credits.renewedAt = p.periodStart && p.periodStart > NOW ? p.periodStart : NOW;
  credits.grants++;
  return 'granted' as const;
});
// Stands in for grantPracticePack: one grant per idempotency key (the practice ledger key).
const packs = { keys: new Set<string>(), credits: 0 };
const grantPack = vi.fn(async (p: { credits: number; idempotencyKey: string }) => {
  if (packs.keys.has(p.idempotencyKey)) return { status: 'already_granted' };
  packs.keys.add(p.idempotencyKey);
  packs.credits += p.credits;
  return { status: 'granted' };
});
const sendEmail = vi.fn(async (_input: Record<string, any>) => ({ status: 'sent' as const }));
const consumeRateLimit = vi.fn(async () => ({ allowed: true, retryAfterSec: 0 }));

const TABLES = ['seekerSubscription', 'seekerConsentRecord', 'rACreditLedger', 'user', 'seekerProfile', 'alipayOrder'];

beforeEach(() => {
  vi.clearAllMocks();
  credits.renewedAt = new Date(NOW.getTime() - DAY_S * 1000); // the free plan's grant, a day ago
  credits.grants = 0;
  packs.keys.clear();
  packs.credits = 0;
  account.subs.clear();
  account.sessions.clear();
  resetStripeCatalogCacheForTests();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_x');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
  setStripeClientForTests(stripe as never);
  for (const t of TABLES) fake.db[t].deleteMany({});
  fake.db.user.create({ data: { id: 'u_1', email: 'u_1@example.test', name: 'U', brand: 'roboapply' } });
  fake.db.seekerProfile.create({ data: { id: 'sp_1', userId: 'u_1', locale: 'en', deletedAt: null } });
  setBillingServiceDepsForTests({
    db: fake.db as never,
    getStripe: () => stripe as never,
    now: () => NOW,
    grantIfNewPeriod: grantIfNewPeriod as never,
    grantPack: grantPack as never,
    sendEmail: sendEmail as never,
    getBalance: async () => ({ credits: 0, tier: 'free', periodAllotment: 1, renewedAt: null, currentPeriodEnd: null, ephemeral: false }),
    invalidate: () => {},
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

// ── Helpers ───────────────────────────────────────────────────────────────

let seq = 0;
const ev = (type: string, object: Record<string, any>) => ({ id: `evt_${++seq}`, type, data: { object } });
const deliver = (type: string, object: Record<string, any>) => handleRoboApplyStripeEvent(ev(type, object) as never, stripe as never);

/** The buyer's row as checkout leaves it: free, with a Stripe customer. */
async function freeRow(over: Record<string, unknown> = {}) {
  return fake.db.seekerSubscription.create({
    data: { id: 'row_1', seekerProfileId: 'sp_1', tier: 'free', status: 'active', brand: 'roboapply', stripeCustomerId: 'cus_1', cancelAtPeriodEnd: false, ...over },
  });
}

/** A row on a running subscription. */
async function subscribedRow(over: Record<string, unknown> = {}) {
  return freeRow({
    tier: 'pro',
    planKey: 'pro_monthly',
    interval: 'month',
    rail: 'stripe',
    currency: 'USD',
    amountMinor: 2499,
    stripeSubscriptionId: 'sub_1',
    stripePriceId: 'price_m',
    currentPeriodEnd: new Date(PERIOD_END_S * 1000),
    ...over,
  });
}

const row = (id = 'row_1') => fake.db.seekerSubscription.findUnique({ where: { id } });
/** What the app shows and what checkout decides on: the plan status of the account. */
const planStatus = async () => describePlan((await loadBillingAccount(fake.db as never, 'u_1'))!, NOW);
const claims = async () => ((await fake.db.rACreditLedger.findMany({})) as Array<{ idempotencyKey: string }>).map((r) => r.idempotencyKey).sort();
/** Everything a webhook may write, as one comparable value. */
const everything = async () => JSON.stringify({ subs: await fake.db.seekerSubscription.findMany({}), ledger: await fake.db.rACreditLedger.findMany({}) });

const subscriptionSession = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  id: 'cs_sub_1',
  object: 'checkout.session',
  mode: 'subscription',
  status: 'complete',
  payment_status: 'paid',
  subscription: 'sub_1',
  customer: 'cus_1',
  client_reference_id: 'u_1',
  customer_details: { address: { country: 'de' } },
  metadata: { ...OUR_META, ...meta },
  ...over,
});

const passSession = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  id: 'cs_pass_1',
  object: 'checkout.session',
  mode: 'payment',
  status: 'complete',
  payment_status: 'paid',
  amount_total: 999,
  currency: 'usd',
  customer: 'cus_1',
  client_reference_id: 'u_1',
  metadata: { ...OUR_META, planKey: 'pro_week_pass', ...meta },
  ...over,
});

const packSession = (over: Record<string, unknown> = {}) => passSession({ id: 'cs_pack_1', ...over }, { planKey: 'practice_pack_5' });

const invoice = (over: Record<string, unknown> = {}) => ({
  id: 'in_1',
  object: 'invoice',
  customer: 'cus_1',
  currency: 'usd',
  amount_due: 2499,
  amount_remaining: 2499,
  billing_reason: 'subscription_cycle',
  hosted_invoice_url: 'https://invoice.stripe.test/i/acct_1/in_1',
  parent: { subscription_details: { subscription: 'sub_1' } },
  ...over,
});

const SESSION_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired'] as const;
const SUBSCRIPTION_EVENTS = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired',
] as const;
const INVOICE_EVENTS = ['invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required'] as const;
const CHARGE_EVENTS = ['charge.refunded', 'charge.dispute.created'] as const;

// ── 1. Not ours ───────────────────────────────────────────────────────────

describe('objects of another product on a shared Stripe account are ignored', () => {
  // What `stripe trigger` leaves on a shared account: well-formed objects that we never made.
  const foreign: Record<string, Record<string, any>> = {
    session: { id: 'cs_other', mode: 'subscription', payment_status: 'paid', subscription: 'sub_other', customer: 'cus_other', metadata: { product: 'robohire', planKey: 'pro_monthly', userId: 'u_1', seekerProfileId: 'sp_1' } },
    sessionNoMeta: { id: 'cs_trigger', mode: 'payment', payment_status: 'paid', customer: 'cus_other', metadata: {} },
    subscription: sub('sub_other', { customer: 'cus_other', metadata: { product: 'robohire', planKey: 'pro_monthly', seekerProfileId: 'sp_1' } }),
    subscriptionNoMeta: sub('sub_trigger', { customer: 'cus_other', metadata: {} }),
    invoice: invoice({ id: 'in_other', customer: 'cus_other', billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_other' } } }),
    charge: { id: 'ch_other', object: 'charge', customer: 'cus_other', amount: 2499, amount_refunded: 2499 },
  };
  const fixtureFor = (type: string): Array<Record<string, any>> => {
    if (type.startsWith('checkout.session.')) return [foreign.session!, foreign.sessionNoMeta!];
    if (type.startsWith('customer.subscription.')) return [foreign.subscription!, foreign.subscriptionNoMeta!];
    if (type.startsWith('invoice.')) return [foreign.invoice!];
    return [foreign.charge!];
  };

  beforeEach(async () => {
    await subscribedRow();
    // The other product's subscription exists on the account; we must not even ask for it.
    account.subs.set('sub_other', foreign.subscription!);
    account.subs.set('sub_trigger', foreign.subscriptionNoMeta!);
  });
  afterEach(() => {
    for (const type of CHARGE_EVENTS) unregisterStripeEventHandlerForTests(type);
  });

  it('the event table has fourteen types and this file covers each of them', () => {
    expect([...SESSION_EVENTS, ...SUBSCRIPTION_EVENTS, ...INVOICE_EVENTS, ...CHARGE_EVENTS].sort()).toEqual([...EXPECTED_STRIPE_EVENTS].sort());
  });

  it.each([...EXPECTED_STRIPE_EVENTS])('%s: handled false, no row changed, no Stripe call, no mail', async (type) => {
    const before = await everything();
    for (const object of fixtureFor(type)) {
      expect(await deliver(type, object), JSON.stringify(object.metadata ?? {})).toEqual({ handled: false });
    }
    expect(await everything()).toBe(before);
    expect(stripeCalls()).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
    expect(grantPack).not.toHaveBeenCalled();
  });

  it('over HTTP every one of them answers 200 with handled false', async () => {
    let next: Record<string, unknown> = {};
    const verifying = { ...stripe, webhooks: { constructEvent: vi.fn(() => next) } };
    const wh = await startRouteHarness({ mounts: [['/wh', createStripeWebhookRouter({ getStripe: () => verifying as never, secret: () => 'whsec_test' })]] });
    try {
      for (const type of EXPECTED_STRIPE_EVENTS) {
        for (const object of fixtureFor(type)) {
          next = ev(type, object);
          const res = await wh.request<any>('POST', '/wh', { headers: { 'stripe-signature': 't=1,v1=x' }, body: {} });
          expect([type, res.status, res.body]).toEqual([type, 200, { received: true, handled: false }]);
        }
      }
    } finally {
      await wh.close();
    }
  });

  it('an invoice of a customer we know, for a subscription no row tracks, is ignored unless it is that subscription\'s first invoice', async () => {
    const before = await everything();
    // sub_gone was replaced (the row is on sub_1): a renewal or failure of it changes nothing.
    for (const type of ['invoice.paid', 'invoice.payment_failed']) {
      expect(await deliver(type, invoice({ id: 'in_gone', parent: { subscription_details: { subscription: 'sub_gone' } } }))).toEqual({ handled: false });
    }
    expect(await everything()).toBe(before);
    expect(stripeCalls()).toBe(0);
  });
});

// ── Rule A11: GoApply objects ─────────────────────────────────────────────

describe('rule A11: no Stripe event activates, syncs or re-brands a GoApply object', () => {
  it.each(SESSION_EVENTS)('%s for a goapply-branded session activates nothing and still answers { handled: true }', async (type) => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1'));
    const before = await everything();
    for (const session of [subscriptionSession({}, { brand: 'goapply' }), passSession({}, { brand: 'goapply' }), packSession({ metadata: { ...OUR_META, planKey: 'practice_pack_5', brand: 'goapply' } })]) {
      expect(await deliver(type, session)).toEqual({ handled: true });
    }
    expect(await everything()).toBe(before);
    expect(stripeCalls()).toBe(0);
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
    expect(grantPack).not.toHaveBeenCalled();
  });

  describe('a stored row whose brand is goapply', () => {
    beforeEach(async () => {
      // Cannot be reached through the app (GoApply never creates a Stripe object); the row is the last line.
      await subscribedRow({ brand: 'goapply', rail: 'alipay', currency: 'CNY', amountMinor: 3900 });
      account.subs.set('sub_1', sub('sub_1', { status: 'canceled' }, PRICE.quarterly));
    });

    it.each(SUBSCRIPTION_EVENTS)('%s changes no row, answers handled false and logs one error line', async (type) => {
      const before = await everything();
      expect(await deliver(type, sub('sub_1', { status: 'canceled' }, PRICE.quarterly))).toEqual({ handled: false });
      expect(await everything()).toBe(before);
      expect((await row()).brand).toBe('goapply');
      expect(stripeCalls()).toBe(0);
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it.each(INVOICE_EVENTS)('%s changes no row, grants nothing, mails nothing and answers handled false', async (type) => {
      const before = await everything();
      for (const reason of ['subscription_cycle', 'subscription_create', 'subscription_update']) {
        expect(await deliver(type, invoice({ billing_reason: reason })), reason).toEqual({ handled: false });
      }
      expect(await everything()).toBe(before);
      expect(stripeCalls()).toBe(0);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(grantIfNewPeriod).not.toHaveBeenCalled();
      expect(vi.mocked(logger.error).mock.calls.length).toBeGreaterThan(0);
    });

    it('the first invoice of a new subscription does not attach to it either', async () => {
      const before = await everything();
      account.subs.set('sub_new', sub('sub_new'));
      const first = invoice({ id: 'in_new', billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_new' } } });
      expect(await deliver('invoice.paid', first)).toEqual({ handled: false });
      expect(await everything()).toBe(before);
      expect(stripeCalls()).toBe(0);
    });

    it('a roboapply-stamped session that points at this row fulfils nothing: subscription, pass and pack', async () => {
      const before = await everything();
      account.subs.set('sub_new', sub('sub_new'));
      for (const session of [subscriptionSession({ subscription: 'sub_new' }), passSession(), packSession()]) {
        expect(await deliver('checkout.session.completed', session), session.id).toMatchObject({ handled: false });
      }
      const after = JSON.parse(await everything());
      // Nothing of the row moved (the claims of the refused sessions are the only new rows).
      expect(JSON.stringify(after.subs)).toBe(JSON.stringify(JSON.parse(before).subs));
      expect((await row()).brand).toBe('goapply');
      expect(grantIfNewPeriod).not.toHaveBeenCalled();
      expect(grantPack).not.toHaveBeenCalled();
    });

    it('`customer.subscription.created` of a roboapply-stamped subscription does not attach to it', async () => {
      const before = await everything();
      account.subs.set('sub_new', sub('sub_new'));
      expect(await deliver('customer.subscription.created', sub('sub_new'))).toEqual({ handled: false });
      expect(await everything()).toBe(before);
    });
  });

  it('a subscription whose metadata names goapply is never attached, and Stripe is not asked about it', async () => {
    await freeRow();
    const goapply = sub('sub_cn', { metadata: { ...OUR_META, brand: 'goapply' } });
    account.subs.set('sub_cn', goapply);
    const before = await everything();
    for (const type of SUBSCRIPTION_EVENTS) expect(await deliver(type, goapply), type).toEqual({ handled: false });
    expect(await everything()).toBe(before);
    expect(stripeCalls()).toBe(0);
  });
});

// ── 2. Log-only events ────────────────────────────────────────────────────

describe('checkout.session.async_payment_failed and .expired: one log line, nothing else', () => {
  it.each(['checkout.session.async_payment_failed', 'checkout.session.expired'])('%s for our session changes no row and makes no Stripe call', async (type) => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1'));
    const before = await everything();
    for (const session of [subscriptionSession({ payment_status: 'unpaid', status: 'expired' }), passSession({ payment_status: 'unpaid' }), packSession({ payment_status: 'unpaid' })]) {
      expect(await deliver(type, session)).toEqual({ handled: true });
    }
    expect(await everything()).toBe(before);
    expect(stripeCalls()).toBe(0);
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
    expect(grantPack).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(3);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('even a session that says it is paid is not fulfilled by these two types', async () => {
    await freeRow();
    const before = await everything();
    expect(await deliver('checkout.session.expired', passSession())).toEqual({ handled: true });
    expect(await everything()).toBe(before);
  });
});

// ── 3 and 4. Subscription events ──────────────────────────────────────────

describe('customer.subscription.created attaches the subscription to its row (state only)', () => {
  it('finds the row by metadata.seekerProfileId, writes the subscription id and the customer, and grants nothing', async () => {
    await freeRow({ stripeCustomerId: null });
    account.subs.set('sub_1', sub('sub_1'));
    expect(await deliver('customer.subscription.created', sub('sub_1'))).toEqual({ handled: true });
    expect(await row()).toMatchObject({
      tier: 'pro',
      status: 'active',
      brand: 'roboapply',
      rail: 'stripe',
      planKey: 'pro_monthly',
      interval: 'month',
      currency: 'USD',
      amountMinor: 2499,
      stripeSubscriptionId: 'sub_1',
      stripeCustomerId: 'cus_1',
      stripePriceId: 'price_m',
    });
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
    expect(await claims()).toEqual([]);
  });

  it('falls back to the customer when the metadata names no profile', async () => {
    await freeRow();
    const noProfile = sub('sub_1', { metadata: { product: 'roboapply', brand: 'roboapply', planKey: 'pro_monthly' } });
    account.subs.set('sub_1', noProfile);
    expect(await deliver('customer.subscription.created', noProfile)).toEqual({ handled: true });
    expect((await row()).stripeSubscriptionId).toBe('sub_1');
  });

  it('syncs what Stripe holds now, not the snapshot (created usually says incomplete)', async () => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1', { status: 'active' }));
    expect(await deliver('customer.subscription.created', sub('sub_1', { status: 'incomplete' }))).toEqual({ handled: true });
    expect((await row()).status).toBe('active');
  });

  it('a late `created` of a subscription that has already ended attaches nothing', async () => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1', { status: 'canceled' }));
    const before = await everything();
    expect(await deliver('customer.subscription.created', sub('sub_1'))).toEqual({ handled: true });
    expect(await everything()).toBe(before);
  });

  it('a late `created` never lands on top of a running pass', async () => {
    const passEnd = new Date(NOW.getTime() + 3 * DAY_S * 1000);
    await freeRow({ tier: 'pro', planKey: 'pro_week_pass', interval: 'pass', rail: 'stripe', stripeSubscriptionId: null, currentPeriodEnd: passEnd });
    account.subs.set('sub_1', sub('sub_1', { cancel_at_period_end: true }));
    const before = await everything();
    expect(await deliver('customer.subscription.created', sub('sub_1'))).toEqual({ handled: true });
    expect(await everything()).toBe(before);
    expect(await row()).toMatchObject({ planKey: 'pro_week_pass', interval: 'pass', stripeSubscriptionId: null });
  });

  it('once the pass has ended, a new subscription attaches', async () => {
    await freeRow({ tier: 'pro', planKey: 'pro_week_pass', interval: 'pass', stripeSubscriptionId: null, currentPeriodEnd: new Date(NOW.getTime() - DAY_S * 1000) });
    account.subs.set('sub_1', sub('sub_1'));
    expect(await deliver('customer.subscription.created', sub('sub_1'))).toEqual({ handled: true });
    expect(await row()).toMatchObject({ planKey: 'pro_monthly', interval: 'month', stripeSubscriptionId: 'sub_1' });
  });

  it('no row for that profile or customer: handled false', async () => {
    account.subs.set('sub_1', sub('sub_1'));
    expect(await deliver('customer.subscription.created', sub('sub_1'))).toEqual({ handled: false });
    expect(await fake.db.seekerSubscription.findMany({})).toEqual([]);
  });

  it('only `created` attaches: any other event of a subscription on no row changes nothing', async () => {
    // The row moved on to a pass; the old subscription's later events must not come back.
    const passEnd = new Date(NOW.getTime() + 3 * DAY_S * 1000);
    await freeRow({ tier: 'pro', planKey: 'pro_week_pass', interval: 'pass', stripeSubscriptionId: null, currentPeriodEnd: passEnd });
    account.subs.set('sub_old', sub('sub_old', { status: 'canceled' }));
    const before = await everything();
    for (const type of SUBSCRIPTION_EVENTS.filter((t) => t !== 'customer.subscription.created')) {
      expect(await deliver(type, sub('sub_old', { status: 'canceled' })), type).toEqual({ handled: false });
    }
    expect(await everything()).toBe(before);
    expect(stripeCalls()).toBe(0);
  });
});

describe('lost-event recovery for subscriptions: created + invoice.paid activate without checkout.session.completed', () => {
  const firstInvoice = () => invoice({ id: 'in_first', billing_reason: 'subscription_create' });

  it('activates once and grants the period once; replays change nothing', async () => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1'));
    expect(await deliver('customer.subscription.created', sub('sub_1', { status: 'incomplete' }))).toEqual({ handled: true });
    expect(await deliver('invoice.paid', firstInvoice())).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'pro', status: 'active', planKey: 'pro_monthly', stripeSubscriptionId: 'sub_1' });
    expect(credits.grants).toBe(1);
    expect(grantIfNewPeriod).toHaveBeenLastCalledWith(expect.objectContaining({ tier: 'pro', credits: 3, periodStart: NOW }));

    const state = await everything();
    expect(await deliver('customer.subscription.created', sub('sub_1', { status: 'incomplete' }))).toEqual({ handled: true });
    expect(await deliver('invoice.paid', firstInvoice())).toEqual({ handled: true });
    expect(credits.grants).toBe(1);
    expect(JSON.parse(await everything()).ledger).toEqual(JSON.parse(state).ledger);
  });

  it('the paid invoice alone attaches and grants when `created` is late or lost too', async () => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1'));
    expect(await deliver('invoice.paid', firstInvoice())).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'pro', status: 'active', planKey: 'pro_monthly', stripeSubscriptionId: 'sub_1' });
    expect(credits.grants).toBe(1);
    expect(await deliver('customer.subscription.created', sub('sub_1'))).toEqual({ handled: true });
    expect(credits.grants).toBe(1);
  });

  it('a renewal invoice of a subscription on no row never attaches (only the first invoice does)', async () => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1'));
    const before = await everything();
    expect(await deliver('invoice.paid', invoice({ billing_reason: 'subscription_cycle' }))).toEqual({ handled: false });
    expect(await everything()).toBe(before);
    expect(stripeCalls()).toBe(0);
  });

  // created, the first paid invoice and checkout.session.completed arrive in any order.
  const three: Array<[string, () => Record<string, any>]> = [
    ['customer.subscription.created', () => sub('sub_1', { status: 'incomplete' })],
    ['invoice.paid', firstInvoice],
    ['checkout.session.completed', () => subscriptionSession()],
  ];
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  it.each(orders)('the three events in order %i, %i, %i grant the period\'s credits once and end in the same state', async (...order) => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1'));
    for (const i of order) {
      const [type, object] = three[i]!;
      expect(await deliver(type, object()), type).toMatchObject({ handled: true });
    }
    expect(credits.grants, order.map((i) => three[i]![0]).join(' → ')).toBe(1);
    expect(await row()).toMatchObject({ tier: 'pro', status: 'active', planKey: 'pro_monthly', interval: 'month', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', amountMinor: 2499 });
    // And every one of them again, in the same order: still one grant.
    for (const i of order) {
      const [type, object] = three[i]!;
      await deliver(type, object());
    }
    expect(credits.grants).toBe(1);
  });

  it('two concurrent deliveries of checkout.session.completed: one claim, one of them a duplicate, one end state', async () => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1'));
    const results = await Promise.all([deliver('checkout.session.completed', subscriptionSession()), deliver('checkout.session.completed', subscriptionSession())]);
    expect(results.filter((r) => r.duplicate).length).toBe(1);
    expect((await claims()).filter((k) => k === 'billing:checkout:cs_sub_1')).toHaveLength(1);
    expect(await row()).toMatchObject({ tier: 'pro', status: 'active', planKey: 'pro_monthly', stripeSubscriptionId: 'sub_1' });
    // The plan grant SETS the practice balance to the plan's allowance (it does
    // not add). A duplicate that still saw the free tier may write that same
    // balance again; it can never write another amount.
    expect(grantIfNewPeriod.mock.calls.every((c) => (c[0] as { credits?: number }).credits === 3)).toBe(true);
    // A third, later delivery grants nothing.
    const before = credits.grants;
    await deliver('checkout.session.completed', subscriptionSession());
    expect(credits.grants).toBe(before);
  });
});

describe('a declined first payment switches nothing on', () => {
  // Stripe creates the subscription as `incomplete` when Checkout opens the
  // payment; a decline sends invoice.payment_failed while the buyer is still
  // on the Checkout page, and the subscription stays incomplete.
  const firstInvoice = (over: Record<string, unknown> = {}) => invoice({ id: 'in_first', billing_reason: 'subscription_create', ...over });

  it('`created` of a subscription whose first payment is still open is not attached', async () => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1', { status: 'incomplete' }));
    const before = await everything();
    expect(await deliver('customer.subscription.created', sub('sub_1', { status: 'incomplete' }))).toEqual({ handled: true });
    expect(await everything()).toBe(before);
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
  });

  it('created (incomplete) then invoice.payment_failed: the account is not live, no mail is sent, and nothing was written', async () => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1', { status: 'incomplete' }));
    const before = await everything();
    expect(await deliver('customer.subscription.created', sub('sub_1', { status: 'incomplete' }))).toEqual({ handled: true });
    expect(await deliver('invoice.payment_failed', firstInvoice())).toEqual({ handled: false });
    expect(await everything()).toBe(before);
    expect(await row()).toMatchObject({ tier: 'free', status: 'active' });
    expect((await row()).stripeSubscriptionId ?? null).toBeNull();
    expect(await planStatus()).toMatchObject({ state: 'free', live: false, autoRenews: false, paymentFailed: false });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
  });

  it('a second card that works: the paid invoice attaches and grants once, and checkout.session.completed adds nothing', async () => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1', { status: 'incomplete' }));
    await deliver('customer.subscription.created', sub('sub_1', { status: 'incomplete' }));
    await deliver('invoice.payment_failed', firstInvoice());
    account.subs.set('sub_1', sub('sub_1')); // paid: Stripe says active
    // `updated` (incomplete → active) reaches no row and attaches nothing: only the money does.
    expect(await deliver('customer.subscription.updated', sub('sub_1'))).toEqual({ handled: false });
    expect(await deliver('invoice.paid', firstInvoice())).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'pro', status: 'active', planKey: 'pro_monthly', stripeSubscriptionId: 'sub_1' });
    expect(await planStatus()).toMatchObject({ live: true, autoRenews: true, paymentFailed: false });
    expect(credits.grants).toBe(1);
    expect(await deliver('checkout.session.completed', subscriptionSession())).toEqual({ handled: true });
    expect(await deliver('invoice.paid', firstInvoice())).toEqual({ handled: true });
    expect(credits.grants).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('checkout.session.completed for a subscription whose first payment is still open fulfils nothing and claims nothing', async () => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1', { status: 'incomplete' }));
    const before = await everything();
    expect(await deliver('checkout.session.completed', subscriptionSession())).toEqual({ handled: true });
    expect(await everything()).toBe(before);
    // Once it is paid, the same session is a first fulfilment.
    account.subs.set('sub_1', sub('sub_1'));
    expect(await deliver('checkout.session.completed', subscriptionSession())).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'pro', status: 'active', stripeSubscriptionId: 'sub_1' });
    expect(credits.grants).toBe(1);
  });

  it('a row that already carries an incomplete subscription is never promoted by its first failed invoice', async () => {
    await subscribedRow({ status: 'incomplete' });
    account.subs.set('sub_1', sub('sub_1', { status: 'incomplete' }));
    const before = await everything();
    expect(await deliver('invoice.payment_failed', firstInvoice())).toEqual({ handled: true });
    expect(await everything()).toBe(before);
    expect(stripeCalls()).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await planStatus()).live).toBe(false);
  });
});

describe('invoice.payment_failed follows what Stripe holds now, never the event alone', () => {
  it('a failed renewal: Stripe says past_due, so the row does, and one mail goes out; a replay sends nothing', async () => {
    await subscribedRow();
    account.subs.set('sub_1', sub('sub_1', { status: 'past_due' }));
    expect(await deliver('invoice.payment_failed', invoice({ id: 'in_fail' }))).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'pro', status: 'past_due', planKey: 'pro_monthly' });
    expect(await planStatus()).toMatchObject({ live: true, paymentFailed: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ template: 'billing.payment_failed', to: 'u_1@example.test', brand: 'roboapply', params: { planKey: 'pro_monthly', amountMinor: 2499, currency: 'USD' } }),
    );
    // Stripe retries the same invoice: every further failure is the same mail.
    expect(await deliver('invoice.payment_failed', invoice({ id: 'in_fail' }))).toEqual({ handled: true, duplicate: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await claims()).toEqual(['billing:payfail:in_fail']);
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
  });

  it('a failure delivered after the retry was paid changes nothing: no past_due, no mail, no claim', async () => {
    await subscribedRow();
    account.subs.set('sub_1', sub('sub_1')); // active again
    expect(await deliver('invoice.payment_failed', invoice({ id: 'in_fail' }))).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'pro', status: 'active' });
    expect((await planStatus()).paymentFailed).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await claims()).toEqual([]);
  });

  it('a subscription Stripe has ended in the meantime ends on the row, with no failure mail', async () => {
    await subscribedRow({ status: 'past_due' });
    account.subs.set('sub_1', sub('sub_1', { status: 'canceled' }));
    expect(await deliver('invoice.payment_failed', invoice({ id: 'in_fail' }))).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'free', status: 'canceled', planKey: 'free' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a subscription that never got past its first payment stays incomplete whatever the invoice says', async () => {
    await subscribedRow({ status: 'incomplete' });
    account.subs.set('sub_1', sub('sub_1', { status: 'incomplete' }));
    expect(await deliver('invoice.payment_failed', invoice({ id: 'in_fail', billing_reason: 'subscription_cycle' }))).toEqual({ handled: true });
    expect((await row()).status).toBe('incomplete');
    expect((await planStatus()).live).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a re-read failure is a failed event (Stripe retries) and nothing changed; a subscription Stripe no longer knows changes nothing', async () => {
    await subscribedRow();
    account.subs.set('sub_1', sub('sub_1', { status: 'past_due' }));
    const before = await everything();
    stripe.subscriptions.retrieve.mockRejectedValueOnce(stripeError('StripeAPIError', 'api_error', 500));
    expect(await deliver('invoice.payment_failed', invoice({ id: 'in_fail' }))).toEqual({ handled: false, failed: true });
    expect(await everything()).toBe(before);
    account.subs.clear();
    expect(await deliver('invoice.payment_failed', invoice({ id: 'in_fail' }))).toEqual({ handled: true });
    expect(await everything()).toBe(before);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('a row that has moved on is never taken back by an old or a second subscription', () => {
  const oldSession = () => subscriptionSession({ id: 'cs_old', subscription: 'sub_old' });
  const newSession = () => subscriptionSession({ id: 'cs_new', subscription: 'sub_2' });
  const invoiceOf = (subId: string, over: Record<string, unknown> = {}) => invoice({ parent: { subscription_details: { subscription: subId } }, ...over });

  /** History: sub_old was bought through cs_old and has ended; the buyer is now on sub_2, bought through cs_new. */
  async function onSecondSubscription() {
    await freeRow();
    account.sessions.set('cs_old', oldSession());
    account.sessions.set('cs_new', newSession());
    account.subs.set('sub_old', sub('sub_old'));
    expect(await deliver('checkout.session.completed', oldSession())).toEqual({ handled: true });
    account.subs.set('sub_old', sub('sub_old', { status: 'canceled' }));
    expect(await deliver('customer.subscription.deleted', sub('sub_old', { status: 'canceled' }))).toEqual({ handled: true });
    account.subs.set('sub_2', sub('sub_2', {}, PRICE.quarterly));
    expect(await deliver('checkout.session.completed', newSession())).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'pro', status: 'active', planKey: 'pro_quarterly', stripeSubscriptionId: 'sub_2' });
  }

  /** The events of the subscription the row is on must keep working. */
  async function currentSubscriptionStillTracked(subId: string) {
    expect(await deliver('customer.subscription.updated', account.subs.get(subId)!)).toEqual({ handled: true });
    expect(await deliver('invoice.paid', invoiceOf(subId, { id: `in_cycle_${subId}` }))).toEqual({ handled: true });
    expect((await row()).stripeSubscriptionId).toBe(subId);
  }

  it('reconciling one\'s own OLD subscription session (the return URL opened again) changes no row', async () => {
    await onSecondSubscription();
    const before = await everything();
    expect(await reconcileCheckoutSession('u_1', ROBOAPPLY, 'cs_old')).toEqual({ status: 'already_fulfilled', mode: 'subscription', planKey: 'pro_monthly' });
    expect(await everything()).toBe(before);
    await currentSubscriptionStillTracked('sub_2');
  });

  it('a resent checkout.session.completed of the old session changes no row either', async () => {
    await onSecondSubscription();
    const before = await everything();
    expect(await deliver('checkout.session.completed', oldSession())).toEqual({ handled: true, duplicate: true });
    expect(await deliver('checkout.session.async_payment_succeeded', oldSession())).toEqual({ handled: true, duplicate: true });
    expect(await everything()).toBe(before);
    await currentSubscriptionStillTracked('sub_2');
  });

  it('an old session that was never fulfilled does not end the current plan when its subscription has ended', async () => {
    await freeRow();
    account.sessions.set('cs_old', oldSession());
    account.subs.set('sub_old', sub('sub_old', { status: 'canceled' }));
    account.subs.set('sub_2', sub('sub_2'));
    await deliver('checkout.session.completed', newSession());
    const subsBefore = JSON.stringify(await fake.db.seekerSubscription.findMany({}));
    const grantsBefore = credits.grants;
    expect(await reconcileCheckoutSession('u_1', ROBOAPPLY, 'cs_old')).toEqual({ status: 'already_fulfilled', mode: 'subscription', planKey: 'pro_monthly' });
    expect(JSON.stringify(await fake.db.seekerSubscription.findMany({}))).toBe(subsBefore);
    expect(credits.grants).toBe(grantsBefore);
    await currentSubscriptionStillTracked('sub_2');
  });

  /** History: sub_old was cancelled (it runs to its period end) and the buyer bought a 7-day pass on top. */
  async function onPassAfterCancelledSubscription() {
    await freeRow();
    account.sessions.set('cs_old', oldSession());
    account.subs.set('sub_old', sub('sub_old'));
    await deliver('checkout.session.completed', oldSession());
    account.subs.set('sub_old', sub('sub_old', { cancel_at_period_end: true, metadata: { ...OUR_META, cancelSource: 'app' } }));
    await deliver('customer.subscription.updated', account.subs.get('sub_old')!);
    expect(await deliver('checkout.session.completed', passSession())).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'pro', planKey: 'pro_week_pass', interval: 'pass', stripeSubscriptionId: null });
  }

  it.each([
    ['still running to its period end', { cancel_at_period_end: true }],
    ['ended', { status: 'canceled' }],
  ])('on a running pass, the old subscription session (subscription %s) does not wipe the pass: reconcile and a resent webhook', async (_name, over) => {
    await onPassAfterCancelledSubscription();
    account.subs.set('sub_old', sub('sub_old', over));
    const before = await everything();
    expect(await reconcileCheckoutSession('u_1', ROBOAPPLY, 'cs_old')).toEqual({ status: 'already_fulfilled', mode: 'subscription', planKey: 'pro_monthly' });
    expect(await deliver('checkout.session.completed', oldSession())).toEqual({ handled: true, duplicate: true });
    expect(await everything()).toBe(before);
    expect(await row()).toMatchObject({ planKey: 'pro_week_pass', interval: 'pass', stripeSubscriptionId: null });
    expect((await planStatus()).live).toBe(true);
  });

  it('a subscription bought NOW (its session is fulfilled for the first time) does replace a running pass', async () => {
    const passEnd = new Date(NOW.getTime() + 3 * DAY_S * 1000);
    await freeRow({ tier: 'pro', planKey: 'pro_week_pass', interval: 'pass', rail: 'stripe', stripeSubscriptionId: null, currentPeriodEnd: passEnd });
    account.subs.set('sub_1', sub('sub_1'));
    expect(await deliver('checkout.session.completed', subscriptionSession())).toEqual({ handled: true });
    expect(await row()).toMatchObject({ planKey: 'pro_monthly', interval: 'month', stripeSubscriptionId: 'sub_1' });
  });

  it('a failed Stripe read claims nothing, so the retry is a first run that attaches and grants', async () => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1'));
    stripe.subscriptions.retrieve.mockRejectedValueOnce(stripeError('StripeAPIError', 'api_error', 500));
    expect(await deliver('checkout.session.completed', subscriptionSession())).toEqual({ handled: false, failed: true });
    expect(await claims()).toEqual([]);
    expect(await deliver('checkout.session.completed', subscriptionSession())).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'pro', stripeSubscriptionId: 'sub_1' });
    expect(credits.grants).toBe(1);
  });

  describe('a second subscription while the row is on a running one (two Checkout Sessions open at once)', () => {
    beforeEach(async () => {
      await subscribedRow();
      account.subs.set('sub_1', sub('sub_1'));
    });

    it('`created` of the second one, unpaid or paid, leaves the row on the first', async () => {
      const before = await everything();
      for (const status of ['incomplete', 'active']) {
        account.subs.set('sub_B', sub('sub_B', { status }, PRICE.weekly));
        expect(await deliver('customer.subscription.created', sub('sub_B', { status: 'incomplete' }, PRICE.weekly)), status).toEqual({ handled: true });
      }
      expect(await everything()).toBe(before);
      // Two paid subscriptions for one buyer: one error line for whoever watches the logs.
      expect(vi.mocked(logger.error).mock.calls.filter((c) => String(c[1]).includes('another running subscription'))).toHaveLength(1);
      await currentSubscriptionStillTracked('sub_1');
    });

    it('its first paid invoice and its checkout session do not take the row either, and grant nothing', async () => {
      account.subs.set('sub_B', sub('sub_B', {}, PRICE.weekly));
      const subsBefore = JSON.stringify(await fake.db.seekerSubscription.findMany({}));
      expect(await deliver('invoice.paid', invoiceOf('sub_B', { id: 'in_B', billing_reason: 'subscription_create' }))).toEqual({ handled: true });
      expect(await claims()).toEqual([]);
      expect(await deliver('checkout.session.completed', subscriptionSession({ id: 'cs_B', subscription: 'sub_B' }, { planKey: 'pro_weekly' }))).toEqual({ handled: true, duplicate: true });
      expect(JSON.stringify(await fake.db.seekerSubscription.findMany({}))).toBe(subsBefore);
      expect(grantIfNewPeriod).not.toHaveBeenCalled();
      expect(await claims()).not.toContain('billing:subcreate:sub_B');
      await currentSubscriptionStillTracked('sub_1');
    });

    it('once the first one is over (its period has ended, or the row says it ended), the second attaches', async () => {
      await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { currentPeriodEnd: new Date(NOW.getTime() - DAY_S * 1000) } });
      account.subs.set('sub_B', sub('sub_B', {}, PRICE.weekly));
      expect(await deliver('customer.subscription.created', sub('sub_B', {}, PRICE.weekly))).toEqual({ handled: true });
      expect(await row()).toMatchObject({ planKey: 'pro_weekly', interval: 'week', stripeSubscriptionId: 'sub_B' });
    });
  });
});

describe('the first period is granted on purpose, once, by whichever arrives first', () => {
  const firstInvoice = () => invoice({ id: 'in_first', billing_reason: 'subscription_create' });
  const forced = () => grantIfNewPeriod.mock.calls.map((c) => (c[0] as { force?: boolean }).force === true);

  // The free plan's monthly grant can land AFTER the subscription's period
  // began (the first balance read of a month, while the webhook is in flight).
  // A period-guarded grant would then skip for the whole first period.
  const freeGrantAfterPeriodStart = () => {
    credits.renewedAt = new Date(NOW.getTime() + 60_000);
  };

  it.each([
    ['created, invoice.paid, checkout.session.completed', ['created', 'paid', 'checkout'], [true, false]],
    ['created, checkout.session.completed, invoice.paid', ['created', 'checkout', 'paid'], [true, false]],
    ['invoice.paid, created, checkout.session.completed', ['paid', 'created', 'checkout'], [true, false]],
    ['checkout.session.completed, invoice.paid', ['checkout', 'paid'], [true, false]],
  ])('%s: the first of the two money events forces the grant, the second is period-guarded', async (_name, steps, expectedForce) => {
    await freeRow();
    account.subs.set('sub_1', sub('sub_1'));
    freeGrantAfterPeriodStart();
    for (const step of steps) {
      if (step === 'created') await deliver('customer.subscription.created', sub('sub_1', { status: 'incomplete' }));
      if (step === 'paid') await deliver('invoice.paid', firstInvoice());
      if (step === 'checkout') await deliver('checkout.session.completed', subscriptionSession());
    }
    expect(credits.grants).toBe(1);
    expect(forced()).toEqual(expectedForce);
    expect(await claims()).toContain('billing:subcreate:sub_1');
    // Every one of them again: nothing more.
    await deliver('invoice.paid', firstInvoice());
    await deliver('checkout.session.completed', subscriptionSession());
    expect(credits.grants).toBe(1);
  });

  it('an old first invoice sent again after a renewal forces nothing and takes no claim', async () => {
    await subscribedRow();
    const renewed = sub('sub_1', {
      start_date: NOW_S - 40 * DAY_S,
      items: { data: [{ id: 'si_1', price: PRICE.monthly, current_period_start: NOW_S - 10 * DAY_S, current_period_end: NOW_S + 20 * DAY_S }] },
    });
    account.subs.set('sub_1', renewed);
    credits.renewedAt = new Date((NOW_S - 10 * DAY_S) * 1000); // this period's grant, made at the renewal
    expect(await deliver('invoice.paid', firstInvoice())).toEqual({ handled: true });
    expect(credits.grants).toBe(0);
    expect(forced()).toEqual([false]);
    expect(await claims()).toEqual([]);
  });
});

describe('every subscription event re-reads the subscription before it syncs', () => {
  const RE_READ = SUBSCRIPTION_EVENTS.filter((t) => t !== 'customer.subscription.created');

  it.each(RE_READ)('%s asks Stripe for the current subscription, once', async (type) => {
    await subscribedRow();
    account.subs.set('sub_1', sub('sub_1'));
    expect(await deliver(type, sub('sub_1'))).toEqual({ handled: true });
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
  });

  it('a stale update does not roll back: the row follows what Stripe holds now, not the older snapshot', async () => {
    await subscribedRow({ status: 'active' });
    // Now: the retry succeeded, the subscription is active on the next period.
    const NEXT_END_S = PERIOD_END_S + 30 * DAY_S;
    const current = sub('sub_1', { status: 'active', items: { data: [{ id: 'si_1', price: PRICE.monthly, current_period_start: PERIOD_END_S, current_period_end: NEXT_END_S }] } });
    account.subs.set('sub_1', current);
    // A late delivery of an older event: past_due, the old period, cancelling.
    const stale = sub('sub_1', { status: 'past_due', cancel_at_period_end: true });
    expect(await deliver('customer.subscription.updated', stale)).toEqual({ handled: true });
    expect(await row()).toMatchObject({ status: 'active', cancelAtPeriodEnd: false });
    expect(((await row()).currentPeriodEnd as Date).toISOString()).toBe(new Date(NEXT_END_S * 1000).toISOString());
    // And a stale "deleted"-shaped snapshot inside an update cannot end a live plan either.
    expect(await deliver('customer.subscription.updated', sub('sub_1', { status: 'canceled' }))).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'pro', status: 'active', planKey: 'pro_monthly' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a portal price change records the new plan: key, interval, amount and price, whatever the metadata still says', async () => {
    await subscribedRow();
    // Changed outside the app: the price is quarterly, the metadata still says monthly.
    account.subs.set('sub_1', sub('sub_1', {}, PRICE.quarterly));
    expect(await deliver('customer.subscription.updated', sub('sub_1', {}, PRICE.quarterly))).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'pro', planKey: 'pro_quarterly', interval: 'quarter', currency: 'USD', amountMinor: 5499, stripePriceId: 'price_q' });
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
  });

  it('the paid invoice after that price change grants the NEW plan\'s allowance', async () => {
    await subscribedRow({ planKey: 'pro_quarterly', interval: 'quarter' });
    credits.renewedAt = NOW;
    const NEXT_END_S = PERIOD_END_S + 7 * DAY_S;
    account.subs.set('sub_1', sub('sub_1', { items: { data: [{ id: 'si_1', price: PRICE.weekly, current_period_start: PERIOD_END_S, current_period_end: NEXT_END_S }] } }));
    expect(await deliver('invoice.paid', invoice({ billing_reason: 'subscription_cycle' }))).toEqual({ handled: true });
    expect(grantIfNewPeriod).toHaveBeenLastCalledWith(expect.objectContaining({ credits: 1, metadata: { planKey: 'pro_weekly', stripeSubscriptionId: 'sub_1' } }));
    expect(await row()).toMatchObject({ planKey: 'pro_weekly', interval: 'week', amountMinor: 999 });
  });

  it('pending_update_applied records the new plan key, interval and amount', async () => {
    await subscribedRow();
    account.subs.set('sub_1', sub('sub_1', { metadata: { ...OUR_META, planKey: 'pro_quarterly' } }, PRICE.quarterly));
    // The event's snapshot may still show the old price: the re-read decides.
    expect(await deliver('customer.subscription.pending_update_applied', sub('sub_1'))).toEqual({ handled: true });
    expect(await row()).toMatchObject({ planKey: 'pro_quarterly', interval: 'quarter', amountMinor: 5499, stripePriceId: 'price_q' });
  });

  it('pending_update_expired leaves the old plan', async () => {
    await subscribedRow();
    // The payment was never completed: Stripe dropped the update, the subscription is still monthly.
    account.subs.set('sub_1', sub('sub_1'));
    const expired = sub('sub_1', { pending_update: null, metadata: { ...OUR_META, planKey: 'pro_quarterly' } });
    expect(await deliver('customer.subscription.pending_update_expired', expired)).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'pro', status: 'active', planKey: 'pro_monthly', interval: 'month', amountMinor: 2499, stripePriceId: 'price_m' });
  });

  it('a deleted subscription sets the row to free', async () => {
    await subscribedRow();
    account.subs.set('sub_1', sub('sub_1', { status: 'canceled' }));
    expect(await deliver('customer.subscription.deleted', sub('sub_1', { status: 'canceled' }))).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'free', status: 'canceled', planKey: 'free', interval: null });
    expect((await row()).canceledAt).toEqual(NOW);
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a deleted subscription Stripe no longer knows is ended from the event itself (deleted is final)', async () => {
    await subscribedRow();
    expect(await deliver('customer.subscription.deleted', sub('sub_1', { status: 'canceled' }))).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'free', status: 'canceled' });
  });

  it.each(SUBSCRIPTION_EVENTS)('%s: a re-read failure is a failed event, so the webhook answers 500 and Stripe retries; nothing changed', async (type) => {
    if (type === 'customer.subscription.created') await freeRow();
    else await subscribedRow();
    stripe.subscriptions.retrieve.mockRejectedValueOnce(stripeError('StripeAPIError', 'api_error', 500));
    const before = await everything();
    expect(await deliver(type, sub('sub_1', { status: 'canceled' }))).toEqual({ handled: false, failed: true });
    expect(await everything()).toBe(before);
  });

  it('for every event but `deleted`, a subscription Stripe does not know is a failure too', async () => {
    await subscribedRow();
    const before = await everything();
    for (const type of RE_READ.filter((t) => t !== 'customer.subscription.deleted')) {
      expect(await deliver(type, sub('sub_1')), type).toEqual({ handled: false, failed: true });
    }
    expect(await everything()).toBe(before);
  });

  it('over HTTP the failed re-read answers 500', async () => {
    await subscribedRow();
    const verifying = { ...stripe, webhooks: { constructEvent: vi.fn(() => ev('customer.subscription.updated', sub('sub_1'))) } };
    const wh = await startRouteHarness({ mounts: [['/wh', createStripeWebhookRouter({ getStripe: () => verifying as never, secret: () => 'whsec_test' })]] });
    try {
      // sub_1 is not on the fake account: the re-read fails.
      const res = await wh.request<any>('POST', '/wh', { headers: { 'stripe-signature': 't=1,v1=x' }, body: {} });
      expect([res.status, res.body]).toEqual([500, { received: true, handled: false }]);
    } finally {
      await wh.close();
    }
  });

  it('a legacy subscription with no product metadata is ours because its row carries the id', async () => {
    await subscribedRow({ tier: 'starter', planKey: 'starter', brand: null });
    const legacy = sub('sub_1', { metadata: { tier: 'starter' } }, { id: 'price_legacy_starter', currency: 'usd', unit_amount: 1900 });
    account.subs.set('sub_1', legacy);
    expect(await deliver('customer.subscription.updated', legacy)).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'starter', planKey: 'starter', brand: 'roboapply' });
  });
});

// ── 4. One-time payments: the return page reconciles ──────────────────────

describe('lost-event recovery for one-time payments: reconcile and the webhook share one claim', () => {
  const passEnd = () => new Date(NOW.getTime() + 7 * DAY_S * 1000).toISOString();

  it('a paid pass whose webhook never arrives is fulfilled once by reconcile; a later webhook is a duplicate', async () => {
    await freeRow();
    account.sessions.set('cs_pass_1', passSession());
    expect(await reconcileCheckoutSession('u_1', ROBOAPPLY, 'cs_pass_1')).toEqual({ status: 'fulfilled', mode: 'payment', planKey: 'pro_week_pass' });
    expect(await row()).toMatchObject({ tier: 'pro', status: 'active', planKey: 'pro_week_pass', interval: 'pass', amountMinor: 999, currency: 'USD' });
    expect(((await row()).currentPeriodEnd as Date).toISOString()).toBe(passEnd());
    expect(credits.grants).toBe(1);

    expect(await deliver('checkout.session.completed', passSession())).toEqual({ handled: true, duplicate: true });
    expect(((await row()).currentPeriodEnd as Date).toISOString()).toBe(passEnd()); // not extended twice
    expect(credits.grants).toBe(1);
    expect(await reconcileCheckoutSession('u_1', ROBOAPPLY, 'cs_pass_1')).toEqual({ status: 'already_fulfilled', mode: 'payment', planKey: 'pro_week_pass' });
    expect(((await row()).currentPeriodEnd as Date).toISOString()).toBe(passEnd());
    expect(credits.grants).toBe(1);
    expect(await claims()).toEqual(['billing:checkout:cs_pass_1']);
  });

  it('webhook then reconcile: the reconcile is the duplicate', async () => {
    await freeRow();
    account.sessions.set('cs_pass_1', passSession());
    expect(await deliver('checkout.session.completed', passSession())).toEqual({ handled: true });
    expect(await reconcileCheckoutSession('u_1', ROBOAPPLY, 'cs_pass_1')).toEqual({ status: 'already_fulfilled', mode: 'payment', planKey: 'pro_week_pass' });
    expect(((await row()).currentPeriodEnd as Date).toISOString()).toBe(passEnd());
    expect(credits.grants).toBe(1);
  });

  it.each([
    ['reconcile then webhook', ['reconcile', 'webhook']],
    ['webhook then reconcile', ['webhook', 'reconcile']],
    ['reconcile twice then webhook twice', ['reconcile', 'reconcile', 'webhook', 'webhook']],
  ])('a paid pack is granted once: %s', async (_name, steps) => {
    await freeRow();
    account.sessions.set('cs_pack_1', packSession());
    const seen: string[] = [];
    for (const step of steps) {
      if (step === 'reconcile') seen.push((await reconcileCheckoutSession('u_1', ROBOAPPLY, 'cs_pack_1')).status);
      else seen.push((await deliver('checkout.session.completed', packSession())).duplicate ? 'already_fulfilled' : 'fulfilled');
    }
    expect(seen).toEqual(['fulfilled', ...steps.slice(1).map(() => 'already_fulfilled')]);
    expect(packs.credits).toBe(5);
    expect([...packs.keys]).toEqual(['stripe:cs_pack_1']);
    expect(await claims()).toEqual(['billing:checkout:cs_pack_1']);
  });

  it('reconcile and the webhook at the same moment activate the pass once', async () => {
    await freeRow();
    account.sessions.set('cs_pass_1', passSession());
    const [a, b] = await Promise.all([reconcileCheckoutSession('u_1', ROBOAPPLY, 'cs_pass_1'), deliver('checkout.session.completed', passSession())]);
    expect([a.status === 'already_fulfilled', b.duplicate === true].filter(Boolean)).toHaveLength(1);
    expect(((await row()).currentPeriodEnd as Date).toISOString()).toBe(passEnd());
    expect(credits.grants).toBe(1);
  });

  it('a subscription session reconciles through the same claim, and the webhook after it is a duplicate that grants nothing more', async () => {
    await freeRow();
    account.sessions.set('cs_sub_1', subscriptionSession());
    account.subs.set('sub_1', sub('sub_1'));
    expect(await reconcileCheckoutSession('u_1', ROBOAPPLY, 'cs_sub_1')).toEqual({ status: 'fulfilled', mode: 'subscription', planKey: 'pro_monthly' });
    expect(await row()).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', stripeSubscriptionId: 'sub_1', billingCountry: 'DE' });
    expect(credits.grants).toBe(1);
    expect(await deliver('checkout.session.completed', subscriptionSession())).toEqual({ handled: true, duplicate: true });
    expect(await reconcileCheckoutSession('u_1', ROBOAPPLY, 'cs_sub_1')).toEqual({ status: 'already_fulfilled', mode: 'subscription', planKey: 'pro_monthly' });
    expect(credits.grants).toBe(1);
    expect(await claims()).toContain('billing:checkout:cs_sub_1');
  });

  it('an unpaid session answers pending and changes nothing; once paid it is fulfilled', async () => {
    await freeRow();
    const before = await everything();
    for (const unpaid of [passSession({ payment_status: 'unpaid', status: 'open' }), passSession({ payment_status: 'unpaid', status: 'complete' }), passSession({ payment_status: 'unpaid', status: 'expired' })]) {
      account.sessions.set('cs_pass_1', unpaid);
      expect(await reconcileCheckoutSession('u_1', ROBOAPPLY, 'cs_pass_1')).toEqual({ status: 'pending', mode: 'payment', planKey: 'pro_week_pass' });
    }
    expect(await everything()).toBe(before);
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
    account.sessions.set('cs_pass_1', passSession());
    expect((await reconcileCheckoutSession('u_1', ROBOAPPLY, 'cs_pass_1')).status).toBe('fulfilled');
  });

  it('the answer is three fields and never Stripe\'s session', async () => {
    await freeRow();
    account.sessions.set('cs_pass_1', passSession({ payment_intent: 'pi_secret', customer_details: { email: 'someone@example.test' } }));
    const out = await reconcileCheckoutSession('u_1', ROBOAPPLY, 'cs_pass_1');
    expect(Object.keys(out).sort()).toEqual(['mode', 'planKey', 'status']);
    expect(JSON.stringify(out)).not.toMatch(/pi_secret|someone@|cus_1|cs_pass_1/);
  });
});

// ── 5. Mails ──────────────────────────────────────────────────────────────

describe('invoice.payment_action_required: one mail with the hosted invoice link', () => {
  it('mails once with the link, the plan and the amount; a replay sends nothing; state does not change', async () => {
    await subscribedRow();
    const subsBefore = JSON.stringify(await fake.db.seekerSubscription.findMany({}));
    expect(await deliver('invoice.payment_action_required', invoice({ id: 'in_sca' }))).toEqual({ handled: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith({
      template: 'billing.payment_action_required',
      to: 'u_1@example.test',
      userId: 'u_1',
      locale: 'en',
      brand: 'roboapply',
      params: { planKey: 'pro_monthly', amountMinor: 2499, currency: 'USD', hostedInvoiceUrl: 'https://invoice.stripe.test/i/acct_1/in_1' },
    });
    expect(await deliver('invoice.payment_action_required', invoice({ id: 'in_sca' }))).toEqual({ handled: true, duplicate: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // past_due is invoice.payment_failed's business, not this event's.
    expect(JSON.stringify(await fake.db.seekerSubscription.findMany({}))).toBe(subsBefore);
    expect(await claims()).toEqual(['billing:payaction:in_sca']);
    expect(stripeCalls()).toBe(0);
  });

  it('the first invoice of a new subscription is not mailed: the buyer is confirming on the Checkout page', async () => {
    // The row as checkout leaves it: free, with the Stripe customer.
    await freeRow();
    const first = invoice({ id: 'in_first', billing_reason: 'subscription_create' });
    expect(await deliver('invoice.payment_action_required', first)).toEqual({ handled: true });
    expect(await deliver('invoice.payment_action_required', first)).toEqual({ handled: true });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await claims()).toEqual([]);
    expect(stripeCalls()).toBe(0);
  });

  describe('the plan the mail names', () => {
    const planInMail = () => (sendEmail.mock.calls[0]![0] as { params: { planKey: string | null } }).params.planKey;

    it('is the plan of the row that carries the invoice\'s subscription', async () => {
      await subscribedRow({ planKey: 'pro_quarterly' });
      await deliver('invoice.payment_action_required', invoice({ id: 'in_a', lines: { data: [{ price: PRICE.weekly }] } }));
      expect(planInMail()).toBe('pro_quarterly');
    });

    it.each([
      ['the current API shape (pricing.price_details.price)', { pricing: { price_details: { price: PRICE.weekly } } }],
      ['the older shape (price)', { price: PRICE.weekly }],
    ])('else the plan of a price on the invoice\'s lines: %s', async (_name, line) => {
      await freeRow();
      await deliver('invoice.payment_action_required', invoice({ id: 'in_a', billing_reason: 'subscription_update', parent: { subscription_details: { subscription: 'sub_unknown' } }, lines: { data: [{}, line] } }));
      expect(planInMail()).toBe('pro_weekly');
    });

    it('else the plan key stamped on the subscription, which the invoice carries', async () => {
      await freeRow();
      const parent = { subscription_details: { subscription: 'sub_unknown', metadata: { planKey: 'pro_quarterly' } } };
      await deliver('invoice.payment_action_required', invoice({ id: 'in_a', parent, lines: { data: [{ pricing: { price_details: { price: 'price_bare_id' } } }] } }));
      expect(planInMail()).toBe('pro_quarterly');
    });

    it('else the customer\'s row, and never the free plan: an unknown plan is null, so the mail names none', async () => {
      await freeRow({ tier: 'pro', planKey: 'pro_week_pass', interval: 'pass' });
      await deliver('invoice.payment_action_required', invoice({ id: 'in_a', parent: null }));
      expect(planInMail()).toBe('pro_week_pass');

      sendEmail.mockClear();
      await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { tier: 'free', planKey: null } });
      await deliver('invoice.payment_action_required', invoice({ id: 'in_b', parent: null }));
      await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { planKey: 'free' } });
      await deliver('invoice.payment_action_required', invoice({ id: 'in_c', parent: { subscription_details: { subscription: 'sub_unknown', metadata: { planKey: 'free' } } } }));
      expect(sendEmail.mock.calls.map((c) => (c[0] as { params: { planKey: string | null } }).params.planKey)).toEqual([null, null]);
    });
  });

  it('two deliveries at the same moment send one mail', async () => {
    await subscribedRow();
    await Promise.all([deliver('invoice.payment_action_required', invoice({ id: 'in_sca' })), deliver('invoice.payment_action_required', invoice({ id: 'in_sca' }))]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a second invoice that needs action is its own mail', async () => {
    await subscribedRow();
    await deliver('invoice.payment_action_required', invoice({ id: 'in_a' }));
    await deliver('invoice.payment_action_required', invoice({ id: 'in_b' }));
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('no mail for an invoice whose customer we do not know', async () => {
    await subscribedRow();
    expect(await deliver('invoice.payment_action_required', invoice({ id: 'in_x', customer: 'cus_stranger' }))).toEqual({ handled: false });
    expect(await deliver('invoice.payment_action_required', invoice({ id: 'in_y', customer: null }))).toEqual({ handled: false });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await claims()).toEqual([]);
  });

  it('the owner is found by the customer, as the id or as the expanded object, also for a one-time invoice with no subscription', async () => {
    await subscribedRow();
    expect(await deliver('invoice.payment_action_required', invoice({ id: 'in_obj', customer: { id: 'cus_1', object: 'customer' }, parent: null }))).toEqual({ handled: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('without a hosted invoice page there is nothing to link to: no mail and no claim, so a later event with the link still mails', async () => {
    await subscribedRow();
    expect(await deliver('invoice.payment_action_required', invoice({ id: 'in_sca', hosted_invoice_url: null }))).toEqual({ handled: true });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await claims()).toEqual([]);
    expect(await deliver('invoice.payment_action_required', invoice({ id: 'in_sca' }))).toEqual({ handled: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe('a cancellation made in the Stripe portal gets the confirmation mail, once', () => {
  const cancelling = (over: Record<string, unknown> = {}) => sub('sub_1', { cancel_at_period_end: true, ...over });

  it('sends billing.cancel_confirmed once with the plan and the date access ends; a replay sends nothing', async () => {
    await subscribedRow();
    account.subs.set('sub_1', cancelling());
    expect(await deliver('customer.subscription.updated', cancelling())).toEqual({ handled: true });
    expect((await row()).cancelAtPeriodEnd).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        template: 'billing.cancel_confirmed',
        to: 'u_1@example.test',
        userId: 'u_1',
        brand: 'roboapply',
        params: { planKey: 'pro_monthly', cancelledAt: NOW.toISOString(), accessUntil: new Date(PERIOD_END_S * 1000).toISOString() },
      }),
    );
    expect(await claims()).toEqual([`billing:cancel:sub_1:${PERIOD_END_S}`]);

    expect(await deliver('customer.subscription.updated', cancelling())).toEqual({ handled: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('two deliveries at the same moment send one mail', async () => {
    await subscribedRow();
    account.subs.set('sub_1', cancelling());
    await Promise.all([deliver('customer.subscription.updated', cancelling()), deliver('customer.subscription.updated', cancelling())]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a replay after the claim is held never mails, even if the row was reset', async () => {
    await subscribedRow();
    account.subs.set('sub_1', cancelling());
    await deliver('customer.subscription.updated', cancelling());
    await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { cancelAtPeriodEnd: false } });
    await deliver('customer.subscription.updated', cancelling());
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a cancellation made in the app still sends exactly one mail: the app\'s own', async () => {
    await subscribedRow();
    account.subs.set('sub_1', sub('sub_1'));
    const outcome = await cancelPlan('u_1', { source: 'in_app' });
    expect(outcome).toMatchObject({ status: 'cancelled', changed: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // Our cancel stamped the subscription; Stripe then tells us about the change.
    expect(account.subs.get('sub_1')).toMatchObject({ cancel_at_period_end: true, metadata: { cancelSource: 'in_app' } });
    expect(await deliver('customer.subscription.updated', account.subs.get('sub_1')!)).toEqual({ handled: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await claims()).toEqual([]);
  });

  it('the webhook that overtakes our own row update (the row still says "renews") does not mail either', async () => {
    await subscribedRow({ cancelAtPeriodEnd: false });
    for (const source of ['in_app', 'public_link', 'legacy_route']) {
      account.subs.set('sub_1', cancelling({ metadata: { ...OUR_META, cancelSource: source } }));
      await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { cancelAtPeriodEnd: false } });
      expect(await deliver('customer.subscription.updated', account.subs.get('sub_1')!)).toEqual({ handled: true });
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('after a resume cleared cancelSource, a later portal cancel is seen as coming from outside', async () => {
    await subscribedRow({ cancelAtPeriodEnd: false });
    account.subs.set('sub_1', cancelling({ metadata: { ...OUR_META, cancelSource: '' } }));
    await deliver('customer.subscription.updated', account.subs.get('sub_1')!);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a stale event that says "cancelling" does not mail when the subscription renews now', async () => {
    await subscribedRow();
    account.subs.set('sub_1', sub('sub_1'));
    await deliver('customer.subscription.updated', cancelling());
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await row()).cancelAtPeriodEnd).toBe(false);
  });

  it('a subscription that was already cancelling, or that has ended, gets no mail', async () => {
    await subscribedRow({ cancelAtPeriodEnd: true });
    account.subs.set('sub_1', cancelling());
    await deliver('customer.subscription.updated', cancelling());
    account.subs.set('sub_1', cancelling({ status: 'canceled' }));
    await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { cancelAtPeriodEnd: false } });
    await deliver('customer.subscription.deleted', cancelling({ status: 'canceled' }));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a mail that cannot be sent does not fail the event (the state is synced; Stripe need not retry)', async () => {
    await subscribedRow();
    account.subs.set('sub_1', cancelling());
    sendEmail.mockRejectedValueOnce(new Error('smtp down'));
    expect(await deliver('customer.subscription.updated', cancelling())).toEqual({ handled: true });
    expect((await row()).cancelAtPeriodEnd).toBe(true);
  });
});

// ── Kept behaviour next to the new cases ──────────────────────────────────

describe('the default branch still hands other types to the registry', () => {
  let h: RouteHarness;
  beforeAll(async () => {
    const verifying = { ...stripe, webhooks: { constructEvent: vi.fn(() => ev('payout.paid', {})) } };
    h = await startRouteHarness({ mounts: [['/wh', createStripeWebhookRouter({ getStripe: () => verifying as never, secret: () => 'whsec_test' })]] });
  });
  afterAll(async () => {
    await h.close();
  });

  it('a type nobody handles answers 200 with handled false', async () => {
    const res = await h.request<any>('POST', '/wh', { headers: { 'stripe-signature': 't=1,v1=x' }, body: {} });
    expect([res.status, res.body]).toEqual([200, { received: true, handled: false }]);
  });
});
