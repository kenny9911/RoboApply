// @vitest-environment node
//
// The webhook half of the refund engine (ST-4 parts 2 and 3; MARKET_STRATEGY
// §5.1 "Refunds and disputes" and the event table): `charge.refunded` and
// `charge.dispute.created`, dispatched through the billing service's
// `handleRoboApplyStripeEvent` exactly as the webhook route does.
//
// In-memory Prisma, a fake Stripe account, and the REAL practice-credit
// service (lib/mockCreditService.ts) on that same in-memory database, so the
// balances below are what a user would see. Nothing reaches Stripe.
// Every case is replayed: a second delivery of the same event changes nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('../../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../../test/fakePrisma.js');
  fake.db = createFakePrisma({ uniqueFields: { rACreditLedger: ['idempotencyKey'], rABillingRefund: ['externalRef'] } });
  return { default: fake.db };
});
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getMockPlanCatalog } from '../../../lib/mockInterviewPlans.js';
import { createStripeWebhookRouter } from '../../../roboapply/routes/stripeWebhook.js';
import { handleRoboApplyStripeEvent, setBillingServiceDepsForTests } from '../../../roboapply/services/RoboApplyBillingService.js';
import { logger } from '../../../services/LoggerService.js';
import { startRouteHarness } from '../../../test/routeHarness.js';
import { billingEventClaimKey, setStripeRefundDepsForTests, stripeEventHandler } from '../index.js';
import { packGrantId } from '../packs.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-10T08:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY_S = 86_400;
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

type Obj = Record<string, any>;

// ── The fake Stripe account ───────────────────────────────────────────────

const account = {
  /** payment intent id → the invoice it paid (with `expand: ['data.invoice']`). */
  invoiceByPaymentIntent: new Map<string, Obj>(),
  /** payment intent id → the Checkout Session of a one-time payment. */
  sessionByPaymentIntent: new Map<string, Obj>(),
  paymentIntents: new Map<string, Obj>(),
  charges: new Map<string, Obj>(),
  subscriptions: new Map<string, Obj>(),
  /** charge id → its refunds, oldest first. */
  refunds: new Map<string, Obj[]>(),
};

function stripeError(over: Obj): Error {
  return Object.assign(new Error(over.message ?? 'stripe error'), over);
}

const stripe = {
  invoicePayments: {
    list: vi.fn(async (params: Obj) => {
      const invoice = account.invoiceByPaymentIntent.get(params.payment?.payment_intent);
      return { data: invoice ? [{ id: 'inpay_1', status: 'paid', invoice, payment: { type: 'payment_intent', payment_intent: params.payment.payment_intent } }] : [] };
    }),
  },
  invoices: { retrieve: vi.fn(async (id: string) => [...account.invoiceByPaymentIntent.values()].find((i) => i.id === id)) },
  checkout: {
    sessions: {
      list: vi.fn(async (params: Obj) => {
        const s = account.sessionByPaymentIntent.get(params.payment_intent);
        return { data: s ? [s] : [] };
      }),
    },
  },
  paymentIntents: { retrieve: vi.fn(async (id: string) => account.paymentIntents.get(id) ?? { id, metadata: {} }) },
  charges: {
    retrieve: vi.fn(async (id: string) => {
      const c = account.charges.get(id);
      if (!c) throw stripeError({ code: 'resource_missing', statusCode: 404 });
      return c;
    }),
  },
  refunds: { list: vi.fn(async (params: Obj) => ({ data: account.refunds.get(params.charge) ?? [] })) },
  subscriptions: {
    retrieve: vi.fn(async (id: string) => {
      const sub = account.subscriptions.get(id);
      if (!sub) throw stripeError({ code: 'resource_missing', statusCode: 404 });
      return sub;
    }),
    cancel: vi.fn(async (id: string, _params: Obj, _opts: Obj) => {
      const sub = account.subscriptions.get(id);
      if (!sub || sub.status === 'canceled') throw stripeError({ code: 'resource_missing', statusCode: 404, message: `No such subscription: '${id}'` });
      sub.status = 'canceled';
      return sub;
    }),
  },
};

const refundMail = vi.fn(async (_input: Obj) => ({ status: 'sent' as const }));
const invalidate = vi.fn();
const serviceMail = vi.fn(async () => ({ status: 'sent' as const }));

let FREE_ALLOTMENT = 1;

// ── Purchases ─────────────────────────────────────────────────────────────

const CHECKOUT_META = (planKey: string) => ({ product: 'roboapply', brand: 'roboapply', planKey, userId: 'u_1', seekerProfileId: 'sp_1' });

/** A practice pack bought through Checkout: session, payment intent, invoice, and the grant row the webhook wrote. */
async function boughtPack(over: { session?: string; pi?: string; charge?: string; planKey?: string; credits?: number; amount?: number; expiresAt?: Date } = {}): Promise<Obj> {
  const session = over.session ?? 'cs_pack';
  const pi = over.pi ?? 'pi_pack';
  const planKey = over.planKey ?? 'practice_pack_5';
  const credits = over.credits ?? 5;
  const amount = over.amount ?? 999;
  account.sessionByPaymentIntent.set(pi, { id: session, customer: 'cus_1', mode: 'payment', payment_intent: pi, metadata: CHECKOUT_META(planKey) });
  account.invoiceByPaymentIntent.set(pi, { id: `in_${session}`, customer: 'cus_1', amount_paid: amount, currency: 'usd', metadata: CHECKOUT_META(planKey), parent: null });
  account.paymentIntents.set(pi, { id: pi, metadata: CHECKOUT_META(planKey) });
  await fake.db.rACreditGrant.create({
    data: { id: packGrantId('u_1', `stripe:${session}`), userId: 'u_1', bucket: 'practice', amount: credits, remaining: credits, reason: 'pack', expiresAt: over.expiresAt ?? new Date('2030-01-01T00:00:00.000Z') },
  });
  return { id: over.charge ?? 'ch_pack', object: 'charge', customer: 'cus_1', amount, amount_refunded: amount, currency: 'usd', payment_intent: pi, metadata: CHECKOUT_META(planKey) };
}

/** A 7-day pass bought through Checkout (two days ago unless said otherwise). The charge it returns is refunded in full. */
function boughtPass(over: { session?: string; pi?: string; charge?: string; daysAgo?: number } = {}): Obj {
  const session = over.session ?? 'cs_pass';
  const pi = over.pi ?? 'pi_pass';
  const created = NOW_S - (over.daysAgo ?? 2) * DAY_S;
  account.sessionByPaymentIntent.set(pi, { id: session, customer: 'cus_1', mode: 'payment', payment_intent: pi, metadata: CHECKOUT_META('pro_week_pass') });
  account.invoiceByPaymentIntent.set(pi, { id: `in_${session}`, customer: 'cus_1', amount_paid: 999, currency: 'usd', metadata: CHECKOUT_META('pro_week_pass'), parent: null });
  account.paymentIntents.set(pi, { id: pi, metadata: CHECKOUT_META('pro_week_pass') });
  return { id: over.charge ?? 'ch_pass', object: 'charge', created, customer: 'cus_1', amount: 999, amount_refunded: 999, currency: 'usd', payment_intent: pi, metadata: CHECKOUT_META('pro_week_pass') };
}

/** A paid subscription invoice (no plan key on the charge: the subscription carries it). */
function paidSubscriptionInvoice(over: { charge?: string; pi?: string; invoice?: string; sub?: string; amountRefunded?: number } = {}): Obj {
  const pi = over.pi ?? 'pi_sub';
  const sub = over.sub ?? 'sub_1';
  account.invoiceByPaymentIntent.set(pi, {
    id: over.invoice ?? 'in_sub',
    customer: 'cus_1',
    amount_paid: 2499,
    currency: 'usd',
    billing_reason: 'subscription_create',
    metadata: {},
    parent: { subscription_details: { subscription: sub, metadata: { product: 'roboapply', brand: 'roboapply', planKey: 'pro_monthly' } } },
  });
  if (!account.subscriptions.has(sub)) account.subscriptions.set(sub, { id: sub, status: 'active', customer: 'cus_1' });
  return { id: over.charge ?? 'ch_sub', object: 'charge', customer: 'cus_1', amount: 2499, amount_refunded: over.amountRefunded ?? 2499, currency: 'usd', payment_intent: pi, metadata: {} };
}

const refunded = (charge: Obj, id = 'evt_refund') => ({ id, type: 'charge.refunded', data: { object: charge } });
const disputed = (dispute: Obj, id = 'evt_dispute') => ({ id, type: 'charge.dispute.created', data: { object: dispute } });
const deliver = (event: Obj) => handleRoboApplyStripeEvent(event as never, stripe as never);

// ── The account under test ────────────────────────────────────────────────

const TABLES = ['user', 'seekerProfile', 'seekerSubscription', 'seekerConsentRecord', 'rACreditLedger', 'rACreditGrant', 'rABillingRefund', 'mockInterviewCreditLedger', 'alipayOrder'];

async function seedAccount(row: Obj = {}) {
  await fake.db.user.create({ data: { id: 'u_1', email: 'u_1@example.test', name: 'U', brand: 'roboapply' } });
  await fake.db.seekerProfile.create({ data: { id: 'sp_1', userId: 'u_1', locale: 'en', deletedAt: null } });
  await fake.db.seekerSubscription.create({
    data: {
      id: 'row_1',
      seekerProfileId: 'sp_1',
      tier: 'free',
      status: 'active',
      brand: 'roboapply',
      rail: 'stripe',
      planKey: 'free',
      interval: null,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      mockCredits: 0,
      mockCreditsRenewedAt: new Date('2026-10-01T00:00:00.000Z'),
      mockCreditsPeriodAllotment: 1,
      ...row,
    },
  });
}

/** A pass row whose run began two days ago (fulfilment sets `startedAt` when a run starts and keeps it across stacked passes). */
const PASS_ROW = (endsInDays: number, over: Obj = {}) => ({
  tier: 'pro',
  planKey: 'pro_week_pass',
  interval: 'pass',
  currentPeriodEnd: inDays(endsInDays),
  startedAt: inDays(-2),
  mockCredits: 1,
  mockCreditsPeriodAllotment: 1,
  ...over,
});
const SUB_ROW = (over: Obj = {}) => ({ tier: 'pro', planKey: 'pro_monthly', interval: 'month', stripeSubscriptionId: 'sub_1', currentPeriodEnd: inDays(25), mockCredits: 3, mockCreditsPeriodAllotment: 3, ...over });

const planRow = () => fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } });
const refundRows = () => fake.db.rABillingRefund.findMany({ orderBy: { externalRef: 'asc' } });
const practiceLedger = () => fake.db.mockInterviewCreditLedger.findMany({});
const claims = async () => (await fake.db.rACreditLedger.findMany({})).map((r: Obj) => r.idempotencyKey).sort();

/** Everything a refund may touch, without the columns that only say when a row was last written. */
async function state(): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const t of TABLES) out[t] = (await fake.db[t].findMany({})).map(({ updatedAt: _updatedAt, ...rest }: Obj) => rest);
  return JSON.stringify(out);
}

function stripeCallCount(): number {
  return [stripe.invoicePayments.list, stripe.invoices.retrieve, stripe.checkout.sessions.list, stripe.paymentIntents.retrieve, stripe.charges.retrieve, stripe.refunds.list, stripe.subscriptions.retrieve, stripe.subscriptions.cancel].reduce(
    (n, fn) => n + fn.mock.calls.length,
    0,
  );
}

/** Deliver the event again: it must answer as a duplicate and change nothing, at Stripe, in the database or in anyone's inbox. */
async function replayIsANoOp(event: Obj) {
  const before = await state();
  const calls = stripeCallCount();
  const mails = refundMail.mock.calls.length;
  const cancels = stripe.subscriptions.cancel.mock.calls.length;
  expect(await deliver(event)).toEqual({ handled: true, duplicate: true });
  expect(await state()).toBe(before);
  expect(stripe.subscriptions.cancel.mock.calls.length).toBe(cancels);
  expect(refundMail.mock.calls.length).toBe(mails);
  return { stripeCalls: stripeCallCount() - calls };
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const map of Object.values(account)) map.clear();
  for (const t of TABLES) await fake.db[t].deleteMany({});
  FREE_ALLOTMENT = (await getMockPlanCatalog()).plans.free.credits;
  setBillingServiceDepsForTests({
    db: fake.db as never,
    getStripe: () => stripe as never,
    now: () => NOW,
    grantIfNewPeriod: vi.fn(async () => 'skipped' as const) as never,
    grantPack: vi.fn(async () => ({})),
    sendEmail: serviceMail as never,
    getBalance: async () => ({ credits: 0, tier: 'free', periodAllotment: 1, renewedAt: null, currentPeriodEnd: null, ephemeral: false }),
    invalidate: () => {},
  });
  // The handlers use the database and the clock of the service that dispatches the event.
  // The practice-credit functions are the real ones (on the same fake database).
  setStripeRefundDepsForTests({ sendEmail: refundMail as never, invalidate });
});

afterEach(() => {
  setBillingServiceDepsForTests();
  setStripeRefundDepsForTests();
});

describe('the handlers are registered at boot by importing the billing index', () => {
  it('charge.refunded and charge.dispute.created have a handler', () => {
    expect(stripeEventHandler('charge.refunded')).toBeTypeOf('function');
    expect(stripeEventHandler('charge.dispute.created')).toBeTypeOf('function');
  });
});

describe('charge.refunded: a full refund of a practice pack', () => {
  it('a pack with 2 of 5 interviews used loses the remaining 3, once; nothing goes negative', async () => {
    await seedAccount({ mockCredits: 3 }); // no plan credits left, 5 from the pack, 2 used
    const charge = await boughtPack();
    const event = refunded(charge);

    expect(await deliver(event)).toEqual({ handled: true });

    expect((await planRow()).mockCredits).toBe(0);
    expect((await fake.db.rACreditGrant.findUnique({ where: { id: packGrantId('u_1', 'stripe:cs_pack') } })).remaining).toBe(0);
    expect(await practiceLedger()).toEqual([expect.objectContaining({ userId: 'u_1', delta: -3, balanceAfter: 0, reason: 'refund', source: 'stripe' })]);
    // The readable record. A refund made in the Dashboard carries no metadata: kind 'refund', actor 'stripe'.
    expect(await refundRows()).toEqual([
      expect.objectContaining({
        userId: 'u_1',
        brand: 'roboapply',
        rail: 'stripe',
        kind: 'refund',
        externalRef: 'ch_pack:999',
        chargeId: 'ch_pack',
        paymentIntentId: 'pi_pack',
        invoiceId: 'in_cs_pack',
        checkoutSessionId: 'cs_pack',
        planKey: 'practice_pack_5',
        amountMinor: 999,
        currency: 'USD',
        full: true,
        entitlementReversed: true,
        actor: 'stripe',
      }),
    ]);
    expect(await claims()).toContain(billingEventClaimKey('refund:ch_pack:999'));
    expect(invalidate).toHaveBeenCalledWith('u_1');
    expect(refundMail).toHaveBeenCalledTimes(1);
    expect(refundMail).toHaveBeenCalledWith({
      template: 'billing.refund_issued',
      to: 'u_1@example.test',
      userId: 'u_1',
      locale: 'en',
      brand: 'roboapply',
      params: { planKey: 'practice_pack_5', amountMinor: 999, currency: 'USD', full: true, completesEarlierRefunds: false, accessEnded: true },
    });
    // The plan row itself is untouched: a pack is not a plan.
    expect(await planRow()).toMatchObject({ tier: 'free', planKey: 'free', status: 'active' });

    const replay = await replayIsANoOp(event);
    expect(replay.stripeCalls).toBe(0);
    expect((await planRow()).mockCredits).toBe(0);
  });

  it('a pack that was used up loses nothing more: the balance stays at 0, never below', async () => {
    await seedAccount({ mockCredits: 0 });
    const event = refunded(await boughtPack());
    expect(await deliver(event)).toEqual({ handled: true });
    expect((await planRow()).mockCredits).toBe(0);
    expect(await practiceLedger()).toEqual([]);
    expect((await fake.db.rACreditGrant.findMany({}))[0].remaining).toBe(0);
    expect((await refundRows())[0]).toMatchObject({ full: true, entitlementReversed: true });
    await replayIsANoOp(event);
  });

  it('plan credits are not the pack\'s: an untouched pack on a Pro plan takes its 5 and leaves the plan\'s 3', async () => {
    await seedAccount(SUB_ROW({ mockCredits: 8 }));
    const event = refunded(await boughtPack());
    await deliver(event);
    expect((await planRow()).mockCredits).toBe(3);
    expect(await planRow()).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', stripeSubscriptionId: 'sub_1' });
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    await replayIsANoOp(event);
  });

  it('with two packs, the refunded one gives back only what is left of IT (the sooner-expiring pack is spent first)', async () => {
    await seedAccount({ mockCredits: 7 }); // 10 from two packs, 3 used: all three from the older pack
    const older = await boughtPack({ session: 'cs_old', pi: 'pi_old', charge: 'ch_old', expiresAt: new Date('2029-01-01T00:00:00.000Z') });
    const newer = await boughtPack({ session: 'cs_new', pi: 'pi_new', charge: 'ch_new', expiresAt: new Date('2030-01-01T00:00:00.000Z') });
    await deliver(refunded(older, 'evt_old'));
    expect((await planRow()).mockCredits).toBe(5); // the older pack had 2 left
    await replayIsANoOp(refunded(older, 'evt_old'));
    await deliver(refunded(newer, 'evt_new'));
    expect((await planRow()).mockCredits).toBe(0);
    expect((await fake.db.rACreditGrant.findMany({})).map((g: Obj) => g.remaining)).toEqual([0, 0]);
    expect((await refundRows()).map((r: Obj) => [r.externalRef, r.checkoutSessionId, r.entitlementReversed])).toEqual([
      ['ch_new:999', 'cs_new', true],
      ['ch_old:999', 'cs_old', true],
    ]);
  });
});

describe('charge.refunded: a full refund of the 7-day pass', () => {
  it('the running pass ends now, once: the plan is Free and the practice balance is the Free allotment', async () => {
    await seedAccount(PASS_ROW(5, { mockCredits: 0.5 }));
    const event = refunded(boughtPass());

    expect(await deliver(event)).toEqual({ handled: true });

    const row = await planRow();
    expect(row).toMatchObject({ tier: 'free', planKey: 'free', status: 'canceled', interval: null, cancelAtPeriodEnd: false });
    expect(row.currentPeriodEnd).toEqual(NOW);
    expect(row.canceledAt).toEqual(NOW);
    expect(row.mockCredits).toBe(FREE_ALLOTMENT);
    expect(row.mockCreditsPeriodAllotment).toBe(FREE_ALLOTMENT);
    expect(await refundRows()).toEqual([
      expect.objectContaining({ kind: 'refund', externalRef: 'ch_pass:999', planKey: 'pro_week_pass', checkoutSessionId: 'cs_pass', invoiceId: 'in_cs_pass', full: true, entitlementReversed: true }),
    ]);
    expect(refundMail.mock.calls[0]![0].params).toEqual({ planKey: 'pro_week_pass', amountMinor: 999, currency: 'USD', full: true, completesEarlierRefunds: false, accessEnded: true });
    // The pass has no Stripe subscription: nothing is cancelled at Stripe.
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();

    await replayIsANoOp(event);
    expect((await planRow()).currentPeriodEnd).toEqual(NOW);
  });

  it('a refunded pass stacked on another pass shortens access by one pass length instead of ending it', async () => {
    await seedAccount(PASS_ROW(12)); // two passes: 5 days left of the first, 7 of the second
    const event = refunded(boughtPass());
    expect(await deliver(event)).toEqual({ handled: true });
    const row = await planRow();
    expect(row).toMatchObject({ tier: 'pro', planKey: 'pro_week_pass', status: 'active', mockCredits: 1 });
    expect(row.currentPeriodEnd).toEqual(inDays(5));
    expect((await refundRows())[0]).toMatchObject({ full: true, entitlementReversed: true });
    expect(await practiceLedger()).toEqual([]);

    await replayIsANoOp(event);
    // Still one pass length, not two.
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(5));
  });

  it('a pass that is over, or a plan that is not this pass, is left alone: the refund is recorded with nothing to reverse', async () => {
    await seedAccount(PASS_ROW(-1));
    const expired = refunded(boughtPass());
    expect(await deliver(expired)).toEqual({ handled: true });
    expect(await planRow()).toMatchObject({ tier: 'pro', planKey: 'pro_week_pass' });
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(-1));
    expect((await refundRows())[0]).toMatchObject({ full: true, entitlementReversed: false });
    // The mail states the refund and claims nothing about access.
    expect(refundMail.mock.calls[0]![0].params).toMatchObject({ full: true, accessEnded: false });

    // Later the same person subscribed; an old pass charge refunded now never touches the subscription.
    await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: SUB_ROW() });
    const old = refunded(boughtPass({ session: 'cs_old_pass', pi: 'pi_old_pass', charge: 'ch_old_pass' }), 'evt_old_pass');
    expect(await deliver(old)).toEqual({ handled: true });
    expect(await planRow()).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', stripeSubscriptionId: 'sub_1', mockCredits: 3 });
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(25));
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('a refund or a dispute of an old pass that ended before the running pass began leaves the running pass alone', async () => {
    // Pass A was bought 20 days ago and ran out 13 days ago. Pass B was bought 2 days ago and runs for 5 more days.
    await seedAccount(PASS_ROW(5));
    const oldCharge = boughtPass({ session: 'cs_pass_a', pi: 'pi_pass_a', charge: 'ch_pass_a', daysAgo: 20 });
    account.charges.set('ch_pass_a', oldCharge);
    const before = JSON.stringify(await planRow());

    // Staff refund the old charge in full.
    const event = refunded(oldCharge, 'evt_old_a');
    expect(await deliver(event)).toEqual({ handled: true });
    expect(JSON.stringify(await planRow())).toBe(before);
    expect(await planRow()).toMatchObject({ tier: 'pro', planKey: 'pro_week_pass', status: 'active', mockCredits: 1 });
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(5));
    expect(await practiceLedger()).toEqual([]);
    expect(await refundRows()).toEqual([expect.objectContaining({ kind: 'refund', externalRef: 'ch_pass_a:999', planKey: 'pro_week_pass', full: true, entitlementReversed: false })]);
    // The mail states the refund and says nothing about paid time being gone.
    expect(refundMail.mock.calls[0]![0].params).toMatchObject({ full: true, accessEnded: false });
    expect(await deliver(event)).toEqual({ handled: true, duplicate: true });
    expect(JSON.stringify(await planRow())).toBe(before);

    // The bank disputes another old charge weeks later: flagged, and pass B keeps its time.
    const olderCharge = boughtPass({ session: 'cs_pass_z', pi: 'pi_pass_z', charge: 'ch_pass_z', daysAgo: 40 });
    account.charges.set('ch_pass_z', olderCharge);
    const dispute = disputed({ id: 'dp_old', object: 'dispute', charge: 'ch_pass_z', amount: 999, currency: 'usd', reason: 'fraudulent' }, 'evt_dp_old');
    expect(await deliver(dispute)).toEqual({ handled: true });
    expect(JSON.stringify(await planRow())).toBe(before);
    expect((await refundRows()).find((r: Obj) => r.kind === 'dispute')).toMatchObject({ externalRef: 'dispute:dp_old', chargeId: 'ch_pass_z', full: true, entitlementReversed: false });
    expect(await deliver(dispute)).toEqual({ handled: true, duplicate: true });
    expect(JSON.stringify(await planRow())).toBe(before);

    // The running pass itself (bought 2 days ago) is still reversed by its own refund.
    expect(await deliver(refunded(boughtPass(), 'evt_b'))).toEqual({ handled: true });
    expect(await planRow()).toMatchObject({ tier: 'free', planKey: 'free', status: 'canceled' });
  });

  it('a pass whose fulfilment came late is judged by when it was activated, not by when the card was charged', async () => {
    // The charge is three hours older than the run (the webhook was delayed); the checkout claim was written with the activation.
    await seedAccount(PASS_ROW(7, { startedAt: NOW }));
    const charge = { ...boughtPass(), created: NOW_S - 3 * 3600 };
    await fake.db.rACreditLedger.create({
      data: { userId: 'u_1', bucket: 'billing_event', amount: 0, status: 'committed', fromSource: 'stripe', idempotencyKey: billingEventClaimKey('checkout:cs_pass'), refType: 'stripe_checkout', refId: 'checkout:cs_pass', settledAt: NOW },
    });
    expect(await deliver(refunded(charge))).toEqual({ handled: true });
    expect(await planRow()).toMatchObject({ tier: 'free', planKey: 'free', status: 'canceled' });
    expect((await refundRows())[0]).toMatchObject({ full: true, entitlementReversed: true });
  });

  it('a second pass stacked on a running one is part of the same run: its refund shortens it; a row that has no start date is reversed as before', async () => {
    // Run began 6 days ago with pass A; pass B was bought yesterday and stacked (8 days left in all).
    await seedAccount(PASS_ROW(8, { startedAt: inDays(-6) }));
    expect(await deliver(refunded(boughtPass({ daysAgo: 1 })))).toEqual({ handled: true });
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(1));
    expect(await planRow()).toMatchObject({ tier: 'pro', status: 'active' });

    // A legacy row that never recorded when its run began cannot be told apart: the old charge still takes one length.
    await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { startedAt: null, currentPeriodEnd: inDays(10) } });
    const old = boughtPass({ session: 'cs_legacy', pi: 'pi_legacy', charge: 'ch_legacy_pass', daysAgo: 20 });
    expect(await deliver(refunded(old, 'evt_legacy'))).toEqual({ handled: true });
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(3));
  });

  it('finds the plan on the payment intent when neither the charge, the invoice nor the session names it', async () => {
    await seedAccount(PASS_ROW(5));
    const charge = { ...boughtPass(), metadata: {} };
    account.invoiceByPaymentIntent.delete('pi_pass');
    account.sessionByPaymentIntent.set('pi_pass', { id: 'cs_pass', customer: 'cus_1', mode: 'payment', payment_intent: 'pi_pass', metadata: {} });
    expect(await deliver(refunded(charge))).toEqual({ handled: true });
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_pass');
    expect(await planRow()).toMatchObject({ tier: 'free', status: 'canceled' });
    expect((await refundRows())[0]).toMatchObject({ planKey: 'pro_week_pass', invoiceId: null, checkoutSessionId: 'cs_pass', entitlementReversed: true });
  });
});

describe('charge.refunded: a full refund of a subscription invoice', () => {
  it('cancels the subscription now with the idempotency key, once, and resets the period\'s practice credits', async () => {
    await seedAccount(SUB_ROW());
    const event = refunded(paidSubscriptionInvoice());

    expect(await deliver(event)).toEqual({ handled: true });

    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_1', {}, { idempotencyKey: 'refundcancel:sub_1:ch_sub' });
    const row = await planRow();
    expect(row.mockCredits).toBe(FREE_ALLOTMENT);
    // Access ends through customer.subscription.deleted (the billing service's handler): this handler leaves the plan row to it.
    expect(row).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', status: 'active', stripeSubscriptionId: 'sub_1' });
    expect(await refundRows()).toEqual([
      expect.objectContaining({ kind: 'refund', externalRef: 'ch_sub:2499', invoiceId: 'in_sub', checkoutSessionId: null, planKey: 'pro_monthly', amountMinor: 2499, full: true, entitlementReversed: true }),
    ]);
    expect(refundMail.mock.calls[0]![0].params).toEqual({ planKey: 'pro_monthly', amountMinor: 2499, currency: 'USD', full: true, completesEarlierRefunds: false, accessEnded: true });

    await replayIsANoOp(event);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
  });

  it('a subscription that is already cancelled (a withdrawal cancelled it first) is not an error; no second mail for a withdrawal', async () => {
    await seedAccount(SUB_ROW());
    const charge = paidSubscriptionInvoice();
    account.subscriptions.get('sub_1')!.status = 'canceled';
    account.refunds.set('ch_sub', [{ id: 're_w', amount: 2499, created: NOW_S, status: 'succeeded', reason: 'requested_by_customer', metadata: { product: 'roboapply', userId: 'u_1', actor: 'self', kind: 'withdrawal', planKey: 'pro_monthly', reason: 'withdrawal' } }]);
    const event = refunded(charge);
    expect(await deliver(event)).toEqual({ handled: true });
    expect((await refundRows())[0]).toMatchObject({ kind: 'withdrawal', actor: 'self', reason: 'withdrawal', full: true, entitlementReversed: true });
    expect((await planRow()).mockCredits).toBe(FREE_ALLOTMENT);
    // The withdrawal has its own confirmation (withdrawPurchase): no refund mail on top of it.
    expect(refundMail).not.toHaveBeenCalled();
    await replayIsANoOp(event);
  });
});

describe('charge.refunded: a partial refund', () => {
  it('is recorded and changes no access; a second partial refund of the same charge is a new row; the last one that completes it reverses', async () => {
    await seedAccount(SUB_ROW());
    const first = refunded(paidSubscriptionInvoice({ amountRefunded: 1000 }), 'evt_p1');
    account.refunds.set('ch_sub', [{ id: 're_1', amount: 1000, created: NOW_S, status: 'succeeded', reason: 'requested_by_customer', metadata: { product: 'roboapply', userId: 'u_1', actor: 'admin_7', kind: 'refund', reason: 'Goodwill' } }]);
    const before = JSON.stringify(await planRow());

    expect(await deliver(first)).toEqual({ handled: true });

    expect(JSON.stringify(await planRow())).toBe(before);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(await practiceLedger()).toEqual([]);
    expect(await refundRows()).toEqual([
      expect.objectContaining({ kind: 'refund', externalRef: 'ch_sub:1000', amountMinor: 1000, full: false, entitlementReversed: false, actor: 'admin_7', reason: 'Goodwill', invoiceId: 'in_sub' }),
    ]);
    expect(refundMail).toHaveBeenCalledTimes(1);
    expect(refundMail.mock.calls[0]![0].params).toEqual({ planKey: 'pro_monthly', amountMinor: 1000, currency: 'USD', full: false, completesEarlierRefunds: false, accessEnded: false });
    const replay = await replayIsANoOp(first);
    expect(replay.stripeCalls).toBe(0);

    // A second partial refund: the charge now says 1800 refunded. A new claim, a new row for the 800.
    account.refunds.get('ch_sub')!.push({ id: 're_2', amount: 800, created: NOW_S + 60, status: 'succeeded', reason: null, metadata: {} });
    const second = refunded(paidSubscriptionInvoice({ amountRefunded: 1800 }), 'evt_p2');
    expect(await deliver(second)).toEqual({ handled: true });
    expect((await refundRows()).map((r: Obj) => [r.externalRef, r.amountMinor, r.full, r.actor])).toEqual([
      ['ch_sub:1000', 1000, false, 'admin_7'],
      ['ch_sub:1800', 800, false, 'stripe'],
    ]);
    expect(JSON.stringify(await planRow())).toBe(before);
    expect(refundMail).toHaveBeenCalledTimes(2);
    await replayIsANoOp(second);
    await replayIsANoOp(first);

    // The rest: the charge is refunded in full now, and only now access changes.
    account.refunds.get('ch_sub')!.push({ id: 're_3', amount: 699, created: NOW_S + 120, status: 'succeeded', reason: null, metadata: {} });
    const last = refunded(paidSubscriptionInvoice({ amountRefunded: 2499 }), 'evt_p3');
    expect(await deliver(last)).toEqual({ handled: true });
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect((await refundRows()).map((r: Obj) => [r.externalRef, r.amountMinor, r.full, r.entitlementReversed])).toEqual([
      ['ch_sub:1000', 1000, false, false],
      ['ch_sub:1800', 800, false, false],
      ['ch_sub:2499', 699, true, true],
    ]);
    // The mail is about the 6.99 that went back now: it must not call that "the full amount you paid".
    expect(refundMail.mock.calls[1]![0].params).toMatchObject({ amountMinor: 800, full: false, completesEarlierRefunds: false });
    expect(refundMail.mock.calls[2]![0].params).toEqual({ planKey: 'pro_monthly', amountMinor: 699, currency: 'USD', full: true, completesEarlierRefunds: true, accessEnded: true });
    await replayIsANoOp(last);
  });

  it('the partial refund of a withdrawal is recorded as a withdrawal and sends no refund mail', async () => {
    await seedAccount(SUB_ROW());
    const event = refunded(paidSubscriptionInvoice({ amountRefunded: 2082 }));
    account.refunds.set('ch_sub', [{ id: 're_w', amount: 2082, created: NOW_S, status: 'succeeded', metadata: { product: 'roboapply', userId: 'u_1', actor: 'public_link', kind: 'withdrawal', reason: 'withdrawal' } }]);
    expect(await deliver(event)).toEqual({ handled: true });
    expect(await refundRows()).toEqual([expect.objectContaining({ kind: 'withdrawal', actor: 'public_link', amountMinor: 2082, full: false, entitlementReversed: false })]);
    // The subscription was cancelled by withdrawPurchase before the refund; this handler cancels nothing for a partial refund.
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(refundMail).not.toHaveBeenCalled();
    await replayIsANoOp(event);
  });

  it('a partial refund of a pack leaves the pack and the balance alone', async () => {
    await seedAccount({ mockCredits: 5 });
    const charge = { ...(await boughtPack()), amount_refunded: 400 };
    const event = refunded(charge);
    expect(await deliver(event)).toEqual({ handled: true });
    expect((await planRow()).mockCredits).toBe(5);
    expect((await fake.db.rACreditGrant.findMany({}))[0].remaining).toBe(5);
    expect((await refundRows())[0]).toMatchObject({ externalRef: 'ch_pack:400', amountMinor: 400, full: false, entitlementReversed: false });
    await replayIsANoOp(event);
  });
});

describe('charge.refunded: whose charge it is', () => {
  it('a charge of a customer we do not know is ignored with handled false, and over HTTP with 200', async () => {
    await seedAccount(SUB_ROW());
    const foreign = { id: 'ch_other', object: 'charge', customer: 'cus_of_another_product', amount: 5000, amount_refunded: 5000, currency: 'usd', payment_intent: 'pi_other', metadata: {} };
    const before = await state();
    expect(await deliver(refunded(foreign))).toEqual({ handled: false });
    expect(await deliver(refunded({ ...foreign, customer: null }))).toEqual({ handled: false });
    expect(await state()).toBe(before);
    expect(stripeCallCount()).toBe(0);
    expect(refundMail).not.toHaveBeenCalled();

    let next: Obj = refunded(foreign);
    const verifying = { ...stripe, webhooks: { constructEvent: vi.fn(() => next) } };
    const wh = await startRouteHarness({ mounts: [['/wh', createStripeWebhookRouter({ getStripe: () => verifying as never, secret: () => 'whsec_test' })]] });
    try {
      const post = () => wh.request<any>('POST', '/wh', { headers: { 'stripe-signature': 't=1,v1=x' }, body: {} });
      const ignored = await post();
      expect([ignored.status, ignored.body]).toEqual([200, { received: true, handled: false }]);
      // Our own customer over the same route: handled, then a duplicate.
      next = refunded(paidSubscriptionInvoice());
      const handled = await post();
      expect(handled.status).toBe(200);
      expect(handled.body).toMatchObject({ received: true, handled: true });
      const again = await post();
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ handled: true, duplicate: true });
      expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
      // A failure answers 500, so Stripe retries.
      next = refunded({ ...paidSubscriptionInvoice({ charge: 'ch_fail', pi: 'pi_fail', invoice: 'in_fail' }) }, 'evt_fail');
      stripe.invoicePayments.list.mockRejectedValueOnce(new Error('stripe is down'));
      expect((await post()).status).toBe(500);
    } finally {
      await wh.close();
    }
  });

  it('a row of another brand is never changed by a Stripe event (rule A11)', async () => {
    await seedAccount(PASS_ROW(5, { brand: 'goapply', rail: 'alipay' }));
    const before = await state();
    expect(await deliver(refunded(boughtPass()))).toEqual({ handled: true });
    expect(await state()).toBe(before);
    expect(stripeCallCount()).toBe(0);
    expect(refundMail).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('RA_BILLING', expect.stringContaining('non-Stripe brand'), expect.objectContaining({ brand: 'goapply' }));
    // The same for a dispute.
    account.charges.set('ch_pass', boughtPass());
    expect(await deliver(disputed({ id: 'dp_go', charge: 'ch_pass', amount: 999, currency: 'usd', reason: 'fraudulent' }))).toEqual({ handled: true });
    expect(await state()).toBe(before);
  });

  it('a purchase that is not one of our plans is recorded and reverses nothing', async () => {
    await seedAccount(SUB_ROW());
    const charge = { id: 'ch_legacy', object: 'charge', customer: 'cus_1', amount: 1500, amount_refunded: 1500, currency: 'usd', payment_intent: null, metadata: {} };
    const event = refunded(charge);
    expect(await deliver(event)).toEqual({ handled: true });
    expect(await refundRows()).toEqual([expect.objectContaining({ externalRef: 'ch_legacy:1500', planKey: null, paymentIntentId: null, full: true, entitlementReversed: false, amountMinor: 1500 })]);
    expect(await planRow()).toMatchObject({ tier: 'pro', mockCredits: 3 });
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(await deliver(event)).toEqual({ handled: true, duplicate: true });
    expect(await refundRows()).toHaveLength(1);
    expect(refundMail).toHaveBeenCalledTimes(1);
  });
});

describe('charge.refunded: failures and concurrent deliveries', () => {
  it('a delivery that fails half way answers failed (HTTP 500) and the next delivery finishes the job, once', async () => {
    await seedAccount(SUB_ROW());
    const event = refunded(paidSubscriptionInvoice());
    // Stripe is down for the cancel, and the subscription is still active.
    stripe.subscriptions.cancel.mockRejectedValueOnce(stripeError({ type: 'StripeAPIError', message: 'Stripe is down' }));

    expect(await deliver(event)).toEqual({ handled: false, failed: true });
    // The refund is on record, its reversal is not done yet, and nobody was told it was.
    expect(await refundRows()).toEqual([expect.objectContaining({ externalRef: 'ch_sub:2499', full: true, entitlementReversed: false })]);
    expect((await planRow()).mockCredits).toBe(3);
    expect(refundMail).not.toHaveBeenCalled();

    // Stripe retries: not the first delivery any more, but the work is finished.
    expect(await deliver(event)).toEqual({ handled: true, duplicate: true });
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(2);
    expect(stripe.subscriptions.cancel.mock.calls[1]![2]).toEqual({ idempotencyKey: 'refundcancel:sub_1:ch_sub' });
    expect((await refundRows())[0]).toMatchObject({ entitlementReversed: true });
    expect((await planRow()).mockCredits).toBe(FREE_ALLOTMENT);
    expect(refundMail).toHaveBeenCalledTimes(1);
    await replayIsANoOp(event);
  });

  it('a delivery that fails before the row is written is finished by the next one too', async () => {
    await seedAccount(PASS_ROW(12));
    const event = refunded(boughtPass());
    stripe.checkout.sessions.list.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await deliver(event)).toEqual({ handled: false, failed: true });
    expect(await refundRows()).toEqual([]);
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(12));
    expect(await deliver(event)).toEqual({ handled: true, duplicate: true });
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(5));
    expect((await refundRows())[0]).toMatchObject({ full: true, entitlementReversed: true });
    await replayIsANoOp(event);
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(5));
  });

  it('two deliveries at the same moment reverse once: one pass length, one row, one mail', async () => {
    await seedAccount(PASS_ROW(19)); // three passes stacked
    const event = refunded(boughtPass());
    const results = await Promise.all([deliver(event), deliver(event)]);
    expect(results.every((r) => r.handled && !r.failed)).toBe(true);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(12));
    expect(await refundRows()).toHaveLength(1);
    expect((await refundRows())[0]).toMatchObject({ entitlementReversed: true });
    expect(refundMail).toHaveBeenCalledTimes(1);
  });

  it('two deliveries at the same moment take a pack\'s credits once', async () => {
    await seedAccount({ mockCredits: 5 });
    const event = refunded(await boughtPack());
    const results = await Promise.all([deliver(event), deliver(event)]);
    expect(results.every((r) => r.handled && !r.failed)).toBe(true);
    expect((await planRow()).mockCredits).toBe(0);
    expect(await practiceLedger()).toHaveLength(1);
    expect(await refundRows()).toHaveLength(1);
    expect(refundMail).toHaveBeenCalledTimes(1);
  });

  it('a mail that cannot be sent does not fail the event', async () => {
    await seedAccount(PASS_ROW(5));
    refundMail.mockRejectedValueOnce(new Error('mail transport down'));
    const event = refunded(boughtPass());
    expect(await deliver(event)).toEqual({ handled: true });
    expect(await planRow()).toMatchObject({ tier: 'free', status: 'canceled' });
    await replayIsANoOp(event);
  });
});

describe('charge.dispute.created', () => {
  const dispute = (charge: string, over: Obj = {}) => ({ id: 'dp_1', object: 'dispute', charge, amount: 999, currency: 'usd', reason: 'fraudulent', status: 'needs_response', ...over });

  it('a dispute on a pass charge ends the pass once and writes one dispute row; staff get one error line; the user gets no mail', async () => {
    await seedAccount(PASS_ROW(5));
    account.charges.set('ch_pass', boughtPass());
    const event = disputed(dispute('ch_pass'));

    expect(await deliver(event)).toEqual({ handled: true });

    expect(stripe.charges.retrieve).toHaveBeenCalledWith('ch_pass');
    expect(await planRow()).toMatchObject({ tier: 'free', planKey: 'free', status: 'canceled', mockCredits: FREE_ALLOTMENT });
    expect((await planRow()).currentPeriodEnd).toEqual(NOW);
    expect(await refundRows()).toEqual([
      expect.objectContaining({
        userId: 'u_1',
        brand: 'roboapply',
        rail: 'stripe',
        kind: 'dispute',
        externalRef: 'dispute:dp_1',
        chargeId: 'ch_pass',
        paymentIntentId: 'pi_pass',
        checkoutSessionId: 'cs_pass',
        planKey: 'pro_week_pass',
        amountMinor: 999,
        currency: 'USD',
        full: true,
        entitlementReversed: true,
        reason: 'fraudulent',
        actor: 'stripe',
      }),
    ]);
    expect(await claims()).toContain(billingEventClaimKey('dispute:dp_1'));
    expect(refundMail).not.toHaveBeenCalled();
    const staffLines = vi.mocked(logger.error).mock.calls.filter((c) => String(c[1]).includes('disputed'));
    expect(staffLines).toHaveLength(1);
    expect(staffLines[0]![2]).toEqual({ userId: 'u_1', disputeId: 'dp_1', chargeId: 'ch_pass', amountMinor: 999, currency: 'USD', reason: 'fraudulent', outcome: 'pass_ended' });
    // No card data and no address in the line.
    expect(JSON.stringify(staffLines[0])).not.toMatch(/card|last4|@|email/i);

    await replayIsANoOp(event);
    expect(vi.mocked(logger.error).mock.calls.filter((c) => String(c[1]).includes('disputed'))).toHaveLength(1);
  });

  it('a dispute on a pack charge zeroes what is left of the pack, once', async () => {
    await seedAccount({ mockCredits: 4 });
    const charge = await boughtPack();
    const event = disputed(dispute('ch_pack', { charge })); // Stripe may send the charge expanded
    expect(await deliver(event)).toEqual({ handled: true });
    expect(stripe.charges.retrieve).not.toHaveBeenCalled();
    expect((await planRow()).mockCredits).toBe(0);
    expect((await fake.db.rACreditGrant.findMany({}))[0].remaining).toBe(0);
    expect((await refundRows())[0]).toMatchObject({ kind: 'dispute', externalRef: 'dispute:dp_1', chargeId: 'ch_pack', planKey: 'practice_pack_5', entitlementReversed: true });
    await replayIsANoOp(event);
    expect(await practiceLedger()).toHaveLength(1);
  });

  it('a dispute on a subscription charge cancels the subscription now and resets the practice credits, once', async () => {
    await seedAccount(SUB_ROW());
    account.charges.set('ch_sub', paidSubscriptionInvoice({ amountRefunded: 0 }));
    const event = disputed(dispute('ch_sub', { amount: 2499, reason: 'subscription_canceled' }));
    expect(await deliver(event)).toEqual({ handled: true });
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_1', {}, { idempotencyKey: 'refundcancel:sub_1:ch_sub' });
    expect((await planRow()).mockCredits).toBe(FREE_ALLOTMENT);
    expect(await refundRows()).toEqual([expect.objectContaining({ kind: 'dispute', externalRef: 'dispute:dp_1', invoiceId: 'in_sub', planKey: 'pro_monthly', amountMinor: 2499, reason: 'subscription_canceled', entitlementReversed: true })]);
    expect(refundMail).not.toHaveBeenCalled();
    await replayIsANoOp(event);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
  });

  it('a dispute on a charge of an unknown customer answers handled false and writes nothing', async () => {
    await seedAccount(SUB_ROW());
    account.charges.set('ch_other', { id: 'ch_other', customer: 'cus_of_another_product', amount: 999, amount_refunded: 0, currency: 'usd', payment_intent: 'pi_other', metadata: {} });
    const before = await state();
    expect(await deliver(disputed(dispute('ch_other')))).toEqual({ handled: false });
    expect(await state()).toBe(before);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error).mock.calls.filter((c) => String(c[1]).includes('disputed'))).toHaveLength(0);
    // A dispute that names no charge is not ours to handle either.
    expect(await deliver(disputed(dispute('ch_other', { charge: null })))).toEqual({ handled: false });
  });

  it('one charge is reversed once, whether the refund or the dispute comes first', async () => {
    await seedAccount(PASS_ROW(19)); // three passes stacked
    const charge = boughtPass();
    account.charges.set('ch_pass', charge);
    expect(await deliver(refunded(charge))).toEqual({ handled: true });
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(12));
    // The bank disputes the same charge afterwards: flagged, not reversed again.
    expect(await deliver(disputed(dispute('ch_pass')))).toEqual({ handled: true });
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(12));
    expect((await refundRows()).map((r: Obj) => [r.kind, r.externalRef, r.entitlementReversed])).toEqual([
      ['refund', 'ch_pass:999', true],
      ['dispute', 'dispute:dp_1', false],
    ]);

    // The other order, on another charge.
    const second = boughtPass({ session: 'cs_pass2', pi: 'pi_pass2', charge: 'ch_pass2' });
    account.charges.set('ch_pass2', second);
    expect(await deliver(disputed(dispute('ch_pass2', { id: 'dp_2' }), 'evt_dp2'))).toEqual({ handled: true });
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(5));
    expect(await deliver(refunded(second, 'evt_refund2'))).toEqual({ handled: true });
    expect((await planRow()).currentPeriodEnd).toEqual(inDays(5));
    expect(await planRow()).toMatchObject({ tier: 'pro', status: 'active' });
  });

  it('a dispute delivery that fails is finished by the next one', async () => {
    await seedAccount(PASS_ROW(5));
    account.charges.set('ch_pass', boughtPass());
    const event = disputed(dispute('ch_pass'));
    stripe.charges.retrieve.mockRejectedValueOnce(new Error('timeout'));
    expect(await deliver(event)).toEqual({ handled: false, failed: true });
    expect(await refundRows()).toEqual([]);
    expect(await deliver(event)).toEqual({ handled: true });
    expect(await planRow()).toMatchObject({ tier: 'free', status: 'canceled' });
    await replayIsANoOp(event);
  });
});
