// @vitest-environment node
//
// The shared webhook pieces (MARKET_STRATEGY §5.1 event table): the one-time
// claim, the "whose object is it" lookup and the handler registry. In-memory
// Prisma; no Stripe.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { BILLING_ERROR_STATUS, BillingError } from './errors.js';
import {
  billingEventClaimKey,
  claimBillingEvent,
  findBillingOwnerByCustomer,
  invoiceSubscriptionId,
  registerStripeEventHandler,
  stripeEventHandler,
  unregisterStripeEventHandlerForTests,
  type BillingClaimDb,
  type BillingOwnerDb,
  type StripeEventHandler,
} from './stripeEvents.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');

function ledgerDb() {
  return createFakePrisma({ uniqueFields: { rACreditLedger: ['idempotencyKey'] } });
}

describe('claimBillingEvent', () => {
  it('returns true once and false on the second call with the same key', async () => {
    const db = ledgerDb();
    expect(await claimBillingEvent(db as unknown as BillingClaimDb, 'u_1', 'refund:ch_1:2499', 'stripe_refund', NOW)).toBe(true);
    expect(await claimBillingEvent(db as unknown as BillingClaimDb, 'u_1', 'refund:ch_1:2499', 'stripe_refund', NOW)).toBe(false);
    expect(await claimBillingEvent(db as unknown as BillingClaimDb, 'u_1', 'refund:ch_1:2499', 'stripe_refund', new Date(NOW.getTime() + 86_400_000))).toBe(false);
    const rows = await db.rACreditLedger.findMany({});
    expect(rows).toHaveLength(1);
  });

  it('writes the ledger row the billing service has always written: bucket billing_event, amount 0, committed, key billing:<key>', async () => {
    const db = ledgerDb();
    await claimBillingEvent(db as unknown as BillingClaimDb, 'u_1', 'checkout:cs_1', 'stripe_checkout', NOW);
    const [row] = await db.rACreditLedger.findMany({});
    expect(row).toMatchObject({
      userId: 'u_1',
      bucket: 'billing_event',
      amount: 0,
      status: 'committed',
      fromSource: 'stripe',
      idempotencyKey: 'billing:checkout:cs_1',
      refType: 'stripe_checkout',
      refId: 'checkout:cs_1',
      settledAt: NOW,
    });
    expect(billingEventClaimKey('checkout:cs_1')).toBe('billing:checkout:cs_1');
  });

  it('a different key, or the same key under another prefix, is a different claim', async () => {
    const db = ledgerDb();
    const claim = (key: string) => claimBillingEvent(db as unknown as BillingClaimDb, 'u_1', key, 'stripe_refund', NOW);
    expect(await claim('refund:ch_1:1000')).toBe(true);
    expect(await claim('refund:ch_1:2499')).toBe(true); // a second, larger refund of the same charge
    expect(await claim('dispute:dp_1')).toBe(true);
    expect(await claim('refund:cn:order_1')).toBe(true);
    expect(await claim('refund:ch_1:1000')).toBe(false);
    expect(await db.rACreditLedger.findMany({})).toHaveLength(4);
  });

  it('the clock is optional: a caller without one still claims exactly once', async () => {
    const db = ledgerDb();
    expect(await claimBillingEvent(db as unknown as BillingClaimDb, 'u_1', 'payaction:in_1', 'stripe_invoice')).toBe(true);
    expect(await claimBillingEvent(db as unknown as BillingClaimDb, 'u_1', 'payaction:in_1', 'stripe_invoice')).toBe(false);
    const [row] = await db.rACreditLedger.findMany({});
    expect(row!.settledAt).toBeInstanceOf(Date);
  });
});

describe('invoiceSubscriptionId', () => {
  it('reads the subscription on old and current API shapes, as an id or an object', () => {
    expect(invoiceSubscriptionId({ subscription: 'sub_1' } as never)).toBe('sub_1');
    expect(invoiceSubscriptionId({ subscription: { id: 'sub_2' } } as never)).toBe('sub_2');
    expect(invoiceSubscriptionId({ parent: { subscription_details: { subscription: 'sub_3' } } } as never)).toBe('sub_3');
    expect(invoiceSubscriptionId({ parent: { subscription_details: { subscription: { id: 'sub_4' } } } } as never)).toBe('sub_4');
    expect(invoiceSubscriptionId({ parent: { subscription_details: null } } as never)).toBeNull();
    expect(invoiceSubscriptionId({} as never)).toBeNull();
  });
});

describe('findBillingOwnerByCustomer', () => {
  function world() {
    return createFakePrisma({
      seed: {
        user: [
          { id: 'u_1', email: 'u_1@example.test', name: 'U', brand: 'roboapply' },
          { id: 'u_2', email: 'u_2@example.test', name: 'V', brand: 'goapply' },
        ],
        seekerProfile: [
          { id: 'sp_1', userId: 'u_1', locale: 'ja' },
          { id: 'sp_2', userId: 'u_2', locale: 'zh' },
        ],
        seekerSubscription: [
          { id: 'row_1', seekerProfileId: 'sp_1', tier: 'pro', status: 'active', planKey: 'pro_monthly', interval: 'month', rail: 'stripe', brand: 'roboapply', currency: 'USD', amountMinor: 2499, stripeCustomerId: 'cus_ours', stripeSubscriptionId: 'sub_1', currentPeriodEnd: new Date('2026-11-10T08:00:00.000Z'), cancelAtPeriodEnd: false },
          { id: 'row_2', seekerProfileId: 'sp_2', tier: 'pro', status: 'active', planKey: 'pro_monthly', interval: 'pass', rail: 'alipay', brand: 'goapply', currency: 'CNY', amountMinor: 3900, stripeCustomerId: null, stripeSubscriptionId: null, currentPeriodEnd: null, cancelAtPeriodEnd: false },
          { id: 'row_3', seekerProfileId: 'sp_gone', tier: 'free', status: 'active', stripeCustomerId: 'cus_orphan' },
        ],
      },
    }) as unknown as BillingOwnerDb;
  }

  it('finds the account that holds the Stripe customer: the row plus userId, email and locale', async () => {
    const owner = await findBillingOwnerByCustomer(world(), 'cus_ours');
    expect(owner).toMatchObject({
      userId: 'u_1',
      email: 'u_1@example.test',
      locale: 'ja',
      seekerProfileId: 'sp_1',
      subscription: { id: 'row_1', planKey: 'pro_monthly', interval: 'month', rail: 'stripe', brand: 'roboapply', currency: 'USD', amountMinor: 2499, stripeCustomerId: 'cus_ours', stripeSubscriptionId: 'sub_1', cancelAtPeriodEnd: false },
    });
    expect(owner!.subscription.currentPeriodEnd?.toISOString()).toBe('2026-11-10T08:00:00.000Z');
    // Stripe sends the id or the expanded object.
    expect((await findBillingOwnerByCustomer(world(), { id: 'cus_ours' }))?.userId).toBe('u_1');
  });

  it('a customer nobody here holds is not ours (the Stripe account may be shared): null', async () => {
    const db = world();
    expect(await findBillingOwnerByCustomer(db, 'cus_of_another_product')).toBeNull();
    expect(await findBillingOwnerByCustomer(db, null)).toBeNull();
    expect(await findBillingOwnerByCustomer(db, undefined)).toBeNull();
    expect(await findBillingOwnerByCustomer(db, '')).toBeNull();
    expect(await findBillingOwnerByCustomer(db, { id: null })).toBeNull();
    // A row whose profile is gone has no user to act for.
    expect(await findBillingOwnerByCustomer(db, 'cus_orphan')).toBeNull();
  });

  it('never matches a row by a missing customer id (a GoApply row has none)', async () => {
    const db = world();
    // An absent id must not turn into "where stripeCustomerId is null".
    expect(await findBillingOwnerByCustomer(db, { id: undefined })).toBeNull();
  });
});

describe('the handler registry', () => {
  const TYPE = 'charge.refunded';
  afterEach(() => {
    unregisterStripeEventHandlerForTests(TYPE);
    unregisterStripeEventHandlerForTests('charge.dispute.created');
  });

  it('has no handler until one is registered', () => {
    expect(stripeEventHandler(TYPE)).toBeUndefined();
    expect(stripeEventHandler('customer.created')).toBeUndefined();
  });

  it('returns the registered handler for its type only, and forgets it when unregistered', async () => {
    const handler: StripeEventHandler = vi.fn(async () => ({ handled: true }));
    registerStripeEventHandler(TYPE, handler);
    expect(stripeEventHandler(TYPE)).toBe(handler);
    expect(stripeEventHandler('charge.dispute.created')).toBeUndefined();
    const ctx = { stripe: {} as never, db: {} as never, now: () => NOW };
    await expect(stripeEventHandler(TYPE)!({ id: 'evt_1', type: TYPE } as never, ctx)).resolves.toEqual({ handled: true });
    expect(handler).toHaveBeenCalledWith({ id: 'evt_1', type: TYPE }, ctx);
    unregisterStripeEventHandlerForTests(TYPE);
    expect(stripeEventHandler(TYPE)).toBeUndefined();
  });

  it('one handler per type: registering again replaces it', () => {
    const first: StripeEventHandler = async () => ({ handled: true });
    const second: StripeEventHandler = async () => ({ handled: true, duplicate: true });
    registerStripeEventHandler(TYPE, first);
    registerStripeEventHandler(TYPE, second);
    expect(stripeEventHandler(TYPE)).toBe(second);
  });
});

describe('error codes for the later phases', () => {
  it('nothing_to_resume, refund_not_available and withdrawal_not_available answer 409', () => {
    expect(BILLING_ERROR_STATUS.nothing_to_resume).toBe(409);
    expect(BILLING_ERROR_STATUS.refund_not_available).toBe(409);
    expect(BILLING_ERROR_STATUS.withdrawal_not_available).toBe(409);
    expect(new BillingError('refund_not_available', 'x')).toMatchObject({ code: 'refund_not_available', status: 409 });
    // Existing codes keep their status.
    expect(BILLING_ERROR_STATUS).toMatchObject({ plan_not_sellable: 409, rail_not_configured: 503, payment_provider_error: 502, auto_renew_ack_required: 422, cancel_token_invalid: 410 });
  });
});
