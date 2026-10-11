// @vitest-environment node
//
// The statutory withdrawal over HTTP (ST-9; MARKET_STRATEGY §4.4 "Statutory
// withdrawal" and "Cancel"):
//   signed in    GET + POST /credits/withdrawal
//   no sign-in   POST /api/v1/public/cancel/preview, and /confirm with `withdraw`
// Who may withdraw, how much goes back and the Stripe calls are the refund
// engine's (platform/billing/stripeRefunds.ts, tested in stripeRefunds.test.ts).
// These tests hold what the routes add: the wire shapes, the brand wall, the
// rate limit, a link that a preview does not use up, the fall-back to the
// ordinary cancellation, and what the service keeps of a withdrawal that failed
// at the payment provider (its instant, so that sending it again finishes it
// as it was asked for). In-memory Prisma, and a fake Stripe installed with
// `setStripeClientForTests` (the service asks the one client factory): nothing
// here reaches Stripe.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { billingEventClaimKey, setStripeClientForTests } from '../../platform/billing/index.js';
import { CreditsAreaService, createCreditsRouter, createPublicCancelRouter, hashToken, type CreditsAreaDeps, type CreditsDb } from './index.js';
import { PUBLIC_CANCEL_PREVIEW_LIMIT, WITHDRAWAL_DECLARATION_DAYS, WITHDRAWAL_LIMIT, WITHDRAWAL_RETRY_LIMIT } from './service.js';

const DAY_S = 86_400;
/** The purchase instant. */
const T0 = new Date('2026-10-05T08:00:00.000Z');
const T0_S = Math.floor(T0.getTime() / 1000);
const at = (days: number) => new Date(T0.getTime() + days * DAY_S * 1000);
const clock = { now: at(5) };

const ENV = { NODE_ENV: 'test', NEXT_PUBLIC_ROBOAPPLY_URL: 'https://www.roboapply.io' };
const RA = { host: 'localhost:3621' };
const GO = { host: 'goapply.localhost:3621' };

// ── The fake Stripe account ───────────────────────────────────────────────

type Obj = Record<string, any>;
const account = {
  invoices: new Map<string, Obj>(),
  /** invoice id → its payments. */
  payments: new Map<string, Obj[]>(),
  subscriptions: new Map<string, Obj>(),
  refunds: [] as Obj[],
  /** Every call that reaches the fake, in order: 'resource.method'. */
  calls: [] as string[],
  seq: 0,
  /** Stripe cannot be reached for refunds (every `refunds.create` fails) until this is set back. */
  refundsDown: false,
};

function stripeError(over: Obj): Error {
  return Object.assign(new Error(over.message ?? 'stripe error'), over);
}

const stripe = {
  invoices: {
    retrieve: vi.fn(async (id: string) => {
      account.calls.push('invoices.retrieve');
      const inv = account.invoices.get(id);
      if (!inv) throw stripeError({ code: 'resource_missing', statusCode: 404, type: 'StripeInvalidRequestError', message: `No such invoice: '${id}'` });
      return inv;
    }),
    list: vi.fn(async (params: { customer: string; status?: string; limit?: number; created?: { gte?: number } }) => {
      account.calls.push('invoices.list');
      const data = [...account.invoices.values()]
        .filter((i) => i.customer === params.customer && (!params.status || i.status === params.status) && i.created >= (params.created?.gte ?? 0))
        .sort((a, b) => b.created - a.created)
        .slice(0, params.limit ?? 10);
      return { data };
    }),
  },
  invoicePayments: {
    list: vi.fn(async (params: { invoice?: string }) => {
      account.calls.push('invoicePayments.list');
      return { data: account.payments.get(params.invoice ?? '') ?? [] };
    }),
  },
  subscriptions: {
    retrieve: vi.fn(async (id: string) => {
      account.calls.push('subscriptions.retrieve');
      const sub = account.subscriptions.get(id);
      if (!sub) throw stripeError({ code: 'resource_missing', statusCode: 404, message: `No such subscription: '${id}'` });
      return sub;
    }),
    cancel: vi.fn(async (id: string, _params: Obj, _opts: { idempotencyKey: string }) => {
      account.calls.push('subscriptions.cancel');
      const sub = account.subscriptions.get(id);
      if (!sub) throw stripeError({ code: 'resource_missing', statusCode: 404, message: `No such subscription: '${id}'` });
      return sub;
    }),
  },
  refunds: {
    create: vi.fn(async (params: Obj, _opts: { idempotencyKey: string }) => {
      account.calls.push('refunds.create');
      if (account.refundsDown) throw stripeError({ type: 'StripeConnectionError', message: 'socket hang up' });
      const refund = {
        id: `re_${++account.seq}`,
        amount: params.amount ?? account.invoices.get(invoiceOf(params.payment_intent))?.amount_paid ?? 0,
        currency: 'usd',
        charge: `ch_${params.payment_intent}`,
        payment_intent: params.payment_intent,
        metadata: params.metadata,
        status: 'succeeded',
        created: T0_S + account.seq,
      };
      account.refunds.push(refund);
      return refund;
    }),
    list: vi.fn(async (params: { payment_intent?: string }) => {
      account.calls.push('refunds.list');
      return { data: account.refunds.filter((r) => r.payment_intent === params.payment_intent) };
    }),
  },
};

/** The invoice a payment intent paid (the fake names it `pi_<invoice id>`). */
const invoiceOf = (paymentIntent: string) => paymentIntent.replace(/^pi_/, '');

/** The calls that change something at Stripe, in the order they were made (a call that was made to fail counts too). */
const writes = () =>
  [
    ...stripe.subscriptions.cancel.mock.invocationCallOrder.map((order) => ({ order, name: 'subscriptions.cancel' })),
    ...stripe.refunds.create.mock.invocationCallOrder.map((order) => ({ order, name: 'refunds.create' })),
  ]
    .sort((a, b) => a.order - b.order)
    .map((c) => c.name);
const refundCall = (n = 0) => stripe.refunds.create.mock.calls[n] as unknown as [Obj, { idempotencyKey: string }];
const cancelCall = (n = 0) => stripe.subscriptions.cancel.mock.calls[n] as unknown as [string, Obj, { idempotencyKey: string }];

/** The line of a subscription invoice: the period that invoice paid for (`periodDays` from `startS`). */
function subscriptionLine(periodDays: number, startS: number = T0_S, over: Obj = {}): Obj {
  return {
    id: 'il_1',
    amount: 2499,
    period: { start: startS, end: startS + periodDays * DAY_S },
    parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_1', subscription_item: 'si_1', proration: false } },
    ...over,
  };
}

/** The first invoice of the monthly plan, as `invoices.list` returns it: paid at T0 for the 30 days from T0. */
function subscriptionInvoice(over: Obj = {}): Obj {
  return {
    id: 'in_1',
    customer: 'cus_1',
    status: 'paid',
    amount_paid: 2499,
    currency: 'usd',
    created: T0_S,
    status_transitions: { paid_at: T0_S },
    billing_reason: 'subscription_create',
    metadata: {},
    parent: { subscription_details: { subscription: 'sub_1', metadata: { product: 'roboapply', brand: 'roboapply', planKey: 'pro_monthly' } } },
    lines: { data: [subscriptionLine(30)] },
    ...over,
  };
}

/** A practice pack bought `day` days after the plan (Checkout creates an invoice for a one-time payment too). */
function packInvoice(day: number): Obj {
  return {
    id: 'in_pack',
    customer: 'cus_1',
    status: 'paid',
    amount_paid: 999,
    currency: 'usd',
    created: T0_S + day * DAY_S,
    status_transitions: { paid_at: T0_S + day * DAY_S },
    billing_reason: 'manual',
    metadata: { product: 'roboapply', brand: 'roboapply', planKey: 'practice_pack_5', userId: 'u_1' },
    parent: null,
  };
}

function addInvoice(invoice: Obj): void {
  account.invoices.set(invoice.id, invoice);
  account.payments.set(invoice.id, [{ id: `inpay_${invoice.id}`, status: 'paid', payment: { type: 'payment_intent', payment_intent: `pi_${invoice.id}` } }]);
}

// ── The service under test ────────────────────────────────────────────────

let db: ReturnType<typeof createFakePrisma>;
const sendEmail = vi.fn(async (_input: Obj) => ({ status: 'sent' }));
/** The ordinary cancellation (at period end), as RoboApplyBillingService.cancelPlan answers it. */
const cancel = vi.fn();
const invalidated: string[] = [];
const rateHits = new Map<string, number>();
const rateLimit = vi.fn(async (key: string, windows: ReadonlyArray<{ limit: number; windowSec: number }>) => {
  const n = (rateHits.get(key) ?? 0) + 1;
  rateHits.set(key, n);
  return n <= windows[0]!.limit;
});

function service(): CreditsAreaService {
  // No `getStripe` here: the service asks the one client factory, where the fake is installed.
  const deps: Partial<CreditsAreaDeps> = {
    db: async () => db as unknown as CreditsDb,
    env: () => ENV,
    now: () => clock.now,
    cancel,
    sendEmail,
    rateLimit,
    invalidateEntitlements: (u) => void invalidated.push(u),
  };
  return new CreditsAreaService(deps);
}

let h: RouteHarness;
const seeker = { id: 'u_1', email: 'u@example.test', role: 'seeker' };
const goSeeker = { id: 'u_go', email: 'go@example.test', role: 'seeker' };

beforeAll(async () => {
  const deps = { service: service(), seekerAuth: [fakeAuth(seeker)], env: ENV };
  h = await startRouteHarness({
    env: ENV,
    mounts: [
      ['/api/v1/roboapply/credits', createCreditsRouter(deps)],
      ['/go/credits', createCreditsRouter({ ...deps, seekerAuth: [fakeAuth(goSeeker)] })],
      ['/api/v1/public/cancel', createPublicCancelRouter(deps)],
    ],
  });
});

afterAll(async () => {
  await h.close();
});

/** The buyer of these tests: a German subscriber on the monthly plan, bought at T0. */
async function seedBuyer(over: { waiver?: boolean; billingCountry?: string | null } = {}): Promise<void> {
  await db.seekerSubscription.update({ where: { id: 'row_1' }, data: { billingCountry: over.billingCountry === undefined ? 'DE' : over.billingCountry } });
  if (over.waiver) {
    await db.seekerConsentRecord.create({ data: { seekerProfileId: 'sp_1', consentType: 'withdrawal_waiver', granted: true, createdAt: new Date(T0.getTime() - 60_000) } });
  }
}

beforeEach(() => {
  // Reset, not clear: a "fail once" a test queued and never used must not reach the next test.
  // Each mock goes back to the implementation it was created with.
  vi.resetAllMocks();
  account.invoices.clear();
  account.payments.clear();
  account.subscriptions.clear();
  account.refunds = [];
  account.calls = [];
  account.seq = 0;
  account.refundsDown = false;
  invalidated.length = 0;
  rateHits.clear();
  clock.now = at(5);
  db = createFakePrisma({
    uniqueFields: { rACreditLedger: ['idempotencyKey'], rABillingRefund: ['externalRef'], rAAuthToken: ['tokenHash'] },
    seed: {
      user: [
        { id: 'u_1', email: 'u@example.test', name: 'U', brand: 'roboapply' },
        { id: 'u_go', email: 'go@example.test', name: 'G', brand: 'goapply' },
      ],
      seekerProfile: [
        { id: 'sp_1', userId: 'u_1', locale: 'de', market: 'other' },
        { id: 'sp_go', userId: 'u_go', locale: 'zh', market: 'cn' },
      ],
      seekerSubscription: [
        { id: 'row_1', seekerProfileId: 'sp_1', tier: 'pro', status: 'active', brand: 'roboapply', rail: 'stripe', planKey: 'pro_monthly', interval: 'month', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', currentPeriodEnd: at(30), cancelAtPeriodEnd: false, billingCountry: 'DE' },
        // A GoApply pass. It carries a customer id here only to prove that even then nothing is asked of Stripe.
        { id: 'row_go', seekerProfileId: 'sp_go', tier: 'pro', status: 'active', brand: 'goapply', rail: 'alipay', planKey: 'pro_monthly', interval: 'pass', stripeSubscriptionId: null, stripeCustomerId: 'cus_go', currentPeriodEnd: at(30), cancelAtPeriodEnd: false, billingCountry: 'DE' },
      ],
    },
  });
  addInvoice(subscriptionInvoice());
  account.subscriptions.set('sub_1', { id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ id: 'si_1', current_period_start: T0_S, current_period_end: T0_S + 30 * DAY_S }] } });
  cancel.mockImplementation(async () => ({ status: 'cancelled', accessUntil: at(30), planKey: 'pro_monthly', changed: true, account: {} }));
  setStripeClientForTests(stripe as never);
});

afterEach(() => {
  setStripeClientForTests(undefined);
});

const WITHDRAWAL = '/api/v1/roboapply/credits/withdrawal';
const PLAN_PURCHASE = { source: 'stripe', id: 'in_1', planKey: 'pro_monthly', chargedAt: T0.toISOString(), amountMinor: 2499, currency: 'USD' };
const PRORATA_QUOTE = {
  rule: 'withdrawal_14d_prorata',
  refundMinor: 2082, // floor(2499 × 25 / 30)
  currency: 'USD',
  deadline: at(14).toISOString(),
  prorata: { usedDays: 5, periodDays: 30 },
  endsAccess: true,
  region: 'eu',
};
const FULL_QUOTE = { rule: 'withdrawal_14d', refundMinor: 2499, currency: 'USD', deadline: at(14).toISOString(), prorata: null, endsAccess: true, region: 'eu' };
const NONE = { available: false, purchase: null, quote: null, purchases: [] };

const claims = async () => ((await db.rACreditLedger.findMany({})) as Obj[]).map((r) => r.idempotencyKey);
/** The claim that closes a purchase (the engine's), and the claim that keeps the instant of a failed attempt (this service's). */
const DONE = billingEventClaimKey('withdraw:in_1');
const DECLARED = billingEventClaimKey('withdraw-declared:in_1');
/** What Stripe answers when it cannot be reached. */
const stripeDown = () => stripeError({ type: 'StripeConnectionError', message: 'socket hang up' });
/** Ten minutes before the purchase's 14th day ends, and twenty minutes after it. */
const BEFORE_DEADLINE = new Date(at(14).getTime() - 10 * 60_000);
const AFTER_DEADLINE = new Date(at(14).getTime() + 20 * 60_000);
/** With the waiver, on day 14 of 30: 16 unused days. */
const LAST_DAY_REFUND = 1332; // floor(2499 × 16 / 30)

describe('GET /credits/withdrawal (quote)', () => {
  it('a German subscriber who ticked the waiver, on day 5 of 30, is quoted 25/30 of the price', async () => {
    await seedBuyer({ waiver: true });
    const res = await h.request<any>('GET', WITHDRAWAL, RA);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ available: true, purchase: PLAN_PURCHASE, quote: PRORATA_QUOTE, purchases: [{ purchase: PLAN_PURCHASE, quote: PRORATA_QUOTE }] });
    // A quote reads: nothing changes at Stripe or in the database.
    expect(writes()).toEqual([]);
    expect(await claims()).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('the same buyer without the waiver is quoted the full price', async () => {
    await seedBuyer();
    const res = await h.request<any>('GET', WITHDRAWAL, RA);
    expect(res.body.data).toEqual({ available: true, purchase: PLAN_PURCHASE, quote: FULL_QUOTE, purchases: [{ purchase: PLAN_PURCHASE, quote: FULL_QUOTE }] });
  });

  it('Norway, the United Kingdom and Taiwan have the same right, each under its own region', async () => {
    for (const [country, region] of [['NO', 'eu'], ['GB', 'uk'], ['TW', 'tw']] as const) {
      await seedBuyer({ billingCountry: country });
      const res = await h.request<any>('GET', WITHDRAWAL, RA);
      expect(res.body.data.quote, country).toMatchObject({ rule: 'withdrawal_14d', refundMinor: 2499, region });
    }
  });

  it('a US buyer, a buyer with no known country, day 15 and a renewal all get available false', async () => {
    await seedBuyer({ billingCountry: 'US' });
    expect((await h.request<any>('GET', WITHDRAWAL, RA)).body.data).toEqual(NONE);
    await seedBuyer({ billingCountry: null });
    expect((await h.request<any>('GET', WITHDRAWAL, RA)).body.data).toEqual(NONE);
    await seedBuyer({ billingCountry: 'DE' });
    clock.now = new Date(at(14).getTime() + 1);
    expect((await h.request<any>('GET', WITHDRAWAL, RA)).body.data).toEqual(NONE);
    clock.now = at(5);
    addInvoice(subscriptionInvoice({ billing_reason: 'subscription_cycle' }));
    expect((await h.request<any>('GET', WITHDRAWAL, RA)).body.data).toEqual(NONE);
    expect(writes()).toEqual([]);
  });

  it('a GoApply buyer always gets available false, and Stripe is never asked', async () => {
    const res = await h.request<any>('GET', '/go/credits/withdrawal', GO);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(NONE);
    expect(account.calls).toEqual([]);
  });

  it('lists every open purchase, the latest first: a pack bought on day 3 does not hide the plan', async () => {
    await seedBuyer();
    addInvoice(packInvoice(3));
    const res = await h.request<any>('GET', WITHDRAWAL, RA);
    const pack = { source: 'stripe', id: 'in_pack', planKey: 'practice_pack_5', chargedAt: at(3).toISOString(), amountMinor: 999, currency: 'USD' };
    const packQuote = { ...FULL_QUOTE, refundMinor: 999, deadline: at(17).toISOString() };
    expect(res.body.data.purchases).toEqual([
      { purchase: pack, quote: packQuote },
      { purchase: PLAN_PURCHASE, quote: FULL_QUOTE },
    ]);
    // `purchase` and `quote` are the first entry, for a reader that shows one.
    expect(res.body.data).toMatchObject({ available: true, purchase: pack, quote: packQuote });
    // On day 16 the plan is out of its 14 days; the pack of day 3 still has one.
    clock.now = at(16);
    expect((await h.request<any>('GET', WITHDRAWAL, RA)).body.data.purchases.map((p: Obj) => p.purchase.id)).toEqual(['in_pack']);
  });

  it('a renewal paid inside the 14 days belongs to its purchase: a weekly plan on day 10 shows both charges', async () => {
    await db.seekerSubscription.update({ where: { id: 'row_1' }, data: { planKey: 'pro_weekly', interval: 'week' } });
    const weekly = (over: Obj) =>
      subscriptionInvoice({ amount_paid: 999, parent: { subscription_details: { subscription: 'sub_1', metadata: { planKey: 'pro_weekly' } } }, lines: { data: [subscriptionLine(7)] }, ...over });
    const renewalS = T0_S + 7 * DAY_S;
    addInvoice(weekly({}));
    addInvoice(weekly({ id: 'in_renewal', created: renewalS - 3600, status_transitions: { paid_at: renewalS }, billing_reason: 'subscription_cycle', lines: { data: [subscriptionLine(7, renewalS)] } }));
    clock.now = at(10);
    const res = await h.request<any>('GET', WITHDRAWAL, RA);
    expect(res.body.data.purchases).toHaveLength(1);
    expect(res.body.data.purchase).toMatchObject({ id: 'in_1', planKey: 'pro_weekly', amountMinor: 1998 });
    expect(res.body.data.quote).toMatchObject({ rule: 'withdrawal_14d', refundMinor: 1998, deadline: at(14).toISOString() });
  });

  it('as built, pending the owner (decision 21): a plan-switch invoice is a purchase of its own, with its own 14 days', async () => {
    await seedBuyer();
    const switchedS = T0_S + 20 * DAY_S;
    addInvoice(
      subscriptionInvoice({
        id: 'in_switch',
        amount_paid: 3000,
        created: switchedS,
        status_transitions: { paid_at: switchedS },
        billing_reason: 'subscription_update',
        parent: { subscription_details: { subscription: 'sub_1', metadata: { planKey: 'pro_quarterly' } } },
        lines: { data: [subscriptionLine(90, switchedS)] },
      }),
    );
    clock.now = at(22);
    const res = await h.request<any>('GET', WITHDRAWAL, RA);
    // The original purchase is out of its 14 days; the switch opened new ones.
    expect(res.body.data.purchases.map((p: Obj) => [p.purchase.id, p.purchase.planKey, p.quote.refundMinor, p.quote.deadline])).toEqual([
      ['in_switch', 'pro_quarterly', 3000, at(34).toISOString()],
    ]);
  });

  it('where card payments are not set up there is nothing to withdraw from; a Stripe failure is 502, not "nothing"', async () => {
    await seedBuyer();
    setStripeClientForTests(null);
    expect((await h.request<any>('GET', WITHDRAWAL, RA)).body.data).toEqual(NONE);
    setStripeClientForTests(stripe as never);
    stripe.invoices.list.mockRejectedValueOnce(stripeError({ type: 'StripeConnectionError', message: 'socket hang up' }));
    const failed = await h.request<any>('GET', WITHDRAWAL, RA);
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe('payment_provider_error');
  });
});

describe('POST /credits/withdrawal (confirm)', () => {
  const post = (body: unknown, opts = RA, path = WITHDRAWAL) => h.request<any>('POST', path, { ...opts, body });
  const CONFIRM = { purchaseId: 'in_1', confirm: true };

  it('day 5 of 30 with the waiver: the subscription is cancelled at once, then 25/30 is refunded, and Pro ends', async () => {
    await seedBuyer({ waiver: true });
    const res = await post(CONFIRM);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'withdrawn', refundMinor: 2082, currency: 'USD', accessEnded: true });
    // Cancel first, then refund: access ends whatever amount goes back.
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
    expect(cancelCall()).toEqual(['sub_1', {}, { idempotencyKey: 'withdraw:sub_1' }]);
    const [params, opts] = refundCall();
    expect(params).toEqual({
      payment_intent: 'pi_in_1',
      amount: 2082,
      reason: 'requested_by_customer',
      metadata: { product: 'roboapply', userId: 'u_1', actor: 'self', kind: 'withdrawal', planKey: 'pro_monthly', reason: 'withdrawal' },
    });
    expect(opts).toEqual({ idempotencyKey: 'refund:pi_in_1:2082:withdrawal' });
    // One confirmation mail, sent by the engine through this service's mailer.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith({
      template: 'billing.withdrawal_confirmed',
      to: 'u@example.test',
      userId: 'u_1',
      locale: 'de',
      brand: 'roboapply',
      params: { planKey: 'pro_monthly', amountMinor: 2082, currency: 'USD', withdrawnAt: at(5).toISOString() },
    });
    // The cached plan is dropped; the row itself ends when customer.subscription.deleted is processed.
    expect(invalidated).toEqual(['u_1']);
    expect(await claims()).toEqual([billingEventClaimKey('withdraw:in_1')]);
    // The ordinary period-end cancellation was not run.
    expect(cancel).not.toHaveBeenCalled();
  });

  it('without the waiver the whole price goes back', async () => {
    await seedBuyer();
    const res = await post(CONFIRM);
    expect(res.body.data).toEqual({ status: 'withdrawn', refundMinor: 2499, currency: 'USD', accessEnded: true });
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
    expect(refundCall()[0]).not.toHaveProperty('amount');
    expect(refundCall()[1]).toEqual({ idempotencyKey: 'refund:pi_in_1:full:withdrawal' });
  });

  it('a stale purchaseId answers 409 and cancels nothing', async () => {
    await seedBuyer({ waiver: true });
    const res = await post({ purchaseId: 'in_stale', confirm: true });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'withdrawal_not_available' });
    expect(writes()).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await claims()).toEqual([]);
    expect(invalidated).toEqual([]);
    // The right id still works afterwards.
    expect((await post(CONFIRM)).status).toBe(200);
  });

  it('a second POST answers 409 (already withdrawn) and refunds nothing more', async () => {
    await seedBuyer({ waiver: true });
    expect((await post(CONFIRM)).status).toBe(200);
    const again = await post(CONFIRM);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('withdrawal_not_available');
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // And the quote is gone.
    expect((await h.request<any>('GET', WITHDRAWAL, RA)).body.data).toEqual(NONE);
  });

  it('two POSTs at the same moment send the same two idempotency keys, so Stripe refunds once; one mail', async () => {
    await seedBuyer({ waiver: true });
    // Hold both requests at the cancel call until the second one has arrived, so they really overlap.
    let arrived = 0;
    let open!: () => void;
    const both = new Promise<void>((resolve) => (open = resolve));
    const held = async (id: string) => {
      account.calls.push('subscriptions.cancel');
      if (++arrived === 2) open();
      await both;
      return account.subscriptions.get(id)!;
    };
    stripe.subscriptions.cancel.mockImplementationOnce(held).mockImplementationOnce(held);
    const [a, b] = await Promise.all([post(CONFIRM), post(CONFIRM)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data).toEqual(b.body.data);
    expect(stripe.subscriptions.cancel.mock.calls.map((c) => c[2])).toEqual([{ idempotencyKey: 'withdraw:sub_1' }, { idempotencyKey: 'withdraw:sub_1' }]);
    expect(stripe.refunds.create.mock.calls.map((c) => c[1])).toEqual([{ idempotencyKey: 'refund:pi_in_1:2082:withdrawal' }, { idempotencyKey: 'refund:pi_in_1:2082:withdrawal' }]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await claims()).toEqual([billingEventClaimKey('withdraw:in_1')]);
  });

  it('day 15, a US buyer and a GoApply buyer answer 409; GoApply never reaches Stripe', async () => {
    await seedBuyer({ waiver: true });
    clock.now = at(15);
    expect((await post(CONFIRM)).status).toBe(409);
    clock.now = at(5);
    await seedBuyer({ billingCountry: 'US' });
    expect((await post(CONFIRM)).body.code).toBe('withdrawal_not_available');
    expect(writes()).toEqual([]);

    account.calls = [];
    const go = await post(CONFIRM, GO, '/go/credits/withdrawal');
    expect(go.status).toBe(409);
    expect(go.body.code).toBe('withdrawal_not_available');
    expect(account.calls).toEqual([]);
  });

  it('the buyer chooses the purchase: the plan is withdrawn by its id while the pack stays open', async () => {
    await seedBuyer();
    addInvoice(packInvoice(3));
    const res = await post(CONFIRM);
    expect(res.body.data).toMatchObject({ status: 'withdrawn', refundMinor: 2499 });
    expect(refundCall()[0].payment_intent).toBe('pi_in_1');
    expect((await h.request<any>('GET', WITHDRAWAL, RA)).body.data.purchases.map((p: Obj) => p.purchase.id)).toEqual(['in_pack']);
    // The pack: a refund, and no subscription to cancel.
    const pack = await post({ purchaseId: 'in_pack', confirm: true });
    expect(pack.body.data).toEqual({ status: 'withdrawn', refundMinor: 999, currency: 'USD', accessEnded: true });
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create', 'refunds.create']);
    expect(refundCall(1)[0].payment_intent).toBe('pi_in_pack');
  });

  it('is limited to 3 an hour per user: the fourth answers 429 and reaches neither the engine nor Stripe', async () => {
    await seedBuyer({ waiver: true });
    expect(WITHDRAWAL_LIMIT).toEqual([{ limit: 3, windowSec: 3600 }]);
    for (let i = 0; i < 3; i++) expect((await post({ purchaseId: 'in_stale', confirm: true })).status).toBe(409);
    account.calls = [];
    const limited = await post(CONFIRM);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toBe('3600');
    expect(account.calls).toEqual([]);
    expect(rateLimit).toHaveBeenLastCalledWith('rl:roboapply:withdrawal:user:u_1', WITHDRAWAL_LIMIT);
  });

  it('needs purchaseId and confirm: true, and takes nothing else (422); nothing is sent to Stripe', async () => {
    await seedBuyer({ waiver: true });
    for (const body of [{ purchaseId: 'in_1' }, { purchaseId: 'in_1', confirm: false }, { confirm: true }, { purchaseId: '', confirm: true }, { purchaseId: 'in_1', confirm: true, amountMinor: 1 }, {}]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(account.calls).toEqual([]);
    // A refused body does not use up the hourly allowance.
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it('503 where card payments are not set up', async () => {
    await seedBuyer({ waiver: true });
    setStripeClientForTests(null);
    const res = await post(CONFIRM);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('rail_not_configured');
    expect(invalidated).toEqual([]);
  });

  it('502 when Stripe fails at the refund; sending it again finishes with the same keys, and then it is closed', async () => {
    await seedBuyer({ waiver: true });
    stripe.refunds.create.mockRejectedValueOnce(stripeError({ type: 'StripeConnectionError', message: 'socket hang up' }));
    const failed = await post(CONFIRM);
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe('payment_provider_error');
    // The answer names the provider and nothing of the failure's own text (it is logged).
    expect(failed.body.details).toEqual({ provider: 'stripe' });
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
    expect(sendEmail).not.toHaveBeenCalled();
    // The subscription is cancelled at Stripe by now: the cached plan is dropped although the call failed.
    expect(invalidated).toEqual(['u_1']);
    // The instant of the failed request is kept: the withdrawal is declared, not yet complete.
    expect(await claims()).toEqual([DECLARED]);

    account.subscriptions.set('sub_1', { ...account.subscriptions.get('sub_1'), status: 'canceled' });
    const retry = await post(CONFIRM);
    expect(retry.body.data).toEqual({ status: 'withdrawn', refundMinor: 2082, currency: 'USD', accessEnded: true });
    expect(cancelCall(1)[2]).toEqual(cancelCall(0)[2]);
    expect(refundCall(1)[1]).toEqual(refundCall(0)[1]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await claims()).toEqual([DECLARED, DONE]);
    expect((await post(CONFIRM)).status).toBe(409);
  });

  it('a refund the provider itself refuses after the cancel answers 409 with the reason, never an unknown code', async () => {
    await seedBuyer({ waiver: true });
    stripe.refunds.create.mockRejectedValueOnce(stripeError({ type: 'StripeInvalidRequestError', code: 'charge_already_refunded', message: 'Charge has already been refunded.' }));
    const res = await post(CONFIRM);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'withdrawal_not_available', details: { reason: 'refund_refused' } });
    expect(invalidated).toEqual(['u_1']);
    // A final answer, not a failure to finish later: no instant is kept.
    expect(await claims()).toEqual([]);
  });

  // M4 cross-review. "Already refunded" is the one refusal after which nothing more can go back. Any other request
  // Stripe rejects is a refund that was never made: the buyer has no plan and no refund, so the instant is kept.
  it('a refund Stripe refuses for another reason after the cancel keeps the instant: 502, the purchase stays listed at the quoted amount, and sent again it finishes', async () => {
    await seedBuyer({ waiver: true });
    stripe.refunds.create.mockRejectedValueOnce(stripeError({ type: 'StripeInvalidRequestError', code: 'parameter_unknown', message: "Received unknown parameter: foo on account 'acct_1EXAMPLE'" }));
    const failed = await post(CONFIRM);
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe('payment_provider_error');
    expect(failed.body.details).toEqual({ provider: 'stripe' });
    expect(JSON.stringify(failed.body)).not.toMatch(/acct_|parameter/);
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
    expect(invalidated).toEqual(['u_1']);
    // The declaration is the row staff can find (carry-over "declared and not completed").
    expect(await claims()).toEqual([DECLARED]);
    expect(((await db.rACreditLedger.findMany({})) as Obj[])[0]).toMatchObject({ userId: 'u_1', refType: 'stripe_withdrawal_declared', refId: 'withdraw-declared:in_1', settledAt: at(5) });
    expect(sendEmail).not.toHaveBeenCalled();

    // A day later the page still lists it at the amount of the first request (25 unused days, not 24).
    account.subscriptions.set('sub_1', { ...account.subscriptions.get('sub_1'), status: 'canceled' });
    clock.now = at(6.5);
    const listed = (await h.request<any>('GET', WITHDRAWAL, RA)).body.data;
    expect(listed.quote).toMatchObject({ rule: 'withdrawal_14d_prorata', refundMinor: 2082, prorata: { usedDays: 5, periodDays: 30 } });
    const retry = await post(CONFIRM);
    expect(retry.body.data).toEqual({ status: 'withdrawn', refundMinor: 2082, currency: 'USD', accessEnded: true });
    expect(await claims()).toEqual([DECLARED, DONE]);
  });

  it('a refusal with no Stripe code at all is not final either', async () => {
    await seedBuyer({ waiver: true });
    stripe.refunds.create.mockRejectedValueOnce(stripeError({ type: 'StripeInvalidRequestError', message: 'This PaymentIntent cannot be refunded.' }));
    const failed = await post(CONFIRM);
    expect(failed.status).toBe(502);
    expect(await claims()).toEqual([DECLARED]);
  });

  it('a purchase whose payment cannot be resolved cancels nothing: 409 before the subscription is touched', async () => {
    await seedBuyer({ waiver: true });
    // The invoice is listed as paid, and no paid payment can be found for it.
    account.payments.set('in_1', []);
    const res = await post(CONFIRM);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('withdrawal_not_available');
    // Nothing happened, so it is not the "ended and refused" answer.
    expect(res.body.details?.reason).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(invalidated).toEqual([]);
    expect(await claims()).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a failure while reading never puts the provider\'s or the database\'s own text into the answer', async () => {
    await seedBuyer({ waiver: true });
    stripe.invoices.list.mockRejectedValueOnce(stripeError({ type: 'StripeAuthenticationError', message: 'Invalid API Key provided: sk_live_********************abcd' }));
    const read = await h.request<any>('GET', WITHDRAWAL, RA);
    expect(read.status).toBe(502);
    expect(read.body.details).toEqual({ provider: 'stripe' });
    // A database read inside the same block (the completion claim) fails with a Prisma text.
    const prismaText = "\nInvalid `prisma.rACreditLedger.findUnique()` invocation in\n/var/task/server/src/platform/billing/stripeRefunds.ts:1110:44\n\nCan't reach database server at `ep-internal-host.neon.tech:5432`";
    const findUnique = vi.spyOn(db.rACreditLedger, 'findUnique').mockRejectedValue(new Error(prismaText));
    const failed = await h.request<any>('GET', WITHDRAWAL, RA);
    findUnique.mockRestore();
    expect(failed.status).toBe(502);
    expect(failed.body.details).toEqual({ provider: 'stripe' });
    expect(JSON.stringify([read.body, failed.body])).not.toMatch(/sk_live|neon\.tech|var\/task|prisma/);
  });
});

// A request the buyer confirmed in time is a withdrawal declared in time. When
// the payment provider fails after that, the service keeps the instant, and the
// same request sent again is decided as of it.
describe('a withdrawal that failed at the payment provider is finished as it was asked for', () => {
  const post = (body: unknown = { purchaseId: 'in_1', confirm: true }) => h.request<any>('POST', WITHDRAWAL, { ...RA, body });
  const get = () => h.request<any>('GET', WITHDRAWAL, RA);
  const declaredRow = async () => ((await db.rACreditLedger.findMany({})) as Obj[]).find((r) => r.idempotencyKey === DECLARED);
  /** The subscription was ended at Stripe by the first attempt. */
  const endedAtStripe = () => account.subscriptions.set('sub_1', { ...account.subscriptions.get('sub_1'), status: 'canceled' });

  it('the refund fails ten minutes before the 14th day ends; sent again after it, the buyer still gets the quoted amount', async () => {
    await seedBuyer({ waiver: true });
    clock.now = BEFORE_DEADLINE;
    expect((await get()).body.data.quote).toMatchObject({ rule: 'withdrawal_14d_prorata', refundMinor: LAST_DAY_REFUND, prorata: { usedDays: 14, periodDays: 30 }, deadline: at(14).toISOString() });
    stripe.refunds.create.mockRejectedValueOnce(stripeDown());
    const failed = await post();
    expect(failed.status).toBe(502);
    // The subscription is ended at Stripe by now, and nothing was refunded.
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
    expect(account.refunds).toEqual([]);
    expect(await declaredRow()).toMatchObject({ userId: 'u_1', bucket: 'billing_event', refType: 'stripe_withdrawal_declared', refId: 'withdraw-declared:in_1', settledAt: BEFORE_DEADLINE });
    endedAtStripe();

    clock.now = AFTER_DEADLINE;
    // The page still lists the purchase, at the amount quoted then, and says until when it can be sent again.
    const listed = (await get()).body.data;
    expect(listed.available).toBe(true);
    expect(listed.purchases).toHaveLength(1);
    expect(listed.quote).toMatchObject({
      rule: 'withdrawal_14d_prorata',
      refundMinor: LAST_DAY_REFUND,
      prorata: { usedDays: 14, periodDays: 30 },
      deadline: new Date(BEFORE_DEADLINE.getTime() + WITHDRAWAL_DECLARATION_DAYS * DAY_S * 1000).toISOString(),
    });

    const retry = await post();
    expect(retry.status).toBe(200);
    expect(retry.body.data).toEqual({ status: 'withdrawn', refundMinor: LAST_DAY_REFUND, currency: 'USD', accessEnded: true });
    // The same two Stripe requests as the first attempt, key for key.
    expect(cancelCall(1)[2]).toEqual({ idempotencyKey: 'withdraw:sub_1' });
    expect(refundCall(1)).toEqual([expect.objectContaining({ payment_intent: 'pi_in_1', amount: LAST_DAY_REFUND }), { idempotencyKey: `refund:pi_in_1:${LAST_DAY_REFUND}:withdrawal` }]);
    expect(refundCall(1)[1]).toEqual(refundCall(0)[1]);
    // One mail, dated at the moment the buyer withdrew.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({ template: 'billing.withdrawal_confirmed', params: { amountMinor: LAST_DAY_REFUND, withdrawnAt: BEFORE_DEADLINE.toISOString() } });
    expect(await claims()).toEqual([DECLARED, DONE]);
    // Complete: closed for good, and no longer listed.
    expect((await post()).status).toBe(409);
    expect((await get()).body.data).toEqual(NONE);
    expect(stripe.refunds.create).toHaveBeenCalledTimes(2);
  });

  it('without that first request, the same moment after the 14th day is refused (the instant is what carries it)', async () => {
    await seedBuyer({ waiver: true });
    clock.now = AFTER_DEADLINE;
    expect((await get()).body.data).toEqual(NONE);
    expect((await post()).status).toBe(409);
    expect(writes()).toEqual([]);
    expect(await claims()).toEqual([]);
  });

  it('sent again on a later day it refunds the days quoted at the first request, not one day fewer', async () => {
    await seedBuyer({ waiver: true });
    stripe.refunds.create.mockRejectedValueOnce(stripeDown());
    expect((await post()).status).toBe(502);
    endedAtStripe();
    clock.now = at(6.5);
    // Asked now for the first time, day 7 of 30 would return 23/30.
    const retry = await post();
    expect(retry.body.data).toMatchObject({ status: 'withdrawn', refundMinor: 2082 });
    expect(refundCall(1)[1]).toEqual({ idempotencyKey: 'refund:pi_in_1:2082:withdrawal' });
  });

  it('Stripe cannot be read at all: nothing is ended, the instant is still kept, and the request sent again is decided as of it', async () => {
    await seedBuyer();
    clock.now = BEFORE_DEADLINE;
    stripe.invoices.list.mockRejectedValueOnce(stripeDown());
    const failed = await post();
    expect(failed.status).toBe(502);
    expect(writes()).toEqual([]);
    expect(await claims()).toEqual([DECLARED]);
    clock.now = AFTER_DEADLINE;
    const retry = await post();
    expect(retry.body.data).toEqual({ status: 'withdrawn', refundMinor: 2499, currency: 'USD', accessEnded: true });
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
  });

  it('three failures in a row do not use up the hourly allowance: sending it again has its own, wider limit', async () => {
    await seedBuyer({ waiver: true });
    expect(WITHDRAWAL_RETRY_LIMIT).toEqual([{ limit: 10, windowSec: 3600 }]);
    stripe.refunds.create.mockRejectedValueOnce(stripeDown()).mockRejectedValueOnce(stripeDown()).mockRejectedValueOnce(stripeDown());
    for (let i = 0; i < 3; i++) expect((await post()).status, `attempt ${i + 1}`).toBe(502);
    // Only the first request counted against the three an hour.
    expect(rateHits.get('rl:roboapply:withdrawal:user:u_1')).toBe(1);
    expect(rateHits.get('rl:roboapply:withdrawal:retry:user:u_1')).toBe(2);
    expect(rateLimit).toHaveBeenLastCalledWith('rl:roboapply:withdrawal:retry:user:u_1', WITHDRAWAL_RETRY_LIMIT);
    const fourth = await post();
    expect(fourth.status).toBe(200);
    expect(fourth.body.data).toMatchObject({ status: 'withdrawn', refundMinor: 2082 });
    // The instant is the first one: a later failure does not move it.
    expect((await declaredRow())!.settledAt).toEqual(at(5));
    // Every attempt sent the same refund key, so Stripe moves the money once.
    expect(new Set(stripe.refunds.create.mock.calls.map((c) => c[1].idempotencyKey))).toEqual(new Set(['refund:pi_in_1:2082:withdrawal']));
  });

  it('sending it again is bounded too: past its limit the request answers 429 and reaches neither the engine nor Stripe', async () => {
    await seedBuyer({ waiver: true });
    account.refundsDown = true;
    expect((await post()).status).toBe(502);
    for (let i = 0; i < 10; i++) expect((await post()).status, `retry ${i + 1}`).toBe(502);
    account.calls = [];
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toBe('3600');
    expect(account.calls).toEqual([]);
  });

  it('the instant holds for 14 days and no longer: after that the purchase is neither listed nor withdrawn', async () => {
    await seedBuyer({ waiver: true });
    clock.now = BEFORE_DEADLINE;
    stripe.refunds.create.mockRejectedValueOnce(stripeDown());
    expect((await post()).status).toBe(502);
    expect(WITHDRAWAL_DECLARATION_DAYS).toBe(14);
    const lastMoment = new Date(BEFORE_DEADLINE.getTime() + 14 * DAY_S * 1000);
    clock.now = lastMoment;
    expect((await get()).body.data.purchases.map((p: Obj) => p.purchase.id)).toEqual(['in_1']);
    clock.now = new Date(lastMoment.getTime() + 1);
    expect((await get()).body.data).toEqual(NONE);
    stripe.refunds.create.mockClear();
    const late = await post();
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('withdrawal_not_available');
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    // Decided now, as a first request: it counts against the three an hour again.
    expect(rateLimit).toHaveBeenLastCalledWith('rl:roboapply:withdrawal:user:u_1', WITHDRAWAL_LIMIT);
  });

  it('a refusal is never kept: a stale id, a purchase past its 14 days and a brand without card payments leave no instant behind', async () => {
    await seedBuyer({ waiver: true });
    expect((await post({ purchaseId: 'in_stale', confirm: true })).status).toBe(409);
    clock.now = AFTER_DEADLINE;
    expect((await post()).status).toBe(409);
    clock.now = at(5);
    setStripeClientForTests(null);
    expect((await post()).status).toBe(503);
    expect(await claims()).toEqual([]);
  });

  it("the instant belongs to the buyer who was refused it: another account's claim under the same purchase id is not read", async () => {
    await seedBuyer({ waiver: true });
    await db.rACreditLedger.create({
      data: { userId: 'u_other', bucket: 'billing_event', amount: 0, status: 'committed', fromSource: 'stripe', idempotencyKey: DECLARED, refType: 'stripe_withdrawal_declared', refId: 'withdraw-declared:in_1', settledAt: at(1) },
    });
    // Decided now (day 5), not on day 1, and counted as a first request.
    const res = await post();
    expect(res.body.data).toMatchObject({ status: 'withdrawn', refundMinor: 2082 });
    expect(rateLimit).toHaveBeenLastCalledWith('rl:roboapply:withdrawal:user:u_1', WITHDRAWAL_LIMIT);
    expect((await h.request<any>('GET', WITHDRAWAL, RA)).body.data).toEqual(NONE);
  });

  it('a pack bought since is listed beside the declared plan, each at its own amount, the latest purchase first', async () => {
    await seedBuyer();
    clock.now = BEFORE_DEADLINE;
    stripe.refunds.create.mockRejectedValueOnce(stripeDown());
    expect((await post()).status).toBe(502);
    endedAtStripe();
    addInvoice(packInvoice(12));
    clock.now = AFTER_DEADLINE;
    const listed = (await get()).body.data.purchases;
    expect(listed.map((p: Obj) => [p.purchase.id, p.quote.refundMinor, p.quote.deadline])).toEqual([
      ['in_pack', 999, at(26).toISOString()],
      ['in_1', 2499, new Date(BEFORE_DEADLINE.getTime() + 14 * DAY_S * 1000).toISOString()],
    ]);
    // The pack is withdrawn as of now; the plan as of its declaration.
    expect((await post({ purchaseId: 'in_pack', confirm: true })).body.data).toMatchObject({ refundMinor: 999 });
    expect((await post()).body.data).toMatchObject({ refundMinor: 2499 });
    expect((await get()).body.data).toEqual(NONE);
  });
});

// ── The emailed cancel link ───────────────────────────────────────────────

const PUBLIC = '/api/v1/public/cancel';

/** Ask for the link as the public page does and read the token out of the mail. */
async function requestLink(): Promise<string> {
  const res = await h.request<any>('POST', PUBLIC, { ...RA, body: { email: 'u@example.test' } });
  expect(res.status).toBe(204);
  const mail = sendEmail.mock.calls.map((c) => c[0]).find((m) => m.template === 'billing.cancel_link');
  expect(mail, 'the cancel link mail').toBeDefined();
  sendEmail.mockClear();
  return new URL(mail!.params.url).searchParams.get('token')!;
}

const tokenRow = async () => ((await db.rAAuthToken.findMany({})) as Obj[])[0]!;
/** The (only) link was claimed. A fresh link has no `consumedAt`; a released one has null. */
const linkUsed = async () => ((await tokenRow()).consumedAt ?? null) !== null;
const preview = (token: string, opts = RA) => h.request<any>('POST', `${PUBLIC}/preview`, { ...opts, body: { token } });
const confirm = (body: Obj, opts = RA) => h.request<any>('POST', `${PUBLIC}/confirm`, { ...opts, body });

describe('public cancel link: POST /preview', () => {
  it('says what the link can do without using it up: confirm still works afterwards', async () => {
    await seedBuyer({ waiver: true });
    const token = await requestLink();
    const res = await preview(token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      planKey: 'pro_monthly',
      accessUntil: at(30).toISOString(),
      withdrawal: { refundMinor: 2082, currency: 'USD', rule: 'withdrawal_14d_prorata', deadline: at(14).toISOString() },
    });
    expect(await tokenRow()).toMatchObject({ tokenHash: hashToken(token) });
    expect(await linkUsed()).toBe(false);
    // Any number of previews, then the link is still good for one confirm.
    expect((await preview(token)).status).toBe(200);
    expect(writes()).toEqual([]);
    const ok = await confirm({ token });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ status: 'cancelled', accessUntil: at(30).toISOString(), alternative: null });
  });

  it('answers 410 for an unknown, a used, an expired and an other-brand link, as confirm does', async () => {
    await seedBuyer();
    const unknown = await preview('x'.repeat(40));
    expect(unknown.status).toBe(410);
    expect(unknown.body).toMatchObject({ success: false, code: 'cancel_token_invalid' });

    const token = await requestLink();
    const otherBrand = await preview(token, GO);
    expect(otherBrand.status).toBe(410);
    expect(otherBrand.body.code).toBe('cancel_token_invalid');
    // A refused preview does not use the link up either.
    expect((await preview(token)).status).toBe(200);

    await db.rAAuthToken.updateMany({ where: {}, data: { expiresAt: new Date(clock.now.getTime() - 1) } });
    expect((await preview(token)).status).toBe(410);
    await db.rAAuthToken.updateMany({ where: {}, data: { expiresAt: new Date(clock.now.getTime() + 60_000) } });
    expect((await confirm({ token })).status).toBe(200);
    const used = await preview(token);
    expect(used.status).toBe(410);
    expect(used.body.code).toBe('cancel_token_invalid');
    // None of the refused previews asked Stripe anything.
    expect(stripe.invoices.list).toHaveBeenCalledTimes(1);
  });

  it('outside the withdrawal countries and after the 14 days the link offers the cancellation only', async () => {
    await seedBuyer({ billingCountry: 'US' });
    const token = await requestLink();
    expect((await preview(token)).body.data).toEqual({ planKey: 'pro_monthly', accessUntil: at(30).toISOString(), withdrawal: null });
    await seedBuyer({ billingCountry: 'DE' });
    expect((await preview(token)).body.data.withdrawal).toMatchObject({ rule: 'withdrawal_14d', refundMinor: 2499 });
    // The link lives 30 minutes: ask for one just before the deadline and look again just after it.
    clock.now = new Date(at(14).getTime() - 10 * 60_000);
    const late = await requestLink();
    expect((await preview(late)).body.data.withdrawal).not.toBeNull();
    clock.now = new Date(at(14).getTime() + 60_000);
    expect((await preview(late)).body.data).toEqual({ planKey: 'pro_monthly', accessUntil: at(30).toISOString(), withdrawal: null });
  });

  it('quotes the plan the link cancels, never a pack bought alongside', async () => {
    await seedBuyer();
    addInvoice(packInvoice(3));
    const token = await requestLink();
    expect((await preview(token)).body.data.withdrawal).toEqual({ refundMinor: 2499, currency: 'USD', rule: 'withdrawal_14d', deadline: at(14).toISOString() });
    // With the plan out of its 14 days only the pack is open: the link offers no withdrawal.
    clock.now = new Date(at(14).getTime() - 10 * 60_000);
    const late = await requestLink();
    clock.now = new Date(at(14).getTime() + 60_000);
    expect((await preview(late)).body.data.withdrawal).toBeNull();
  });

  it('when the purchase cannot be read from Stripe the withdrawal is left out, and the cancellation still works', async () => {
    await seedBuyer();
    const token = await requestLink();
    stripe.invoices.list.mockRejectedValueOnce(stripeError({ type: 'StripeConnectionError', message: 'socket hang up' }));
    const res = await preview(token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ planKey: 'pro_monthly', accessUntil: at(30).toISOString(), withdrawal: null });
    expect((await confirm({ token })).body.data.status).toBe('cancelled');
  });

  it('one link asks Stripe for its quote a bounded number of times; past that the preview still answers, with the cancellation only', async () => {
    await seedBuyer();
    const token = await requestLink();
    expect(PUBLIC_CANCEL_PREVIEW_LIMIT).toEqual([{ limit: 20, windowSec: 30 * 60 }]);
    for (let i = 0; i < 20; i++) expect((await preview(token)).body.data.withdrawal, `preview ${i + 1}`).not.toBeNull();
    expect(stripe.invoices.list).toHaveBeenCalledTimes(20);
    const over = await preview(token);
    expect(over.status).toBe(200);
    expect(over.body.data).toEqual({ planKey: 'pro_monthly', accessUntil: at(30).toISOString(), withdrawal: null });
    expect(stripe.invoices.list).toHaveBeenCalledTimes(20);
    // The link itself is untouched: it still withdraws.
    expect((await confirm({ token, withdraw: true })).body.data.withdrawal).toMatchObject({ status: 'withdrawn', refundMinor: 2499 });
  });

  it('takes the token and nothing else (422)', async () => {
    expect((await h.request<any>('POST', `${PUBLIC}/preview`, { ...RA, body: {} })).status).toBe(422);
    expect((await h.request<any>('POST', `${PUBLIC}/preview`, { ...RA, body: { token: 'x'.repeat(40), withdraw: true } })).status).toBe(422);
  });
});

describe('public cancel link: POST /confirm with withdraw', () => {
  it('withdraws: the subscription ends at once, the quoted amount is refunded, the withdrawal mail goes out, the link is spent', async () => {
    await seedBuyer({ waiver: true });
    const token = await requestLink();
    const res = await confirm({ token, withdraw: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'cancelled', accessUntil: null, alternative: null, withdrawal: { status: 'withdrawn', refundMinor: 2082, currency: 'USD' } });
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
    expect(cancelCall()[2]).toEqual({ idempotencyKey: 'withdraw:sub_1' });
    expect(refundCall()[0]).toMatchObject({ payment_intent: 'pi_in_1', amount: 2082, metadata: { actor: 'public_link', kind: 'withdrawal' } });
    // The withdrawal mail, and not the period-end cancellation with its own mail.
    expect(sendEmail.mock.calls.map((c) => c[0].template)).toEqual(['billing.withdrawal_confirmed']);
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({ to: 'u@example.test', brand: 'roboapply', params: { amountMinor: 2082, currency: 'USD' } });
    expect(cancel).not.toHaveBeenCalled();
    expect(invalidated).toEqual(['u_1']);
    expect((await tokenRow()).consumedAt).toEqual(clock.now);
    expect((await confirm({ token, withdraw: true })).status).toBe(410);
    expect((await preview(token)).status).toBe(410);
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
  });

  it('without withdraw, and with withdraw: false, it cancels at period end exactly as before', async () => {
    await seedBuyer({ waiver: true });
    for (const extra of [{}, { withdraw: false }]) {
      const token = await requestLink();
      const res = await confirm({ token, ...extra });
      expect(res.status).toBe(200);
      // The same three fields as before this route could withdraw: no `withdrawal` member.
      expect(res.body.data).toEqual({ status: 'cancelled', accessUntil: at(30).toISOString(), alternative: null });
      expect(cancel).toHaveBeenLastCalledWith('u_1', { source: 'public_link' });
    }
    expect(cancel).toHaveBeenCalledTimes(2);
    // Stripe was never asked for a quote, and nothing was cancelled or refunded there by this route.
    expect(account.calls).toEqual([]);
  });

  it('a withdrawal that is no longer available cancels at period end instead and says so', async () => {
    await seedBuyer();
    clock.now = new Date(at(14).getTime() - 10 * 60_000);
    const token = await requestLink();
    expect((await preview(token)).body.data.withdrawal).not.toBeNull();
    clock.now = new Date(at(14).getTime() + 60_000);
    const res = await confirm({ token, withdraw: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      status: 'cancelled',
      accessUntil: at(30).toISOString(),
      alternative: null,
      withdrawal: { status: 'not_available', refundMinor: null, currency: null },
    });
    expect(cancel).toHaveBeenCalledWith('u_1', { source: 'public_link' });
    expect(writes()).toEqual([]);
    expect((await confirm({ token })).status).toBe(410);
  });

  it('a US buyer who sends withdraw gets the ordinary cancellation and not_available', async () => {
    await seedBuyer({ billingCountry: 'US' });
    const token = await requestLink();
    const res = await confirm({ token, withdraw: true });
    expect(res.body.data).toMatchObject({ status: 'cancelled', accessUntil: at(30).toISOString(), withdrawal: { status: 'not_available', refundMinor: null, currency: null } });
    expect(writes()).toEqual([]);
  });

  // After a withdrawal the plan row still says "active" until customer.subscription.deleted is processed.
  // In that time an ordinary cancellation would ask Stripe to change a subscription that is gone there.
  describe('the plan was withdrawn elsewhere and its row does not say so yet', () => {
    /** What the real cancel path does then: Stripe refuses the update, the route would answer 502. */
    const stripeRefusesTheUpdate = () =>
      cancel.mockImplementation(async () => {
        throw Object.assign(new Error('The cancellation could not be sent to the payment provider. Try again.'), { code: 'payment_provider_error' });
      });
    const withdrawSignedIn = (purchaseId = 'in_1') => h.request<any>('POST', WITHDRAWAL, { ...RA, body: { purchaseId, confirm: true } });
    const planRow = async () => (await db.seekerSubscription.findUnique({ where: { id: 'row_1' } })) as Obj;

    it('the link asked to withdraw: nothing is refunded twice, Stripe is not asked to cancel, and the answer is "already cancelled"', async () => {
      await seedBuyer();
      const token = await requestLink();
      expect((await withdrawSignedIn()).status).toBe(200);
      expect(await planRow()).toMatchObject({ status: 'active', stripeSubscriptionId: 'sub_1' });
      stripeRefusesTheUpdate();
      const res = await confirm({ token, withdraw: true });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ status: 'already_cancelled', accessUntil: null, alternative: null, withdrawal: { status: 'not_available', refundMinor: null, currency: null } });
      expect(cancel).not.toHaveBeenCalled();
      expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
      // A final answer: the link is spent.
      expect(await linkUsed()).toBe(true);
    });

    it('the link asked for the ordinary cancellation: the same answer, with no withdrawal member', async () => {
      await seedBuyer();
      const token = await requestLink();
      expect((await withdrawSignedIn()).status).toBe(200);
      stripeRefusesTheUpdate();
      const res = await confirm({ token });
      expect(res.body.data).toEqual({ status: 'already_cancelled', accessUntil: null, alternative: null });
      expect(cancel).not.toHaveBeenCalled();
    });

    it('the signed-in cancel answers 409 no_subscription, as it does once the row has ended', async () => {
      await seedBuyer();
      expect((await withdrawSignedIn()).status).toBe(200);
      stripeRefusesTheUpdate();
      const res = await h.request<any>('POST', '/api/v1/roboapply/credits/cancel', { ...RA, body: {} });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('no_subscription');
      expect(cancel).not.toHaveBeenCalled();
    });

    it('a withdrawn pack is not the plan: the plan is still cancelled at period end', async () => {
      await seedBuyer();
      addInvoice(packInvoice(3));
      const token = await requestLink();
      expect((await withdrawSignedIn('in_pack')).status).toBe(200);
      const res = await confirm({ token });
      expect(res.body.data).toEqual({ status: 'cancelled', accessUntil: at(30).toISOString(), alternative: null });
      expect(cancel).toHaveBeenCalledWith('u_1', { source: 'public_link' });
    });

    it('a subscription bought after the withdrawal is a new plan: it is cancelled as usual', async () => {
      await seedBuyer();
      expect((await withdrawSignedIn()).status).toBe(200);
      await db.seekerSubscription.update({ where: { id: 'row_1' }, data: { stripeSubscriptionId: 'sub_2' } });
      const token = await requestLink();
      expect((await confirm({ token })).body.data.status).toBe('cancelled');
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('when that check cannot read Stripe, the cancellation is not held up by it', async () => {
      await seedBuyer();
      const token = await requestLink();
      expect((await withdrawSignedIn()).status).toBe(200);
      stripe.invoices.retrieve.mockRejectedValueOnce(stripeDown());
      expect((await confirm({ token })).body.data.status).toBe('cancelled');
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('an account that never withdrew is cancelled without any read at Stripe', async () => {
      await seedBuyer();
      const token = await requestLink();
      account.calls = [];
      expect((await confirm({ token })).body.data.status).toBe('cancelled');
      expect((await h.request<any>('POST', '/api/v1/roboapply/credits/cancel', { ...RA, body: {} })).status).toBe(200);
      expect(account.calls).toEqual([]);
    });
  });

  describe('a withdrawal through the link that failed at the payment provider', () => {
    it('ten minutes before the 14th day ends the refund fails; the same link, after it, still returns the quoted amount', async () => {
      await seedBuyer({ waiver: true });
      clock.now = BEFORE_DEADLINE;
      const token = await requestLink();
      stripe.refunds.create.mockRejectedValueOnce(stripeDown());
      const failed = await confirm({ token, withdraw: true });
      expect(failed.status).toBe(502);
      expect(await linkUsed()).toBe(false);
      expect(await claims()).toEqual([DECLARED]);
      account.subscriptions.set('sub_1', { ...account.subscriptions.get('sub_1'), status: 'canceled' });

      // The link lives 30 minutes; the purchase's 14th day ended in between.
      clock.now = new Date(at(14).getTime() + 5 * 60_000);
      const shown = (await preview(token)).body.data.withdrawal;
      expect(shown).toEqual({
        refundMinor: LAST_DAY_REFUND,
        currency: 'USD',
        rule: 'withdrawal_14d_prorata',
        deadline: new Date(BEFORE_DEADLINE.getTime() + WITHDRAWAL_DECLARATION_DAYS * DAY_S * 1000).toISOString(),
      });
      const retry = await confirm({ token, withdraw: true });
      expect(retry.status).toBe(200);
      expect(retry.body.data).toEqual({ status: 'cancelled', accessUntil: null, alternative: null, withdrawal: { status: 'withdrawn', refundMinor: LAST_DAY_REFUND, currency: 'USD' } });
      expect(refundCall(1)[1]).toEqual(refundCall(0)[1]);
      // The period-end cancellation never took the withdrawal's place.
      expect(cancel).not.toHaveBeenCalled();
      expect(sendEmail.mock.calls.map((c) => c[0].template)).toEqual(['billing.withdrawal_confirmed']);
      expect(await linkUsed()).toBe(true);
    });

    it('once the link has expired, the signed-in page lists the purchase and finishes it', async () => {
      await seedBuyer({ waiver: true });
      clock.now = BEFORE_DEADLINE;
      const token = await requestLink();
      stripe.refunds.create.mockRejectedValueOnce(stripeDown());
      expect((await confirm({ token, withdraw: true })).status).toBe(502);
      account.subscriptions.set('sub_1', { ...account.subscriptions.get('sub_1'), status: 'canceled' });

      clock.now = new Date(BEFORE_DEADLINE.getTime() + 2 * DAY_S * 1000);
      expect((await confirm({ token, withdraw: true })).status).toBe(410);
      const listed = (await h.request<any>('GET', WITHDRAWAL, RA)).body.data;
      expect(listed.purchase).toMatchObject({ id: 'in_1' });
      expect(listed.quote).toMatchObject({ refundMinor: LAST_DAY_REFUND });
      const done = await h.request<any>('POST', WITHDRAWAL, { ...RA, body: { purchaseId: 'in_1', confirm: true } });
      expect(done.body.data).toEqual({ status: 'withdrawn', refundMinor: LAST_DAY_REFUND, currency: 'USD', accessEnded: true });
      // The same refund as the link asked for: the same amount under the same key.
      expect(refundCall(1)[0]).toMatchObject({ payment_intent: 'pi_in_1', amount: LAST_DAY_REFUND });
      expect(refundCall(1)[1]).toEqual(refundCall(0)[1]);
    });
  });

  it('a Stripe failure leaves the link usable: the same link finishes the withdrawal with the same keys, then is spent', async () => {
    await seedBuyer({ waiver: true });
    const token = await requestLink();
    stripe.refunds.create.mockRejectedValueOnce(stripeError({ type: 'StripeConnectionError', message: 'socket hang up' }));
    const failed = await confirm({ token, withdraw: true });
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe('payment_provider_error');
    // A public route: the answer never carries the failure's own text.
    expect(failed.body.details).toEqual({ provider: 'stripe' });
    expect(await linkUsed()).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();

    account.subscriptions.set('sub_1', { ...account.subscriptions.get('sub_1'), status: 'canceled' });
    const retry = await confirm({ token, withdraw: true });
    expect(retry.status).toBe(200);
    expect(retry.body.data.withdrawal).toEqual({ status: 'withdrawn', refundMinor: 2082, currency: 'USD' });
    expect(refundCall(1)[1]).toEqual(refundCall(0)[1]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((await confirm({ token, withdraw: true })).status).toBe(410);
  });

  it('when the purchase cannot be read the link is not used up and nothing is cancelled in its place', async () => {
    await seedBuyer({ waiver: true });
    const token = await requestLink();
    stripe.invoices.list.mockRejectedValueOnce(stripeError({ type: 'StripeConnectionError', message: 'socket hang up' }));
    const failed = await confirm({ token, withdraw: true });
    expect(failed.status).toBe(502);
    expect(await linkUsed()).toBe(false);
    // A buyer who asked to withdraw is not given a period-end cancellation because Stripe was slow.
    expect(cancel).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('a refund the provider itself refuses after the cancel is answered as that 409, and the period-end cancel is not run on top', async () => {
    await seedBuyer({ waiver: true });
    const token = await requestLink();
    stripe.refunds.create.mockRejectedValueOnce(stripeError({ type: 'StripeInvalidRequestError', code: 'charge_already_refunded', message: 'Charge has already been refunded.' }));
    const res = await confirm({ token, withdraw: true });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'withdrawal_not_available', details: { reason: 'refund_refused' } });
    // The subscription was ended by the withdrawal's first step: there is nothing left to cancel at period end.
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
    expect(cancel).not.toHaveBeenCalled();
    expect(invalidated).toEqual(['u_1']);
  });

  it('a refund Stripe refuses for another reason after the cancel: 502, the link stays usable, the instant is kept, and no period-end cancel is run on top', async () => {
    await seedBuyer({ waiver: true });
    const token = await requestLink();
    stripe.refunds.create.mockRejectedValueOnce(stripeError({ type: 'StripeInvalidRequestError', code: 'parameter_unknown', message: 'Received unknown parameter: foo' }));
    const failed = await confirm({ token, withdraw: true });
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ code: 'payment_provider_error', details: { provider: 'stripe' } });
    expect(failed.body.details.message).toBeUndefined();
    expect(await linkUsed()).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(await claims()).toContain(DECLARED);
    // The same link finishes it.
    account.subscriptions.set('sub_1', { ...account.subscriptions.get('sub_1'), status: 'canceled' });
    const retry = await confirm({ token, withdraw: true });
    expect(retry.body.data.withdrawal).toEqual({ status: 'withdrawn', refundMinor: 2082, currency: 'USD' });
  });

  it('a plan whose payment cannot be resolved is not withdrawn and not ended: the link cancels at the end of the paid period instead, and says so', async () => {
    await seedBuyer({ waiver: true });
    const token = await requestLink();
    account.payments.set('in_1', []);
    const res = await confirm({ token, withdraw: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'cancelled', withdrawal: { status: 'not_available', refundMinor: null, currency: null } });
    // Nothing was ended at once and nothing was refunded.
    expect(writes()).toEqual([]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('withdraws from the plan, never from a pack bought alongside', async () => {
    await seedBuyer();
    addInvoice(packInvoice(3));
    const token = await requestLink();
    const res = await confirm({ token, withdraw: true });
    expect(res.body.data.withdrawal).toEqual({ status: 'withdrawn', refundMinor: 2499, currency: 'USD' });
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(refundCall()[0].payment_intent).toBe('pi_in_1');
    // The pack is still the buyer's to keep or to withdraw from, signed in.
    expect((await h.request<any>('GET', WITHDRAWAL, RA)).body.data.purchases.map((p: Obj) => p.purchase.id)).toEqual(['in_pack']);
  });

  it('as built, pending the owner (decision 21): after a plan switch the link withdraws from the switch, refunds its amount only and ends the whole subscription', async () => {
    await seedBuyer();
    const switchedS = T0_S + 20 * DAY_S;
    addInvoice(
      subscriptionInvoice({
        id: 'in_switch',
        amount_paid: 3000,
        created: switchedS,
        status_transitions: { paid_at: switchedS },
        billing_reason: 'subscription_update',
        parent: { subscription_details: { subscription: 'sub_1', metadata: { planKey: 'pro_quarterly' } } },
        lines: { data: [subscriptionLine(90, switchedS)] },
      }),
    );
    clock.now = at(22);
    const token = await requestLink();
    expect((await preview(token)).body.data.withdrawal).toEqual({ refundMinor: 3000, currency: 'USD', rule: 'withdrawal_14d', deadline: at(34).toISOString() });
    const res = await confirm({ token, withdraw: true });
    expect(res.body.data.withdrawal).toEqual({ status: 'withdrawn', refundMinor: 3000, currency: 'USD' });
    // The subscription is ended; the first month, bought 22 days ago, is not refunded.
    expect(cancelCall()[0]).toBe('sub_1');
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(refundCall()[0].payment_intent).toBe('pi_in_switch');
  });

  it('withdraw must be a boolean, and unknown fields are refused (422) without touching the link', async () => {
    await seedBuyer();
    const token = await requestLink();
    expect((await confirm({ token, withdraw: 'yes' })).status).toBe(422);
    expect((await confirm({ token, purchaseId: 'in_1' })).status).toBe(422);
    expect(await linkUsed()).toBe(false);
  });
});
