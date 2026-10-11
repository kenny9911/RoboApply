// @vitest-environment node
//
// The refund engine without the webhook (ST-4 part 1, ST-9 engine;
// MARKET_STRATEGY §4.4 "How a refund is executed", §5.1 "Refunds and
// disputes"): `issueRefund` (ownership, payment intent lookup, the Stripe
// idempotency key, no database write), and `withdrawalQuote` /
// `withdrawPurchase` (cancel first, then refund, one confirmation mail).
// In-memory Prisma and a fake Stripe client installed with
// `setStripeClientForTests`: nothing here reaches Stripe.
// The webhook half is integration/stripeRefunds.webhook.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../test/fakePrisma.js');
  fake.db = createFakePrisma({ uniqueFields: { rACreditLedger: ['idempotencyKey'], rABillingRefund: ['externalRef'] } });
  return { default: fake.db };
});
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

// Builds the fake before the first test (the engine itself imports the Prisma client only on first use).
import '../../lib/prisma.js';
import { BillingError } from './errors.js';
import { setStripeClientForTests } from './stripeClient.js';
import { billingEventClaimKey } from './stripeEvents.js';
import { issueRefund, setStripeRefundDepsForTests, withdrawPurchase, withdrawalQuote } from './stripeRefunds.js';

const DAY_S = 86_400;
/** The purchase instant. */
const T0 = new Date('2026-10-05T08:00:00.000Z');
const T0_S = Math.floor(T0.getTime() / 1000);
const at = (days: number) => new Date(T0.getTime() + days * DAY_S * 1000);

const clock = { now: at(5) };

// ── The fake Stripe account ───────────────────────────────────────────────

type Obj = Record<string, any>;
const account = {
  invoices: new Map<string, Obj>(),
  sessions: new Map<string, Obj>(),
  /** invoice id → its payments. */
  payments: new Map<string, Obj[]>(),
  subscriptions: new Map<string, Obj>(),
  refunds: [] as Obj[],
  /** Every call that reaches the fake, in order: 'resource.method'. */
  calls: [] as string[],
  seq: 0,
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
    list: vi.fn(async (params: { customer: string; status?: string; limit?: number }) => {
      account.calls.push('invoices.list');
      const data = [...account.invoices.values()]
        .filter((i) => i.customer === params.customer && (!params.status || i.status === params.status))
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
  checkout: {
    sessions: {
      retrieve: vi.fn(async (id: string) => {
        account.calls.push('checkout.sessions.retrieve');
        const s = account.sessions.get(id);
        if (!s) throw stripeError({ code: 'resource_missing', statusCode: 404, type: 'StripeInvalidRequestError', message: `No such session: '${id}'` });
        return s;
      }),
    },
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
      const refund = {
        id: `re_${++account.seq}`,
        amount: params.amount ?? 2499,
        currency: 'usd',
        charge: 'ch_1',
        payment_intent: params.payment_intent,
        metadata: params.metadata,
        reason: params.reason,
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

/** The calls that change something at Stripe, in the order they were made (counted on the mocks, so a call that was made to fail counts too). */
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

/** The first invoice of a subscription, as `invoices.list` returns it: with its lines (the paid period is the 30 days from T0). */
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

/** The first invoice of a weekly plan (9.99 for the 7 days from T0). */
function weeklyInvoice(over: Obj = {}): Obj {
  return subscriptionInvoice({
    amount_paid: 999,
    parent: { subscription_details: { subscription: 'sub_1', metadata: { planKey: 'pro_weekly' } } },
    lines: { data: [subscriptionLine(7)] },
    ...over,
  });
}

/** A one-time payment (7-day pass or pack): Checkout creates an invoice for it too, with the checkout metadata. */
function oneTimeInvoice(planKey: string, amount: number, over: Obj = {}): Obj {
  return {
    id: 'in_once',
    customer: 'cus_1',
    status: 'paid',
    amount_paid: amount,
    currency: 'usd',
    created: T0_S,
    status_transitions: { paid_at: T0_S },
    billing_reason: 'manual',
    metadata: { product: 'roboapply', brand: 'roboapply', planKey, userId: 'u_1' },
    parent: null,
    ...over,
  };
}

function stripeSubscription(over: Obj = {}): Obj {
  return {
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    items: { data: [{ id: 'si_1', current_period_start: T0_S, current_period_end: T0_S + 30 * DAY_S }] },
    ...over,
  };
}

function paid(paymentIntent: string): Obj[] {
  return [
    { id: 'inpay_open', status: 'open', payment: { type: 'payment_intent', payment_intent: 'pi_abandoned' } },
    { id: 'inpay_1', status: 'paid', payment: { type: 'payment_intent', payment_intent: paymentIntent } },
  ];
}

const sendEmail = vi.fn(async (_input: Obj) => ({ status: 'sent' as const }));
const invalidate = vi.fn();
const getStripeSpy = vi.fn(() => stripe as never);

/** The engine's test dependencies: the fake database, the fixed clock, recorded mail and invalidation. Stripe comes from setStripeClientForTests. */
const deps = () => ({ db: () => fake.db as never, now: () => clock.now, sendEmail: sendEmail as never, invalidate });

const TABLES = ['user', 'seekerProfile', 'seekerSubscription', 'seekerConsentRecord', 'rACreditLedger', 'rACreditGrant', 'rABillingRefund'];

async function seedUser(over: { brand?: string; rowBrand?: string | null; billingCountry?: string | null; waiver?: boolean; planKey?: string; subId?: string | null } = {}) {
  await fake.db.user.create({ data: { id: 'u_1', email: 'u_1@example.test', name: 'U', brand: over.brand ?? 'roboapply' } });
  await fake.db.seekerProfile.create({ data: { id: 'sp_1', userId: 'u_1', locale: 'de', market: 'other' } });
  await fake.db.seekerSubscription.create({
    data: {
      id: 'row_1',
      seekerProfileId: 'sp_1',
      tier: 'pro',
      status: 'active',
      brand: over.rowBrand === undefined ? 'roboapply' : over.rowBrand,
      rail: 'stripe',
      planKey: over.planKey ?? 'pro_monthly',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: over.subId === undefined ? 'sub_1' : over.subId,
      billingCountry: over.billingCountry === undefined ? 'DE' : over.billingCountry,
      currentPeriodEnd: at(30),
      cancelAtPeriodEnd: false,
      mockCredits: 3,
    },
  });
  if (over.waiver) {
    await fake.db.seekerConsentRecord.create({ data: { seekerProfileId: 'sp_1', consentType: 'withdrawal_waiver', granted: true, createdAt: new Date(T0.getTime() - 60_000) } });
  }
}

async function snapshot(): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const t of TABLES) out[t] = await fake.db[t].findMany({});
  return JSON.stringify(out);
}

async function refused(run: Promise<unknown>, code: string, reason?: string): Promise<BillingError> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BillingError);
  expect((err as BillingError).code).toBe(code);
  if (reason) expect((err as BillingError).details).toMatchObject({ reason });
  return err as BillingError;
}

beforeEach(async () => {
  vi.clearAllMocks();
  account.invoices.clear();
  account.sessions.clear();
  account.payments.clear();
  account.subscriptions.clear();
  account.refunds = [];
  account.calls = [];
  account.seq = 0;
  clock.now = at(5);
  for (const t of TABLES) await fake.db[t].deleteMany({});
  account.invoices.set('in_1', subscriptionInvoice());
  account.payments.set('in_1', paid('pi_inv'));
  account.subscriptions.set('sub_1', stripeSubscription());
  account.sessions.set('cs_pack', {
    id: 'cs_pack',
    customer: 'cus_1',
    mode: 'payment',
    payment_status: 'paid',
    payment_intent: 'pi_cs',
    invoice: 'in_pack',
    amount_total: 999,
    currency: 'usd',
    metadata: { product: 'roboapply', brand: 'roboapply', planKey: 'practice_pack_5', userId: 'u_1' },
  });
  setStripeClientForTests(stripe as never);
  setStripeRefundDepsForTests(deps());
});

afterEach(() => {
  setStripeClientForTests(undefined);
  setStripeRefundDepsForTests();
});

const ADMIN = { userId: 'u_1', reason: 'Charged twice', actor: 'admin_7' } as const;

describe('issueRefund', () => {
  beforeEach(async () => {
    await seedUser();
  });

  it('a full refund of an invoice calls refunds.create once, with the payment intent that paid it and the idempotency key', async () => {
    const res = await issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' } });
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    const [params, opts] = refundCall();
    // The paid InvoicePayment, never the abandoned attempt listed before it.
    expect(params).toEqual({
      payment_intent: 'pi_inv',
      reason: 'requested_by_customer',
      metadata: { product: 'roboapply', userId: 'u_1', actor: 'admin_7', kind: 'refund', planKey: 'pro_monthly', reason: 'Charged twice' },
    });
    expect(params).not.toHaveProperty('amount');
    expect(opts).toEqual({ idempotencyKey: 'refund:pi_inv:full' });
    expect(res).toEqual({ refundId: 're_1', paymentIntentId: 'pi_inv', chargeId: 'ch_1', amountMinor: 2499, currency: 'USD', full: true });
  });

  it('a full refund of a one-time session uses the session\'s payment intent', async () => {
    stripe.refunds.create.mockImplementationOnce(async (params: Obj) => ({ id: 're_pack', amount: 999, currency: 'usd', charge: 'ch_pack', payment_intent: params.payment_intent, metadata: params.metadata }));
    const res = await issueRefund({ ...ADMIN, target: { checkoutSessionId: 'cs_pack' } });
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    const [params, opts] = refundCall();
    expect(params.payment_intent).toBe('pi_cs');
    expect(params.metadata).toMatchObject({ product: 'roboapply', userId: 'u_1', kind: 'refund', planKey: 'practice_pack_5' });
    expect(opts).toEqual({ idempotencyKey: 'refund:pi_cs:full' });
    expect(res).toEqual({ refundId: 're_pack', paymentIntentId: 'pi_cs', chargeId: 'ch_pack', amountMinor: 999, currency: 'USD', full: true });
    // The session answers by itself: no invoice is read for a one-time payment.
    expect(stripe.invoices.retrieve).not.toHaveBeenCalled();
  });

  it('a second identical call sends the same key, so Stripe refunds once', async () => {
    await issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' } });
    await issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' } });
    expect(stripe.refunds.create).toHaveBeenCalledTimes(2);
    expect(refundCall(0)[1]).toEqual(refundCall(1)[1]);
    expect(refundCall(0)[0]).toEqual(refundCall(1)[0]);
  });

  it('an invoice of another customer is refused with refund_not_available and no Stripe write', async () => {
    account.invoices.set('in_other', subscriptionInvoice({ id: 'in_other', customer: 'cus_someone_else' }));
    account.payments.set('in_other', paid('pi_other'));
    await refused(issueRefund({ ...ADMIN, target: { invoiceId: 'in_other' } }), 'refund_not_available', 'not_yours');
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    // Refused on ownership before the payment is even looked up.
    expect(stripe.invoicePayments.list).not.toHaveBeenCalled();
    // The same for a session of another customer, and for an id Stripe does not know.
    account.sessions.set('cs_other', { ...account.sessions.get('cs_pack'), id: 'cs_other', customer: { id: 'cus_someone_else' } });
    await refused(issueRefund({ ...ADMIN, target: { checkoutSessionId: 'cs_other' } }), 'refund_not_available', 'not_yours');
    await refused(issueRefund({ ...ADMIN, target: { invoiceId: 'in_missing' } }), 'refund_not_available', 'not_found');
    await refused(issueRefund({ ...ADMIN, target: { checkoutSessionId: 'cs_missing' } }), 'refund_not_available', 'not_found');
    expect(writes()).toEqual([]);
  });

  it('a partial amount is passed through, with the amount in the key', async () => {
    const res = await issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' }, amountMinor: 1000 });
    const [params, opts] = refundCall();
    expect(params).toMatchObject({ payment_intent: 'pi_inv', amount: 1000 });
    expect(opts).toEqual({ idempotencyKey: 'refund:pi_inv:1000' });
    expect(res).toMatchObject({ amountMinor: 1000, full: false });
  });

  it('the whole amount given as a number is the same request as "everything"', async () => {
    const res = await issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' }, amountMinor: 2499 });
    expect(refundCall()[0]).not.toHaveProperty('amount');
    expect(refundCall()[1]).toEqual({ idempotencyKey: 'refund:pi_inv:full' });
    expect(res.full).toBe(true);
  });

  it('an amount that is not a positive whole number, or above what was paid, is refused without a Stripe call', async () => {
    for (const amountMinor of [0, -5, 10.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await refused(issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' }, amountMinor }), 'refund_not_available', 'invalid_amount');
    }
    expect(account.calls).toEqual([]);
    const err = await refused(issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' }, amountMinor: 2500 }), 'refund_not_available', 'amount_above_refundable');
    expect(err.details).toMatchObject({ refundableMinor: 2499 });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it('what our refund rows already account for is no longer refundable', async () => {
    await fake.db.rABillingRefund.create({
      data: { userId: 'u_1', brand: 'roboapply', rail: 'stripe', kind: 'refund', externalRef: 'ch_1:1000', chargeId: 'ch_1', paymentIntentId: 'pi_inv', invoiceId: 'in_1', amountMinor: 1000, currency: 'USD', full: false },
    });
    await refused(issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' }, amountMinor: 1500 }), 'refund_not_available', 'amount_above_refundable');
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    // The rest, as a number: a partial refund of the charge that completes it.
    stripe.refunds.create.mockImplementationOnce(async (params: Obj) => ({ id: 're_rest', amount: params.amount, currency: 'usd', charge: 'ch_1' }));
    const rest = await issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' }, amountMinor: 1499 });
    expect(refundCall()[0]).toMatchObject({ amount: 1499 });
    expect(refundCall()[1]).toEqual({ idempotencyKey: 'refund:pi_inv:1499' });
    expect(rest).toMatchObject({ amountMinor: 1499, full: true });
    // A dispute row is not a refund: it does not lower what can be refunded.
    await fake.db.rABillingRefund.deleteMany({});
    await fake.db.rABillingRefund.create({
      data: { userId: 'u_1', brand: 'roboapply', rail: 'stripe', kind: 'dispute', externalRef: 'dispute:dp_1', paymentIntentId: 'pi_inv', amountMinor: 2499, currency: 'USD', full: true },
    });
    await expect(issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' }, amountMinor: 2000 })).resolves.toMatchObject({ amountMinor: 2000 });
  });

  it('a payment our rows show as refunded in full is refused before Stripe is asked to refund', async () => {
    await fake.db.rABillingRefund.create({
      data: { userId: 'u_1', brand: 'roboapply', rail: 'stripe', kind: 'refund', externalRef: 'ch_1:2499', paymentIntentId: 'pi_inv', invoiceId: 'in_1', amountMinor: 2499, currency: 'USD', full: true },
    });
    await refused(issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' } }), 'refund_not_available', 'already_refunded');
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it('nothing in the database changes: entitlements move only in the charge.refunded webhook', async () => {
    await fake.db.rACreditGrant.create({ data: { id: 'pack_x', userId: 'u_1', bucket: 'practice', amount: 5, remaining: 5, reason: 'pack', expiresAt: at(365) } });
    const before = await snapshot();
    await issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' } });
    await issueRefund({ ...ADMIN, target: { checkoutSessionId: 'cs_pack' }, amountMinor: 500 });
    expect(await snapshot()).toBe(before);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    // And no Stripe write besides the two refunds (the subscription is not cancelled here).
    expect(writes()).toEqual(['refunds.create', 'refunds.create']);
  });

  it('reads the payment intent from the invoice itself on an old API version, and refuses an invoice nothing was paid on', async () => {
    account.invoices.set('in_old', subscriptionInvoice({ id: 'in_old', payment_intent: { id: 'pi_legacy' }, parent: null, subscription: 'sub_1' }));
    await issueRefund({ ...ADMIN, target: { invoiceId: 'in_old' } });
    expect(refundCall()[0].payment_intent).toBe('pi_legacy');
    expect(refundCall()[1]).toEqual({ idempotencyKey: 'refund:pi_legacy:full' });
    // The plan comes from the account's row when the invoice's subscription is the one it is on.
    expect(refundCall()[0].metadata.planKey).toBe('pro_monthly');

    account.invoices.set('in_unpaid', subscriptionInvoice({ id: 'in_unpaid', amount_paid: 0 }));
    account.payments.set('in_unpaid', [{ id: 'inpay_x', status: 'open', payment: { type: 'payment_intent', payment_intent: 'pi_open' } }]);
    await refused(issueRefund({ ...ADMIN, target: { invoiceId: 'in_unpaid' } }), 'refund_not_available', 'nothing_paid');
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it('a subscription Checkout Session is refunded through its first invoice; an unpaid session is refused', async () => {
    account.sessions.set('cs_sub', { id: 'cs_sub', customer: 'cus_1', mode: 'subscription', payment_status: 'paid', payment_intent: null, invoice: 'in_1', amount_total: 2499, currency: 'usd', metadata: { planKey: 'pro_monthly' } });
    const res = await issueRefund({ ...ADMIN, target: { checkoutSessionId: 'cs_sub' } });
    expect(refundCall()[0].payment_intent).toBe('pi_inv');
    expect(res).toMatchObject({ paymentIntentId: 'pi_inv', full: true });
    account.sessions.set('cs_unpaid', { ...account.sessions.get('cs_pack'), id: 'cs_unpaid', payment_status: 'unpaid' });
    await refused(issueRefund({ ...ADMIN, target: { checkoutSessionId: 'cs_unpaid' } }), 'refund_not_available', 'nothing_paid');
    account.sessions.set('cs_empty', { id: 'cs_empty', customer: 'cus_1', mode: 'subscription', payment_intent: null, invoice: null });
    await refused(issueRefund({ ...ADMIN, target: { checkoutSessionId: 'cs_empty' } }), 'refund_not_available', 'nothing_paid');
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it('no Stripe client: rail_not_configured; no customer on the account: refund_not_available', async () => {
    setStripeClientForTests(null);
    await refused(issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' } }), 'rail_not_configured');
    setStripeClientForTests(stripe as never);
    await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { stripeCustomerId: null } });
    await refused(issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' } }), 'refund_not_available', 'no_customer');
    await refused(issueRefund({ ...ADMIN, userId: 'u_nobody', target: { invoiceId: 'in_1' } }), 'refund_not_available', 'no_account');
    expect(account.calls).toEqual([]);
  });

  it('Stripe refusing the refund is refund_not_available; Stripe failing is payment_provider_error', async () => {
    stripe.refunds.create.mockRejectedValueOnce(stripeError({ type: 'StripeInvalidRequestError', code: 'charge_already_refunded', message: 'Charge ch_1 has already been refunded.' }));
    await refused(issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' } }), 'refund_not_available', 'refused_by_provider');
    stripe.refunds.create.mockRejectedValueOnce(stripeError({ type: 'StripeConnectionError', message: 'socket hang up' }));
    const err = await refused(issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' } }), 'payment_provider_error');
    expect(err.status).toBe(502);
  });

  it('a key Stripe refuses because another actor sent it a moment ago answers with the refund that was made', async () => {
    account.refunds.push({ id: 're_first', amount: 2499, currency: 'usd', charge: 'ch_1', payment_intent: 'pi_inv', metadata: { kind: 'refund', actor: 'admin_1' }, status: 'succeeded' });
    stripe.refunds.create.mockRejectedValueOnce(stripeError({ type: 'StripeIdempotencyError', message: 'Keys for idempotent requests can only be used with the same parameters.' }));
    const res = await issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' } });
    expect(res).toMatchObject({ refundId: 're_first', amountMinor: 2499, full: true });
    // No refund of that kind to be found: the conflict is reported, never a second key tried.
    account.refunds = [];
    stripe.refunds.create.mockRejectedValueOnce(stripeError({ type: 'StripeIdempotencyError', message: 'conflict' }));
    const err = await refused(issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' } }), 'payment_provider_error', 'idempotency_conflict');
    expect(err.status).toBe(502);
    expect(stripe.refunds.create).toHaveBeenCalledTimes(2);
  });
});

describe('issueRefund never serves GoApply (rule A11)', () => {
  it.each([
    ['a GoApply user', { brand: 'goapply', rowBrand: 'goapply' }],
    ['a row branded goapply under a RoboApply user', { brand: 'roboapply', rowBrand: 'goapply' }],
  ])('%s is refused before a Stripe client is asked for', async (_name, seed) => {
    await seedUser(seed);
    setStripeRefundDepsForTests({ ...deps(), getStripe: getStripeSpy });
    await refused(issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' } }), 'refund_not_available', 'rail_not_allowed');
    expect(await withdrawalQuote('u_1')).toBeNull();
    await refused(withdrawPurchase({ userId: 'u_1', purchaseId: 'in_1', actor: 'self' }), 'withdrawal_not_available');
    expect(getStripeSpy).not.toHaveBeenCalled();
    expect(account.calls).toEqual([]);
  });

  it('a legacy row without a brand is RoboApply\'s', async () => {
    await seedUser({ rowBrand: null });
    await expect(issueRefund({ ...ADMIN, target: { invoiceId: 'in_1' } })).resolves.toMatchObject({ refundId: 're_1' });
  });
});

describe('withdrawalQuote', () => {
  it('a German subscriber who ticked the waiver, on day 5 of 30: 25/30 of the price', async () => {
    await seedUser({ waiver: true });
    const quote = await withdrawalQuote('u_1');
    expect(quote).not.toBeNull();
    expect(quote!.purchase).toEqual({ source: 'stripe', id: 'in_1', planKey: 'pro_monthly', chargedAt: T0.toISOString(), amountMinor: 2499, currency: 'USD' });
    expect(quote!.decision).toMatchObject({
      eligible: true,
      rule: 'withdrawal_14d_prorata',
      amountMinor: 2082,
      currency: 'USD',
      prorata: { usedDays: 5, periodDays: 30 },
      endsAccess: true,
      withdrawalRegion: 'eu',
      deadline: at(14).toISOString(),
    });
    // The quote reads; it changes nothing at Stripe or in the database.
    expect(writes()).toEqual([]);
    expect(await fake.db.rACreditLedger.findMany({})).toEqual([]);
  });

  it('without the waiver the whole price; in Norway, the UK and Taiwan the same rules', async () => {
    await seedUser({});
    expect((await withdrawalQuote('u_1'))!.decision).toMatchObject({ rule: 'withdrawal_14d', amountMinor: 2499, prorata: null, endsAccess: true });
    for (const country of ['NO', 'GB', 'TW']) {
      await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { billingCountry: country } });
      expect((await withdrawalQuote('u_1'))!.decision.rule, country).toBe('withdrawal_14d');
    }
    await fake.db.seekerConsentRecord.create({ data: { seekerProfileId: 'sp_1', consentType: 'withdrawal_waiver', granted: true, createdAt: T0 } });
    expect((await withdrawalQuote('u_1'))!.decision).toMatchObject({ rule: 'withdrawal_14d_prorata', amountMinor: 2082, withdrawalRegion: 'tw' });
  });

  it('the period is the one the invoice paid for, not the subscription\'s current one', async () => {
    await seedUser({ waiver: true });
    // The subscription object says something else (Stripe moves it on before it collects a renewal): it is not even read.
    account.subscriptions.set('sub_1', stripeSubscription({ items: { data: [{ id: 'si_1', current_period_start: T0_S + 30 * DAY_S, current_period_end: T0_S + 60 * DAY_S }] } }));
    const quote = await withdrawalQuote('u_1');
    expect(quote!.decision).toMatchObject({ rule: 'withdrawal_14d_prorata', amountMinor: 2082, prorata: { usedDays: 5, periodDays: 30 } });
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();

    // A proration line and a one-off item are not the paid period: the subscription line is.
    account.invoices.set(
      'in_1',
      subscriptionInvoice({
        lines: {
          data: [
            subscriptionLine(3, T0_S - 3 * DAY_S, { id: 'il_credit', parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_1', proration: true } } }),
            { id: 'il_item', period: { start: T0_S, end: T0_S }, parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: 'ii_1', proration: false }, subscription_item_details: null } },
            subscriptionLine(30),
          ],
        },
      }),
    );
    expect((await withdrawalQuote('u_1'))!.decision.prorata).toEqual({ usedDays: 5, periodDays: 30 });
    // An old API version marks the line with `type: 'subscription'`.
    account.invoices.set('in_1', subscriptionInvoice({ lines: { data: [{ id: 'il_old', type: 'subscription', proration: false, period: { start: T0_S, end: T0_S + 30 * DAY_S } }] } }));
    expect((await withdrawalQuote('u_1'))!.decision.prorata).toEqual({ usedDays: 5, periodDays: 30 });
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('a weekly plan at day 7 plus two hours, the subscription on period two and the renewal unpaid: no quote (the paid week is used up)', async () => {
    await seedUser({ waiver: true, planKey: 'pro_weekly' });
    account.invoices.set('in_1', weeklyInvoice());
    // Stripe drafted the renewal and moved the subscription on; the first invoice is still the latest PAID one.
    account.subscriptions.set('sub_1', stripeSubscription({ items: { data: [{ id: 'si_1', current_period_start: T0_S + 7 * DAY_S, current_period_end: T0_S + 14 * DAY_S }] } }));
    account.invoices.set('in_renewal', weeklyInvoice({ id: 'in_renewal', status: 'open', amount_paid: 0, created: T0_S + 7 * DAY_S, billing_reason: 'subscription_cycle', lines: { data: [subscriptionLine(7, T0_S + 7 * DAY_S)] } }));
    clock.now = new Date(at(7).getTime() + 2 * 3_600_000);
    expect(await withdrawalQuote('u_1')).toBeNull();
    // Just before the week ended there still was one (nothing left to refund on the last started day).
    clock.now = new Date(at(7).getTime() - 1);
    expect((await withdrawalQuote('u_1'))!.decision).toMatchObject({ rule: 'withdrawal_14d_prorata', amountMinor: 0, prorata: { usedDays: 7, periodDays: 7 } });

    // An invoice that carries no line falls back to the subscription's period, and a rolled one is refused there too.
    account.invoices.set('in_1', weeklyInvoice({ lines: undefined }));
    clock.now = new Date(at(7).getTime() + 2 * 3_600_000);
    expect(await withdrawalQuote('u_1')).toBeNull();
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
    // The fallback still serves a first period that has not rolled.
    account.subscriptions.set('sub_1', stripeSubscription({ items: { data: [{ id: 'si_1', current_period_start: T0_S, current_period_end: T0_S + 7 * DAY_S }] } }));
    clock.now = at(3);
    expect((await withdrawalQuote('u_1'))!.decision).toMatchObject({ rule: 'withdrawal_14d_prorata', amountMinor: Math.floor((999 * 4) / 7), prorata: { usedDays: 3, periodDays: 7 } });
  });

  it('a waiver ticked at another checkout does not count for this purchase', async () => {
    await seedUser({});
    await fake.db.seekerConsentRecord.create({ data: { seekerProfileId: 'sp_1', consentType: 'withdrawal_waiver', granted: true, createdAt: new Date(T0.getTime() - 3 * DAY_S * 1000) } });
    await fake.db.seekerConsentRecord.create({ data: { seekerProfileId: 'sp_1', consentType: 'auto_renew_ack', granted: true, createdAt: T0 } });
    expect((await withdrawalQuote('u_1'))!.decision.rule).toBe('withdrawal_14d');
  });

  it('null for a US buyer, an unknown country, day 15, a renewal, and an account without card payments', async () => {
    await seedUser({ billingCountry: 'US', waiver: true });
    expect(await withdrawalQuote('u_1')).toBeNull();
    await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { billingCountry: null } });
    expect(await withdrawalQuote('u_1')).toBeNull();
    await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { billingCountry: 'DE' } });
    clock.now = new Date(at(14).getTime() + 1);
    expect(await withdrawalQuote('u_1')).toBeNull();
    clock.now = at(14);
    expect(await withdrawalQuote('u_1')).not.toBeNull();
    clock.now = at(2);
    account.invoices.set('in_1', subscriptionInvoice({ billing_reason: 'subscription_cycle' }));
    expect(await withdrawalQuote('u_1')).toBeNull();
    account.invoices.clear();
    expect(await withdrawalQuote('u_1')).toBeNull();
    expect(await withdrawalQuote('u_nobody')).toBeNull();
    setStripeClientForTests(null);
    expect(await withdrawalQuote('u_1')).toBeNull();
  });

  it('a pass with the waiver has no withdrawal quote (the 48-hour rule is not a withdrawal); without it, the full price', async () => {
    await seedUser({ waiver: true, planKey: 'pro_week_pass', subId: null });
    account.invoices.clear();
    account.invoices.set('in_once', oneTimeInvoice('pro_week_pass', 999));
    account.payments.set('in_once', paid('pi_pass'));
    clock.now = at(1);
    expect(await withdrawalQuote('u_1')).toBeNull();
    await fake.db.seekerConsentRecord.deleteMany({});
    const quote = await withdrawalQuote('u_1');
    expect(quote!.purchase).toMatchObject({ id: 'in_once', planKey: 'pro_week_pass', amountMinor: 999 });
    expect(quote!.decision).toMatchObject({ rule: 'withdrawal_14d', amountMinor: 999 });
    // No subscription behind a one-time payment: none is read.
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('a Stripe failure while reading is a payment_provider_error, not a quote', async () => {
    await seedUser({ waiver: true });
    stripe.invoices.list.mockRejectedValueOnce(stripeError({ type: 'StripeConnectionError', message: 'timeout' }));
    await refused(withdrawalQuote('u_1'), 'payment_provider_error');
  });
});

describe('withdrawPurchase', () => {
  const SELF = { userId: 'u_1', purchaseId: 'in_1', actor: 'self' } as const;

  it('with the waiver on day 5 of 30: the subscription is cancelled at once, 25/30 is refunded, one confirmation mail', async () => {
    await seedUser({ waiver: true });
    const res = await withdrawPurchase(SELF);
    expect(res).toEqual({ status: 'withdrawn', refundMinor: 2082, currency: 'USD', accessEnded: true, rule: 'withdrawal_14d_prorata' });
    // Cancel first, then refund: access ends whatever amount goes back.
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
    expect(cancelCall()).toEqual(['sub_1', {}, { idempotencyKey: 'withdraw:sub_1' }]);
    const [params, opts] = refundCall();
    expect(params).toEqual({
      payment_intent: 'pi_inv',
      amount: 2082,
      reason: 'requested_by_customer',
      metadata: { product: 'roboapply', userId: 'u_1', actor: 'self', kind: 'withdrawal', planKey: 'pro_monthly', reason: 'withdrawal' },
    });
    expect(opts).toEqual({ idempotencyKey: 'refund:pi_inv:2082' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith({
      template: 'billing.withdrawal_confirmed',
      to: 'u_1@example.test',
      userId: 'u_1',
      locale: 'de',
      brand: 'roboapply',
      params: { planKey: 'pro_monthly', amountMinor: 2082, currency: 'USD', withdrawnAt: at(5).toISOString() },
    });
    expect(invalidate).toHaveBeenCalledWith('u_1');
    // The engine writes its one claim and nothing else: the plan row ends when customer.subscription.deleted is processed.
    expect((await fake.db.rACreditLedger.findMany({})).map((r: Obj) => r.idempotencyKey)).toEqual([billingEventClaimKey('withdraw:in_1')]);
    expect(await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).toMatchObject({ tier: 'pro', status: 'active', stripeSubscriptionId: 'sub_1' });
    expect(await fake.db.rABillingRefund.findMany({})).toEqual([]);
  });

  it('without the waiver the refund is full and the subscription is cancelled', async () => {
    await seedUser({});
    const res = await withdrawPurchase(SELF);
    expect(res).toMatchObject({ refundMinor: 2499, rule: 'withdrawal_14d', accessEnded: true });
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
    expect(refundCall()[0]).not.toHaveProperty('amount');
    expect(refundCall()[0].metadata.kind).toBe('withdrawal');
    expect(refundCall()[1]).toEqual({ idempotencyKey: 'refund:pi_inv:full' });
    expect(sendEmail.mock.calls[0]![0].params).toMatchObject({ amountMinor: 2499 });
  });

  it('calling twice at the same moment sends the same two idempotency keys, so Stripe refunds once; one mail', async () => {
    await seedUser({ waiver: true });
    const [a, b] = await Promise.all([withdrawPurchase(SELF), withdrawPurchase(SELF)]);
    expect(a).toEqual(b);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(2);
    expect(cancelCall(0)[2]).toEqual({ idempotencyKey: 'withdraw:sub_1' });
    expect(cancelCall(1)[2]).toEqual({ idempotencyKey: 'withdraw:sub_1' });
    expect(stripe.refunds.create).toHaveBeenCalledTimes(2);
    expect(refundCall(0)).toEqual(refundCall(1));
    expect(refundCall(0)[1]).toEqual({ idempotencyKey: 'refund:pi_inv:2082' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a call that failed at the refund is finished by the next one with the same keys; after that the withdrawal is closed', async () => {
    await seedUser({ waiver: true });
    stripe.refunds.create.mockRejectedValueOnce(stripeError({ type: 'StripeConnectionError', message: 'socket hang up' }));
    await refused(withdrawPurchase(SELF), 'payment_provider_error');
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await fake.db.rACreditLedger.findMany({})).toEqual([]);

    // The subscription is cancelled at Stripe by now; the withdrawal is still open and completes.
    account.subscriptions.set('sub_1', stripeSubscription({ status: 'canceled' }));
    await expect(withdrawPurchase(SELF)).resolves.toMatchObject({ status: 'withdrawn', refundMinor: 2082 });
    expect(cancelCall(1)[2]).toEqual(cancelCall(0)[2]);
    expect(refundCall(1)[1]).toEqual(refundCall(0)[1]);
    expect(refundCall(1)[1]).toEqual({ idempotencyKey: 'refund:pi_inv:2082' });
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // Complete: the quote is gone and a third call is refused without touching Stripe.
    const before = writes().length;
    expect(await withdrawalQuote('u_1')).toBeNull();
    await refused(withdrawPurchase(SELF), 'withdrawal_not_available');
    expect(writes().length).toBe(before);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('outside the 14 days the call is refused and nothing is cancelled', async () => {
    await seedUser({ waiver: true });
    clock.now = at(15);
    const err = await refused(withdrawPurchase(SELF), 'withdrawal_not_available');
    expect(err.status).toBe(409);
    expect(writes()).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await fake.db.rACreditLedger.findMany({})).toEqual([]);
  });

  it('a purchase id that is not the quoted one, a renewal and a US buyer are refused; nothing is cancelled', async () => {
    await seedUser({ waiver: true });
    await refused(withdrawPurchase({ ...SELF, purchaseId: 'in_stale' }), 'withdrawal_not_available');
    account.invoices.set('in_1', subscriptionInvoice({ billing_reason: 'subscription_cycle' }));
    await refused(withdrawPurchase(SELF), 'withdrawal_not_available');
    account.invoices.set('in_1', subscriptionInvoice());
    await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { billingCountry: 'US' } });
    await refused(withdrawPurchase(SELF), 'withdrawal_not_available');
    expect(writes()).toEqual([]);
  });

  it('a subscription Stripe already holds as cancelled is not an error; a cancel that really failed stops before the refund', async () => {
    await seedUser({ waiver: true });
    account.subscriptions.set('sub_1', stripeSubscription({ status: 'canceled' }));
    stripe.subscriptions.cancel.mockRejectedValueOnce(stripeError({ code: 'resource_missing', statusCode: 404, message: "No such subscription: 'sub_1'" }));
    await expect(withdrawPurchase(SELF)).resolves.toMatchObject({ status: 'withdrawn' });
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);

    // Another user's purchase, where the cancel fails while the subscription is still active.
    await fake.db.rACreditLedger.deleteMany({});
    account.subscriptions.set('sub_1', stripeSubscription({ status: 'active' }));
    stripe.subscriptions.cancel.mockRejectedValueOnce(stripeError({ type: 'StripeAPIError', message: 'Stripe is down' }));
    await refused(withdrawPurchase(SELF), 'payment_provider_error');
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(await fake.db.rACreditLedger.findMany({})).toEqual([]);
  });

  it('a pass bought without the waiver: no subscription to cancel, a full refund (the webhook reverses the pass)', async () => {
    await seedUser({ planKey: 'pro_week_pass', subId: null });
    account.invoices.clear();
    account.invoices.set('in_once', oneTimeInvoice('pro_week_pass', 999));
    account.payments.set('in_once', paid('pi_pass'));
    stripe.refunds.create.mockImplementationOnce(async (params: Obj) => ({ id: 're_pass', amount: 999, currency: 'usd', charge: 'ch_pass', payment_intent: params.payment_intent }));
    clock.now = at(3);
    const res = await withdrawPurchase({ userId: 'u_1', purchaseId: 'in_once', actor: 'public_link' });
    expect(res).toEqual({ status: 'withdrawn', refundMinor: 999, currency: 'USD', accessEnded: true, rule: 'withdrawal_14d' });
    expect(writes()).toEqual(['refunds.create']);
    expect(refundCall()[0]).toMatchObject({ payment_intent: 'pi_pass', metadata: { kind: 'withdrawal', actor: 'public_link', planKey: 'pro_week_pass' } });
    expect(refundCall()[1]).toEqual({ idempotencyKey: 'refund:pi_pass:full' });
    // The row is untouched here: entitlements reverse on charge.refunded.
    expect(await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).toMatchObject({ tier: 'pro', planKey: 'pro_week_pass' });
    expect(sendEmail.mock.calls[0]![0].params).toMatchObject({ planKey: 'pro_week_pass', amountMinor: 999 });
  });

  it('what was already refunded for the purchase is taken off the amount that is still due', async () => {
    await seedUser({ waiver: true });
    await fake.db.rABillingRefund.create({
      data: { userId: 'u_1', brand: 'roboapply', rail: 'stripe', kind: 'refund', externalRef: 'ch_1:500', chargeId: 'ch_1', paymentIntentId: 'pi_inv', invoiceId: 'in_1', amountMinor: 500, currency: 'USD', full: false },
    });
    const res = await withdrawPurchase(SELF);
    // The buyer is owed 2082 in total; 500 went back earlier.
    expect(res.refundMinor).toBe(2082);
    expect(refundCall()[0].amount).toBe(1582);
    expect(refundCall()[1]).toEqual({ idempotencyKey: 'refund:pi_inv:1582' });
  });

  it('a withdrawal that stopped after its refund was recorded by the webhook finishes without refunding again', async () => {
    await seedUser({ waiver: true });
    // The refund went out and charge.refunded wrote its row, but the call died before the confirmation.
    await fake.db.rABillingRefund.create({
      data: { userId: 'u_1', brand: 'roboapply', rail: 'stripe', kind: 'withdrawal', externalRef: 'ch_1:2082', chargeId: 'ch_1', paymentIntentId: 'pi_inv', invoiceId: 'in_1', amountMinor: 2082, currency: 'USD', full: false },
    });
    account.subscriptions.set('sub_1', stripeSubscription({ status: 'canceled' }));
    await expect(withdrawPurchase(SELF)).resolves.toMatchObject({ status: 'withdrawn', refundMinor: 2082 });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    await refused(withdrawPurchase(SELF), 'withdrawal_not_available');
  });

  it('a purchase staff refunded in full, or one under dispute, has no withdrawal left', async () => {
    await seedUser({});
    await fake.db.rABillingRefund.create({
      data: { userId: 'u_1', brand: 'roboapply', rail: 'stripe', kind: 'refund', externalRef: 'ch_1:2499', paymentIntentId: 'pi_inv', invoiceId: 'in_1', amountMinor: 2499, currency: 'USD', full: true },
    });
    expect(await withdrawalQuote('u_1')).toBeNull();
    await refused(withdrawPurchase(SELF), 'withdrawal_not_available');
    await fake.db.rABillingRefund.deleteMany({});
    await fake.db.rABillingRefund.create({
      data: { userId: 'u_1', brand: 'roboapply', rail: 'stripe', kind: 'dispute', externalRef: 'dispute:dp_1', paymentIntentId: 'pi_inv', invoiceId: 'in_1', amountMinor: 2499, currency: 'USD', full: true },
    });
    expect(await withdrawalQuote('u_1')).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('on the last day of a weekly period nothing is left to refund: the subscription still ends and the mail says so', async () => {
    await seedUser({ waiver: true, planKey: 'pro_weekly' });
    account.invoices.set('in_1', weeklyInvoice());
    account.subscriptions.set('sub_1', stripeSubscription({ items: { data: [{ id: 'si_1', current_period_start: T0_S, current_period_end: T0_S + 7 * DAY_S }] } }));
    clock.now = new Date(at(6).getTime() + 3_600_000);
    const res = await withdrawPurchase(SELF);
    expect(res).toMatchObject({ status: 'withdrawn', refundMinor: 0, rule: 'withdrawal_14d_prorata' });
    expect(writes()).toEqual(['subscriptions.cancel']);
    expect(sendEmail.mock.calls[0]![0].params).toMatchObject({ planKey: 'pro_weekly', amountMinor: 0 });
  });

  it('a first week that is used up cannot be withdrawn from once Stripe has rolled the period: nothing is cancelled or refunded', async () => {
    await seedUser({ waiver: true, planKey: 'pro_weekly' });
    account.invoices.set('in_1', weeklyInvoice());
    account.subscriptions.set('sub_1', stripeSubscription({ status: 'past_due', items: { data: [{ id: 'si_1', current_period_start: T0_S + 7 * DAY_S, current_period_end: T0_S + 14 * DAY_S }] } }));
    // The renewal card failed: for days the first invoice stays the latest paid one.
    for (const now of [new Date(at(7).getTime() + 2 * 3_600_000), at(10), at(14)]) {
      clock.now = now;
      await refused(withdrawPurchase(SELF), 'withdrawal_not_available');
    }
    expect(writes()).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await fake.db.rACreditLedger.findMany({})).toEqual([]);
  });

  it('no Stripe client: rail_not_configured; a mail that cannot be sent does not fail a withdrawal that happened', async () => {
    await seedUser({ waiver: true });
    setStripeClientForTests(null);
    await refused(withdrawPurchase(SELF), 'rail_not_configured');
    setStripeClientForTests(stripe as never);
    sendEmail.mockRejectedValueOnce(new Error('mail transport down'));
    await expect(withdrawPurchase(SELF)).resolves.toMatchObject({ status: 'withdrawn', refundMinor: 2082 });
    expect(writes()).toEqual(['subscriptions.cancel', 'refunds.create']);
  });
});
