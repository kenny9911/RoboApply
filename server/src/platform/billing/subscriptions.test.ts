// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { getPlan } from './planCatalog.js';
import { resetStripeCatalogCacheForTests } from './stripeCatalog.js';
import {
  RENEWAL_CHANGE_RETRY_MS,
  cancelSubscription,
  confirmSwitch,
  describePlan,
  loadBillingAccount,
  quoteSwitch,
  renewalChangeIdempotencyKey,
  resumeSubscription,
  stripePeriod,
  switchIdempotencyKey,
  type BillingDb,
  type ResumeCharge,
  type StripeDeps,
} from './subscriptions.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const LATER = new Date('2026-10-30T08:00:00.000Z');
const LATER_S = Math.floor(LATER.getTime() / 1000);
/** When the seeded subscription row was last written (the row version in a cancel / resume key). */
const ROW_AT = new Date('2026-10-01T00:00:00.000Z');
const BUCKET = Math.floor(NOW.getTime() / RENEWAL_CHANGE_RETRY_MS);
type AnyRecord = Record<string, any>;
/** The Stripe rail is ready (ST-0); with nothing else set the catalog defaults sell. */
const READY = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test' };
const PRICES = {
  ...READY,
  STRIPE_PRICE_PRO_MONTHLY: 'price_m',
  STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499',
  STRIPE_PRICE_PRO_QUARTERLY: 'price_q',
  STRIPE_PRICE_PRO_QUARTERLY_CENTS: '5999',
};

/** A fake Stripe and a fake database. Nothing here can reach Stripe. `env` is what the code reads for the tax switch. */
function world(sub: Record<string, unknown> | null, opts: { env?: Record<string, string>; userBrand?: 'roboapply' | 'goapply' } = {}) {
  const db = createFakePrisma({
    seed: {
      user: [{ id: 'u_1', email: 'u@example.test', name: 'U', brand: opts.userBrand ?? 'roboapply' }],
      seekerProfile: [{ id: 'sp_1', userId: 'u_1', locale: 'en', market: 'us' }],
      seekerSubscription: sub ? [{ id: 'sub_row', seekerProfileId: 'sp_1', cancelAtPeriodEnd: false, updatedAt: ROW_AT, ...sub }] : [],
    },
  });
  const stripe = {
    subscriptions: {
      update: vi.fn(async (_id: string, _params: AnyRecord, _opts?: AnyRecord): Promise<AnyRecord> => ({})),
      retrieve: vi.fn(async (id: string): Promise<AnyRecord> => ({
        id,
        customer: 'cus_1',
        metadata: { product: 'roboapply' },
        items: { data: [{ id: 'si_1', current_period_end: LATER_S, current_period_start: Math.floor(NOW.getTime() / 1000) }] },
      })),
    },
    invoices: {
      createPreview: vi.fn(async (_params: AnyRecord): Promise<AnyRecord> => ({
        currency: 'usd',
        amount_due: 1234,
        lines: { data: [{ pricing: { price_details: { price: 'price_q' } }, period: { end: Math.floor(new Date('2027-01-10T08:00:00Z').getTime() / 1000) } }] },
      })),
      retrieve: vi.fn(async (id: string): Promise<AnyRecord> => ({ id, status: 'open', hosted_invoice_url: `https://invoice.stripe.test/${id}` })),
    },
  };
  // `env: {}` unless a test sets it, so the tax switch never follows the machine's environment.
  const deps: StripeDeps = { getStripe: () => stripe as never, db: db as unknown as BillingDb, now: () => NOW, env: opts.env ?? {} };
  return { db, stripe, deps };
}

const accountOf = async (w: ReturnType<typeof world>) => (await loadBillingAccount(w.deps.db, 'u_1'))!;
const row = async (w: ReturnType<typeof world>) => (await w.db.seekerSubscription.findUnique({ where: { id: 'sub_row' } })) as AnyRecord;

const liveMonthly = { tier: 'pro', status: 'active', planKey: 'pro_monthly', interval: 'month', rail: 'stripe', brand: 'roboapply', currency: 'USD', amountMinor: 2499, stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', currentPeriodEnd: LATER };
/** The same plan after "Cancel": still running, renewal off. */
const cancelledMonthly = { ...liveMonthly, cancelAtPeriodEnd: true };

describe('describePlan', () => {
  it('classifies free, subscriptions, passes, legacy plans and payment failures', async () => {
    const check = async (sub: Record<string, unknown> | null) => describePlan((await loadBillingAccount(world(sub).deps.db, 'u_1'))!, NOW);
    expect(await check(null)).toMatchObject({ state: 'free', live: false });
    expect(await check(liveMonthly)).toMatchObject({ state: 'subscription', live: true, autoRenews: true, planKey: 'pro_monthly' });
    expect(await check({ ...liveMonthly, cancelAtPeriodEnd: true })).toMatchObject({ autoRenews: false, cancelAtPeriodEnd: true });
    expect(await check({ ...liveMonthly, status: 'past_due' })).toMatchObject({ live: true, paymentFailed: true });
    expect(await check({ ...liveMonthly, status: 'unpaid' })).toMatchObject({ state: 'free', live: false });
    expect(await check({ ...liveMonthly, currentPeriodEnd: new Date('2026-10-01T00:00:00Z') })).toMatchObject({ state: 'free' });
    expect(await check({ tier: 'pro', status: 'active', planKey: 'pro_week_pass', interval: 'pass', currentPeriodEnd: LATER })).toMatchObject({ state: 'pass', autoRenews: false });
    expect(await check({ tier: 'starter', status: 'active', stripeSubscriptionId: 'sub_old', currentPeriodEnd: LATER })).toMatchObject({ state: 'legacy_subscription', planKey: 'starter' });
    expect(await check({ tier: 'growth', status: 'active', currency: 'CNY', currentPeriodEnd: LATER })).toMatchObject({ state: 'legacy_pass', autoRenews: false });
  });
});

describe('cancelSubscription (one click)', () => {
  it('turns auto-renewal off at Stripe and locally; passes the optional survey to Stripe', async () => {
    const w = world(liveMonthly);
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    const out = await cancelSubscription(account, { source: 'in_app', reason: 'too_expensive', note: 'Found a job' }, w.deps);
    expect(out).toMatchObject({ status: 'cancelled', changed: true, planKey: 'pro_monthly' });
    expect(out.accessUntil?.toISOString()).toBe(LATER.toISOString());
    expect(w.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(w.stripe.subscriptions.update.mock.calls[0]![0]).toBe('sub_1');
    // Nothing else changed in the request.
    expect(w.stripe.subscriptions.update.mock.calls[0]![1]).toEqual({
      cancel_at_period_end: true,
      cancellation_details: { feedback: 'too_expensive', comment: 'Found a job' },
      metadata: { cancelSource: 'in_app' },
    });
    // MARKET_STRATEGY §5.1: cancel:<subId>:<period end>, then the row version and a one-minute bucket.
    expect(w.stripe.subscriptions.update.mock.calls[0]![2]).toEqual({ idempotencyKey: `cancel:sub_1:${LATER_S}:v${ROW_AT.getTime()}:b${BUCKET}` });
    expect((await w.db.seekerSubscription.findUnique({ where: { id: 'sub_row' } }))?.cancelAtPeriodEnd).toBe(true);
  });

  it('two clicks at once send one idempotency key', async () => {
    const w = world(liveMonthly);
    // Both requests read the row before either wrote it.
    const [a, b] = [await accountOf(w), await accountOf(w)];
    await Promise.all([cancelSubscription(a, { source: 'in_app' }, w.deps), cancelSubscription(b, { source: 'in_app' }, w.deps)]);
    const keys = w.stripe.subscriptions.update.mock.calls.map((c) => c[2]?.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('a Stripe failure answers 502 and leaves renewal on; a retry a minute later is a new request', async () => {
    const w = world(liveMonthly);
    w.stripe.subscriptions.update.mockRejectedValueOnce(new Error('stripe is down'));
    await expect(cancelSubscription(await accountOf(w), { source: 'in_app' }, w.deps)).rejects.toMatchObject({ code: 'payment_provider_error', status: 502 });
    expect((await row(w)).cancelAtPeriodEnd).toBe(false);
    // Stripe replays a stored failure for a repeated key, so the retry must not repeat it.
    const later: StripeDeps = { ...w.deps, now: () => new Date(NOW.getTime() + RENEWAL_CHANGE_RETRY_MS) };
    await expect(cancelSubscription(await accountOf(w), { source: 'in_app' }, later)).resolves.toMatchObject({ status: 'cancelled' });
    const keys = w.stripe.subscriptions.update.mock.calls.map((c) => c[2]?.idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
    expect((await row(w)).cancelAtPeriodEnd).toBe(true);
  });

  it('an idempotency conflict is reported as one (same key, different reason)', async () => {
    const w = world(liveMonthly);
    w.stripe.subscriptions.update.mockRejectedValueOnce(Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), { type: 'StripeIdempotencyError' }));
    await expect(cancelSubscription(await accountOf(w), { source: 'in_app', reason: 'unused' }, w.deps)).rejects.toMatchObject({
      code: 'payment_provider_error',
      details: { provider: 'stripe', reason: 'idempotency_conflict' },
    });
  });

  it('a pass or an already-cancelled plan has nothing to stop', async () => {
    const pass = world({ tier: 'pro', status: 'active', planKey: 'pro_monthly', interval: 'pass', brand: 'goapply', currentPeriodEnd: LATER });
    const res = await cancelSubscription((await loadBillingAccount(pass.deps.db, 'u_1'))!, { source: 'in_app' }, pass.deps);
    expect(res).toMatchObject({ status: 'already_cancelled', changed: false });
    expect(pass.stripe.subscriptions.update).not.toHaveBeenCalled();
    const cancelled = world(cancelledMonthly);
    await expect(cancelSubscription(await accountOf(cancelled), { source: 'in_app' }, cancelled.deps)).resolves.toMatchObject({ status: 'already_cancelled', changed: false });
    expect(cancelled.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('no live plan → no_subscription', async () => {
    const w = world(null);
    await expect(cancelSubscription((await loadBillingAccount(w.deps.db, 'u_1'))!, { source: 'in_app' }, w.deps)).rejects.toMatchObject({ code: 'no_subscription' });
  });
});

describe('legacy switch: quote first, charge only on confirm', () => {
  const legacy = { tier: 'starter', status: 'active', planKey: null, stripeSubscriptionId: 'sub_old', stripeCustomerId: 'cus_1', currentPeriodEnd: LATER };

  it('the quote previews the proration and never updates the subscription', async () => {
    const w = world(legacy);
    const target = getPlan('roboapply', 'pro_quarterly', PRICES)!;
    const quote = await quoteSwitch((await loadBillingAccount(w.deps.db, 'u_1'))!, target, w.deps);
    expect(quote).toEqual({
      planKey: 'pro_quarterly',
      currency: 'USD',
      amountDueTodayMinor: 1234,
      newRenewalPriceMinor: 5999,
      nextRenewalDate: '2027-01-10T08:00:00.000Z',
      prorationDate: Math.floor(NOW.getTime() / 1000),
    });
    expect(w.stripe.invoices.createPreview).toHaveBeenCalledWith(expect.objectContaining({
      subscription: 'sub_old',
      subscription_details: expect.objectContaining({ items: [{ id: 'si_1', price: 'price_q' }], proration_behavior: 'always_invoice' }),
    }));
    expect(w.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('confirm charges with the quoted proration date; a stale quote is refused', async () => {
    const w = world(legacy);
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    const target = getPlan('roboapply', 'pro_quarterly', PRICES)!;
    const pd = Math.floor(NOW.getTime() / 1000) - 60;
    const record = vi.fn(async () => undefined);
    // A paid proration: the plan is switched and nothing is left to do.
    await expect(confirmSwitch(account, target, pd, w.deps, { autoRenewAck: true, record })).resolves.toEqual({
      planKey: 'pro_quarterly',
      stripeSubscriptionId: 'sub_old',
      requiresAction: false,
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(w.stripe.subscriptions.update.mock.invocationCallOrder[0]);
    expect(w.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    const [id, params, options] = w.stripe.subscriptions.update.mock.calls[0]!;
    expect(id).toBe('sub_old');
    // The whole request: the plan changes only if the proration is paid (ST-5).
    expect(params).toEqual({
      items: [{ id: 'si_1', price: 'price_q' }],
      proration_behavior: 'always_invoice',
      proration_date: pd,
      payment_behavior: 'pending_if_incomplete',
      cancel_at_period_end: false,
      // `cancelSource: ''` clears our cancel marker: the switch turns renewal back on.
      metadata: { product: 'roboapply', planKey: 'pro_quarterly', brand: 'roboapply', tier: 'pro', cancelSource: '' },
    });
    expect(options).toEqual({ idempotencyKey: `switch:sub_old:pro_quarterly:${pd}` });
    expect(w.stripe.invoices.retrieve).not.toHaveBeenCalled();
    await expect(confirmSwitch(account, target, pd - 7200, w.deps, { autoRenewAck: true, record })).rejects.toMatchObject({ code: 'quote_expired' });
  });

  it('confirming the same quote twice sends the same idempotency key; a new quote sends a new one', async () => {
    const w = world(legacy);
    const acct = await accountOf(w);
    const target = getPlan('roboapply', 'pro_quarterly', PRICES)!;
    const pd = Math.floor(NOW.getTime() / 1000) - 60;
    const ack = { autoRenewAck: true, record: vi.fn(async () => undefined) };
    await confirmSwitch(acct, target, pd, w.deps, ack);
    await confirmSwitch(acct, target, pd, w.deps, ack);
    await confirmSwitch(acct, target, pd + 30, w.deps, ack);
    const calls = w.stripe.subscriptions.update.mock.calls;
    expect(calls.map((c) => c[2]?.idempotencyKey)).toEqual([
      switchIdempotencyKey('sub_old', 'pro_quarterly', pd),
      switchIdempotencyKey('sub_old', 'pro_quarterly', pd),
      switchIdempotencyKey('sub_old', 'pro_quarterly', pd + 30),
    ]);
    // Same key, same parameters: Stripe treats the second request as the first.
    expect(calls[1]![1]).toEqual(calls[0]![1]);
  });

  it('a switch on a plan cancelled in the app turns renewal back on and clears the cancel marker', async () => {
    // Cancelled in the app, still running: Stripe holds our marker. MKT-2B
    // recognises a portal cancellation by its absence, so the switch (the
    // second way renewal comes back, after "Keep my plan") must clear it.
    const w = world(cancelledMonthly);
    w.stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
      id,
      customer: 'cus_1',
      cancel_at_period_end: true,
      metadata: { product: 'roboapply', planKey: 'pro_monthly', userId: 'u_1', cancelSource: 'in_app' },
      items: { data: [{ id: 'si_1', current_period_end: LATER_S, current_period_start: Math.floor(NOW.getTime() / 1000) }] },
    }));
    const pd = Math.floor(NOW.getTime() / 1000);
    await confirmSwitch(await accountOf(w), getPlan('roboapply', 'pro_quarterly', PRICES)!, pd, w.deps, { autoRenewAck: true, record: async () => undefined });
    const params = w.stripe.subscriptions.update.mock.calls[0]![1];
    expect(params.cancel_at_period_end).toBe(false);
    // Everything else Stripe held is kept; only the marker is emptied (Stripe removes a key set to '').
    expect(params.metadata).toEqual({ product: 'roboapply', planKey: 'pro_quarterly', userId: 'u_1', brand: 'roboapply', tier: 'pro', cancelSource: '' });
  });

  it('confirm without the auto-renewal acknowledgement is refused and charges nothing', async () => {
    const w = world(legacy);
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    const target = getPlan('roboapply', 'pro_quarterly', PRICES)!;
    const record = vi.fn(async () => undefined);
    const pd = Math.floor(NOW.getTime() / 1000) - 60;
    await expect(confirmSwitch(account, target, pd, w.deps, { autoRenewAck: false, record })).rejects.toMatchObject({ code: 'auto_renew_ack_required' });
    expect(record).not.toHaveBeenCalled();
    expect(w.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('refuses a plan while the rail is not ready, the pass, the packs and switching to the same plan', async () => {
    const w = world(liveMonthly);
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    // A key without a webhook secret: listed with its amount, not on sale.
    const notReady = getPlan('roboapply', 'pro_quarterly', { STRIPE_SECRET_KEY: 'sk_test_x' })!;
    expect(notReady).toMatchObject({ sellable: false, amountMinor: 5499 });
    await expect(quoteSwitch(account, notReady, w.deps)).rejects.toMatchObject({ code: 'plan_not_sellable' });
    // One-time products are bought, not switched to.
    await expect(quoteSwitch(account, getPlan('roboapply', 'pro_week_pass', PRICES)!, w.deps)).rejects.toMatchObject({ code: 'plan_not_sellable' });
    await expect(quoteSwitch(account, getPlan('roboapply', 'practice_pack_5', PRICES)!, w.deps)).rejects.toMatchObject({ code: 'plan_not_sellable' });
    await expect(quoteSwitch(account, getPlan('roboapply', 'pro_monthly', PRICES)!, w.deps)).rejects.toMatchObject({ code: 'switch_not_available' });
    expect(w.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});

// ST-1 consequence: a switch needs no price pin. The target's Stripe price is
// the one the catalog sync finds or creates under the plan's lookup key.
describe('switch without price pins (the catalog sync resolves the target price)', () => {
  beforeEach(() => resetStripeCatalogCacheForTests());

  /** A Stripe that holds the running subscription and a price list addressed by lookup key. */
  function syncedWorld(currency: 'usd' | 'twd', seedPrices: Array<Record<string, unknown>> = []) {
    const w = world(liveMonthly);
    const prices: Array<Record<string, any>> = [...seedPrices];
    let n = 0;
    const stripe = {
      ...w.stripe,
      subscriptions: {
        update: vi.fn(async (_id: string, _params: AnyRecord, _opts?: AnyRecord): Promise<AnyRecord> => ({})),
        retrieve: vi.fn(async (id: string): Promise<AnyRecord> => ({
          id,
          customer: 'cus_1',
          currency,
          metadata: { product: 'roboapply', planKey: 'pro_monthly' },
          items: { data: [{ id: 'si_1', current_period_end: Math.floor(LATER.getTime() / 1000), current_period_start: Math.floor(NOW.getTime() / 1000) }] },
        })),
      },
      invoices: { ...w.stripe.invoices, createPreview: vi.fn(async (_params: AnyRecord): Promise<AnyRecord> => ({ currency, amount_due: 3000, lines: { data: [] } })) },
      products: { create: vi.fn(async (p: { id: string }) => ({ id: p.id })) },
      prices: {
        list: vi.fn(async (p: { lookup_keys: string[] }) => ({ data: prices.filter((x) => p.lookup_keys.includes(x.lookup_key)) })),
        create: vi.fn(async (p: Record<string, any>) => {
          const price = { ...p, id: `price_synced_${++n}`, active: true, recurring: p.recurring ?? null };
          prices.push(price);
          return price;
        }),
      },
    };
    const deps: StripeDeps = { getStripe: () => stripe as never, db: w.db as unknown as BillingDb, now: () => NOW, env: {} };
    return { ...w, stripe, deps, prices };
  }

  it('a monthly subscriber is quoted and switched to quarterly on the synced quarterly price', async () => {
    const w = syncedWorld('usd');
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    const target = getPlan('roboapply', 'pro_quarterly', READY)!;
    expect(target).toMatchObject({ sellable: true, stripePriceId: null, amountMinor: 5499 });

    const quote = await quoteSwitch(account, target, w.deps);
    expect(quote).toMatchObject({ planKey: 'pro_quarterly', currency: 'USD', amountDueTodayMinor: 3000, newRenewalPriceMinor: 5499 });
    const synced = w.prices.find((p) => p.lookup_key === 'ra_pro_quarterly_usd_5499_incl')!;
    expect(synced).toMatchObject({ unit_amount: 5499, currency: 'usd', recurring: { interval: 'month', interval_count: 3 }, product: 'ra_pro' });
    expect(w.stripe.invoices.createPreview).toHaveBeenCalledWith(expect.objectContaining({ subscription_details: expect.objectContaining({ items: [{ id: 'si_1', price: synced.id }] }) }));
    expect(w.stripe.subscriptions.update).not.toHaveBeenCalled();

    const record = vi.fn(async () => undefined);
    await expect(confirmSwitch(account, target, quote.prorationDate, w.deps, { autoRenewAck: true, record })).resolves.toMatchObject({ planKey: 'pro_quarterly', requiresAction: false });
    // The acknowledgement names the catalog price; the charge uses the same synced price id.
    expect(record).toHaveBeenCalledWith({ amountMinor: 5499, currency: 'USD' });
    // The quote amount equals the charge: the same price, the same proration date.
    expect(w.stripe.invoices.createPreview.mock.calls[0]![0].subscription_details).toMatchObject({ items: [{ id: 'si_1', price: synced.id }], proration_date: quote.prorationDate });
    expect(w.stripe.subscriptions.update).toHaveBeenCalledWith(
      'sub_1',
      expect.objectContaining({ items: [{ id: 'si_1', price: synced.id }], proration_date: quote.prorationDate, payment_behavior: 'pending_if_incomplete' }),
      { idempotencyKey: `switch:sub_1:pro_quarterly:${quote.prorationDate}` },
    );
    // Quote and confirm together resolved the price once.
    expect(w.stripe.prices.create).toHaveBeenCalledTimes(1);
    expect(w.stripe.prices.list).toHaveBeenCalledTimes(1);
  });

  it('a price that already exists under the lookup key is used as it is', async () => {
    const w = syncedWorld('usd', [
      { id: 'price_from_another_instance', active: true, product: 'ra_pro', currency: 'usd', unit_amount: 999, lookup_key: 'ra_pro_weekly_usd_999_incl', recurring: { interval: 'week', interval_count: 1 } },
    ]);
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    await quoteSwitch(account, getPlan('roboapply', 'pro_weekly', READY)!, w.deps);
    expect(w.stripe.invoices.createPreview).toHaveBeenCalledWith(expect.objectContaining({ subscription_details: expect.objectContaining({ items: [{ id: 'si_1', price: 'price_from_another_instance' }] }) }));
    expect(w.stripe.prices.create).not.toHaveBeenCalled();
  });

  it('a TWD subscriber switches only to a plan with a TWD amount, on its synced TWD price', async () => {
    const w = syncedWorld('twd');
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    const env = { ...READY, PRICE_PRO_QUARTERLY_TWD_CENTS: '165000' };
    // No Taiwan amount for weekly: refused, and nothing is created on Stripe for it.
    await expect(quoteSwitch(account, getPlan('roboapply', 'pro_weekly', env)!, w.deps)).rejects.toMatchObject({ code: 'switch_not_available' });
    expect(w.stripe.prices.create).not.toHaveBeenCalled();

    const target = getPlan('roboapply', 'pro_quarterly', env)!;
    const quote = await quoteSwitch(account, target, w.deps);
    expect(quote).toMatchObject({ currency: 'TWD', newRenewalPriceMinor: 165000 });
    const synced = w.prices.find((p) => p.lookup_key === 'ra_pro_quarterly_twd_165000_incl')!;
    expect(synced).toMatchObject({ currency: 'twd', unit_amount: 165000 });
    // The USD price of the plan was never touched for a TWD subscription.
    expect(w.prices.some((p) => p.currency === 'usd')).toBe(false);
    const record = vi.fn(async () => undefined);
    await confirmSwitch(account, target, quote.prorationDate, w.deps, { autoRenewAck: true, record });
    expect(record).toHaveBeenCalledWith({ amountMinor: 165000, currency: 'TWD' });
    expect(w.stripe.subscriptions.update).toHaveBeenCalledWith(
      'sub_1',
      expect.objectContaining({ items: [{ id: 'si_1', price: synced.id }], payment_behavior: 'pending_if_incomplete' }),
      { idempotencyKey: `switch:sub_1:pro_quarterly:${quote.prorationDate}` },
    );
    // Confirming a plan with no Taiwan amount is refused too, before anything is recorded or sent.
    await expect(confirmSwitch(account, getPlan('roboapply', 'pro_weekly', env)!, quote.prorationDate, w.deps, { autoRenewAck: true, record })).rejects.toMatchObject({ code: 'switch_not_available' });
    expect(record).toHaveBeenCalledTimes(1);
    expect(w.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  it('a Stripe failure while resolving the price is a 502 and nothing is charged or recorded', async () => {
    const w = syncedWorld('usd');
    w.stripe.prices.list.mockRejectedValue(new Error('stripe is down'));
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    const target = getPlan('roboapply', 'pro_quarterly', READY)!;
    await expect(quoteSwitch(account, target, w.deps)).rejects.toMatchObject({ code: 'payment_provider_error', status: 502 });
    const record = vi.fn(async () => undefined);
    await expect(confirmSwitch(account, target, Math.floor(NOW.getTime() / 1000), w.deps, { autoRenewAck: true, record })).rejects.toMatchObject({ code: 'payment_provider_error' });
    expect(record).not.toHaveBeenCalled();
    expect(w.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  // M2 gate (contract row "Plan switch": "a Stripe failure is 502 payment_provider_error"):
  // the two reads of the subscription and the preview were thrown raw, which the route answered as 500 `switch_failed`.
  it('every Stripe read of a quote or a confirm that fails is a 502: the subscription read, the preview, the read before the update', async () => {
    const target = getPlan('roboapply', 'pro_quarterly', READY)!;
    const down = () => Object.assign(new Error('stripe is down'), { type: 'StripeAPIError' });

    const a = syncedWorld('usd');
    const accountA = (await loadBillingAccount(a.deps.db, 'u_1'))!;
    a.stripe.subscriptions.retrieve.mockRejectedValueOnce(down());
    await expect(quoteSwitch(accountA, target, a.deps)).rejects.toMatchObject({ code: 'payment_provider_error', status: 502 });

    const b = syncedWorld('usd');
    const accountB = (await loadBillingAccount(b.deps.db, 'u_1'))!;
    b.stripe.invoices.createPreview.mockRejectedValueOnce(down());
    await expect(quoteSwitch(accountB, target, b.deps)).rejects.toMatchObject({ code: 'payment_provider_error', status: 502 });

    const c = syncedWorld('usd');
    const accountC = (await loadBillingAccount(c.deps.db, 'u_1'))!;
    c.stripe.subscriptions.retrieve.mockRejectedValueOnce(down());
    const record = vi.fn(async () => undefined);
    await expect(confirmSwitch(accountC, target, Math.floor(NOW.getTime() / 1000), c.deps, { autoRenewAck: true, record })).rejects.toMatchObject({ code: 'payment_provider_error', status: 502 });
    expect(record).not.toHaveBeenCalled();
    expect(c.stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

// ST-5 (MARKET_STRATEGY §5.1 "Switch", PAY S10): the plan changes only if the
// proration is paid.
describe('switch: a proration that is not paid leaves the plan unchanged', () => {
  const pd = Math.floor(NOW.getTime() / 1000) - 60;
  const ack = () => ({ autoRenewAck: true, record: vi.fn(async () => undefined) });
  /** What Stripe answers when the card is declined or the bank wants the buyer: the change waits in `pending_update`. */
  const pending = (latestInvoice: unknown) => ({
    id: 'sub_1',
    status: 'active',
    items: { data: [{ id: 'si_1', price: { id: 'price_m' } }] },
    pending_update: { expires_at: pd + 82_800, subscription_items: [{ id: 'si_1', price: { id: 'price_q' } }] },
    latest_invoice: latestInvoice,
  });

  it('a declined proration answers requiresAction with the hosted invoice page, and our plan row is untouched', async () => {
    const w = world(liveMonthly);
    w.stripe.subscriptions.update.mockResolvedValueOnce(pending('in_open'));
    const before = await row(w);
    const res = await confirmSwitch(await accountOf(w), getPlan('roboapply', 'pro_quarterly', PRICES)!, pd, w.deps, ack());
    expect(res).toEqual({ planKey: 'pro_quarterly', stripeSubscriptionId: 'sub_1', requiresAction: true, hostedInvoiceUrl: 'https://invoice.stripe.test/in_open' });
    expect(w.stripe.subscriptions.update.mock.calls[0]![1]).toMatchObject({ payment_behavior: 'pending_if_incomplete' });
    expect(w.stripe.invoices.retrieve).toHaveBeenCalledWith('in_open');
    // Nothing of the plan changed on our side.
    expect(await row(w)).toEqual(before);
    expect(describePlan(await accountOf(w), NOW)).toMatchObject({ planKey: 'pro_monthly', live: true, autoRenews: true });
  });

  it('reads the invoice id from an expanded latest_invoice too', async () => {
    const w = world(liveMonthly);
    w.stripe.subscriptions.update.mockResolvedValueOnce(pending({ id: 'in_expanded' }));
    const res = await confirmSwitch(await accountOf(w), getPlan('roboapply', 'pro_quarterly', PRICES)!, pd, w.deps, ack());
    expect(res).toMatchObject({ requiresAction: true, hostedInvoiceUrl: 'https://invoice.stripe.test/in_expanded' });
  });

  it('still answers requiresAction, with no link, when the invoice cannot be read or has no hosted page', async () => {
    const target = getPlan('roboapply', 'pro_quarterly', PRICES)!;
    const unreadable = world(liveMonthly);
    unreadable.stripe.subscriptions.update.mockResolvedValueOnce(pending('in_open'));
    unreadable.stripe.invoices.retrieve.mockRejectedValueOnce(new Error('stripe is down'));
    await expect(confirmSwitch(await accountOf(unreadable), target, pd, unreadable.deps, ack())).resolves.toEqual({
      planKey: 'pro_quarterly',
      stripeSubscriptionId: 'sub_1',
      requiresAction: true,
      hostedInvoiceUrl: null,
    });
    const noPage = world(liveMonthly);
    noPage.stripe.subscriptions.update.mockResolvedValueOnce(pending('in_open'));
    noPage.stripe.invoices.retrieve.mockResolvedValueOnce({ id: 'in_open', status: 'open', hosted_invoice_url: null });
    await expect(confirmSwitch(await accountOf(noPage), target, pd, noPage.deps, ack())).resolves.toMatchObject({ requiresAction: true, hostedInvoiceUrl: null });
    const noInvoice = world(liveMonthly);
    noInvoice.stripe.subscriptions.update.mockResolvedValueOnce(pending(null));
    await expect(confirmSwitch(await accountOf(noInvoice), target, pd, noInvoice.deps, ack())).resolves.toMatchObject({ requiresAction: true, hostedInvoiceUrl: null });
    expect(noInvoice.stripe.invoices.retrieve).not.toHaveBeenCalled();
  });

  it('a repeated confirm after the buyer paid, before the webhook wrote the plan, reports the switch as done', async () => {
    // Stripe answers a repeated idempotency key with its stored first answer,
    // which still shows the pending update. The invoice says what is true now.
    // (Our row still holds the old plan here: the webhook has not landed.)
    const w = world(liveMonthly);
    w.stripe.subscriptions.update.mockResolvedValue(pending('in_open'));
    const acct = await accountOf(w);
    const target = getPlan('roboapply', 'pro_quarterly', PRICES)!;
    await expect(confirmSwitch(acct, target, pd, w.deps, ack())).resolves.toMatchObject({ requiresAction: true });
    w.stripe.invoices.retrieve.mockResolvedValueOnce({ id: 'in_open', status: 'paid', hosted_invoice_url: 'https://invoice.stripe.test/in_open' });
    await expect(confirmSwitch(acct, target, pd, w.deps, ack())).resolves.toEqual({ planKey: 'pro_quarterly', stripeSubscriptionId: 'sub_1', requiresAction: false });
    expect(w.stripe.subscriptions.update.mock.calls.map((c) => c[2])).toEqual([
      { idempotencyKey: `switch:sub_1:pro_quarterly:${pd}` },
      { idempotencyKey: `switch:sub_1:pro_quarterly:${pd}` },
    ]);
  });

  it('once the webhook has written the new plan, confirming the same quote again is refused before Stripe is asked', async () => {
    // The usual order after the buyer pays the hosted invoice: Stripe applies
    // the pending update, the webhook writes planKey to our row, and only then
    // does the buyer come back. A page reads the plan again; it does not
    // confirm again.
    const w = world(liveMonthly);
    w.stripe.subscriptions.update.mockResolvedValue(pending('in_open'));
    const target = getPlan('roboapply', 'pro_quarterly', PRICES)!;
    await expect(confirmSwitch(await accountOf(w), target, pd, w.deps, ack())).resolves.toMatchObject({ requiresAction: true });
    await w.db.seekerSubscription.update({ where: { id: 'sub_row' }, data: { planKey: 'pro_quarterly', interval: 'quarter', amountMinor: 5999 } });
    const again = ack();
    await expect(confirmSwitch(await accountOf(w), target, pd, w.deps, again)).rejects.toMatchObject({ code: 'switch_not_available', status: 409 });
    expect(again.record).not.toHaveBeenCalled();
    expect(w.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(describePlan(await accountOf(w), NOW)).toMatchObject({ planKey: 'pro_quarterly', live: true });
  });

  it('a Stripe failure on the update is a 502; the acknowledgement was recorded before the charge was asked for', async () => {
    const w = world(liveMonthly);
    w.stripe.subscriptions.update.mockRejectedValueOnce(new Error('stripe is down'));
    const a = ack();
    await expect(confirmSwitch(await accountOf(w), getPlan('roboapply', 'pro_quarterly', PRICES)!, pd, w.deps, a)).rejects.toMatchObject({
      code: 'payment_provider_error',
      status: 502,
      details: { provider: 'stripe' },
    });
    expect(a.record).toHaveBeenCalledTimes(1);
  });
});

// ST-6 (MARKET_STRATEGY §5.1 "Cancel and resume", §4.4 "Cancel"): "Keep my plan".
describe('resumeSubscription ("Keep my plan")', () => {
  const ackWith = (autoRenewAck = true) => ({ autoRenewAck, record: vi.fn(async (_charged: ResumeCharge) => undefined) });

  it('turns renewal back on at Stripe and locally, after recording the acknowledgement for the price that is charged', async () => {
    const w = world(cancelledMonthly);
    const a = ackWith();
    const out = await resumeSubscription(await accountOf(w), w.deps, a);
    expect(out).toEqual({ status: 'resumed', planKey: 'pro_monthly', renewsAt: LATER });
    // The plan, the period and the price the row says is charged.
    expect(a.record).toHaveBeenCalledTimes(1);
    expect(a.record).toHaveBeenCalledWith({ planKey: 'pro_monthly', interval: 'month', amountMinor: 2499, currency: 'USD' });
    expect(a.record.mock.invocationCallOrder[0]).toBeLessThan(w.stripe.subscriptions.update.mock.invocationCallOrder[0]!);
    expect(w.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    // The empty string clears our cancel marker.
    expect(w.stripe.subscriptions.update).toHaveBeenCalledWith(
      'sub_1',
      { cancel_at_period_end: false, metadata: { cancelSource: '' } },
      { idempotencyKey: `resume:sub_1:${LATER_S}:v${ROW_AT.getTime()}:b${BUCKET}` },
    );
    // The row's own amount was enough: Stripe was not asked for the price.
    expect(w.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect((await row(w)).cancelAtPeriodEnd).toBe(false);
    expect(describePlan(await accountOf(w), NOW)).toMatchObject({ live: true, autoRenews: true, cancelAtPeriodEnd: false });
  });

  it('a Taiwan subscription is acknowledged at its TWD price', async () => {
    const w = world({ ...cancelledMonthly, currency: 'twd', amountMinor: 74900 });
    const a = ackWith();
    await resumeSubscription(await accountOf(w), w.deps, a);
    expect(a.record).toHaveBeenCalledWith({ planKey: 'pro_monthly', interval: 'month', amountMinor: 74900, currency: 'TWD' });
  });

  it('a quarterly plan is acknowledged as renewing every quarter', async () => {
    const w = world({ ...cancelledMonthly, planKey: 'pro_quarterly', interval: 'quarter', amountMinor: 5499 });
    const a = ackWith();
    await expect(resumeSubscription(await accountOf(w), w.deps, a)).resolves.toMatchObject({ planKey: 'pro_quarterly' });
    expect(a.record).toHaveBeenCalledWith({ planKey: 'pro_quarterly', interval: 'quarter', amountMinor: 5499, currency: 'USD' });
  });

  it('a plan whose payment is being retried can still be kept', async () => {
    const w = world({ ...cancelledMonthly, status: 'past_due' });
    await expect(resumeSubscription(await accountOf(w), w.deps, ackWith())).resolves.toMatchObject({ status: 'resumed' });
  });

  it.each([
    ['no plan at all', null],
    ['a plan that still renews', liveMonthly],
    ['a plan whose period ended', { ...cancelledMonthly, currentPeriodEnd: new Date('2026-10-01T00:00:00Z') }],
    ['a subscription Stripe already ended', { ...cancelledMonthly, status: 'canceled' }],
    ['the 7-day pass', { tier: 'pro', status: 'active', planKey: 'pro_week_pass', interval: 'pass', brand: 'roboapply', currentPeriodEnd: LATER, cancelAtPeriodEnd: true }],
    ['a pass key on a row that carries a Stripe subscription id', { ...cancelledMonthly, planKey: 'pro_week_pass', interval: 'pass' }],
    ['a cancelled row without a Stripe subscription', { ...cancelledMonthly, stripeSubscriptionId: null }],
    ['a legacy subscription (no terms to acknowledge)', { tier: 'starter', status: 'active', planKey: null, stripeSubscriptionId: 'sub_old', stripeCustomerId: 'cus_1', currentPeriodEnd: LATER, cancelAtPeriodEnd: true }],
    ['a free row', { tier: 'free', status: 'active', planKey: 'free', cancelAtPeriodEnd: true }],
  ] as Array<[string, Record<string, unknown> | null]>)('nothing to resume: %s', async (_name, sub) => {
    const w = world(sub);
    const a = ackWith();
    await expect(resumeSubscription(await accountOf(w), w.deps, a)).rejects.toMatchObject({ code: 'nothing_to_resume', status: 409 });
    expect(a.record).not.toHaveBeenCalled();
    expect(w.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(w.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('a GoApply account gets nothing_to_resume and never reaches Stripe (rule A11)', async () => {
    const getStripe = vi.fn(() => null);
    // A GoApply pass, as the mainland rails sell it.
    const pass = world({ tier: 'pro', status: 'active', planKey: 'pro_monthly', interval: 'pass', brand: 'goapply', rail: 'alipay', currency: 'CNY', amountMinor: 3900, currentPeriodEnd: LATER, cancelAtPeriodEnd: true }, { userBrand: 'goapply' });
    await expect(resumeSubscription(await accountOf(pass), { ...pass.deps, getStripe }, ackWith())).rejects.toMatchObject({ code: 'nothing_to_resume' });
    // Even a row that looks like a cancelled Stripe subscription is not resumed for a GoApply account…
    const odd = world({ ...cancelledMonthly, brand: 'goapply' }, { userBrand: 'goapply' });
    const a = ackWith();
    await expect(resumeSubscription(await accountOf(odd), { ...odd.deps, getStripe }, a)).rejects.toMatchObject({ code: 'nothing_to_resume' });
    // …nor a GoApply-branded row on any account.
    const branded = world({ ...cancelledMonthly, brand: 'goapply' });
    await expect(resumeSubscription(await accountOf(branded), { ...branded.deps, getStripe }, a)).rejects.toMatchObject({ code: 'nothing_to_resume' });
    expect(getStripe).not.toHaveBeenCalled();
    expect(a.record).not.toHaveBeenCalled();
    for (const w of [pass, odd, branded]) expect(w.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('without the ticked box nothing is recorded and Stripe is not asked', async () => {
    const w = world(cancelledMonthly);
    const a = ackWith(false);
    await expect(resumeSubscription(await accountOf(w), w.deps, a)).rejects.toMatchObject({ code: 'auto_renew_ack_required', status: 422 });
    expect(a.record).not.toHaveBeenCalled();
    expect(w.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect((await row(w)).cancelAtPeriodEnd).toBe(true);
  });

  it('with card payments not set up it answers rail_not_configured and records nothing', async () => {
    const w = world(cancelledMonthly);
    const a = ackWith();
    await expect(resumeSubscription(await accountOf(w), { ...w.deps, getStripe: () => null }, a)).rejects.toMatchObject({ code: 'rail_not_configured', status: 503 });
    expect(a.record).not.toHaveBeenCalled();
    expect((await row(w)).cancelAtPeriodEnd).toBe(true);
  });

  it('a failed Stripe call leaves the row cancelled and answers 502', async () => {
    const w = world(cancelledMonthly);
    w.stripe.subscriptions.update.mockRejectedValueOnce(new Error('stripe is down'));
    const a = ackWith();
    await expect(resumeSubscription(await accountOf(w), w.deps, a)).rejects.toMatchObject({ code: 'payment_provider_error', status: 502 });
    // The acknowledgement was given and is kept; the plan is still cancelled.
    expect(a.record).toHaveBeenCalledTimes(1);
    expect((await row(w)).cancelAtPeriodEnd).toBe(true);
    expect(describePlan(await accountOf(w), NOW)).toMatchObject({ live: true, autoRenews: false, cancelAtPeriodEnd: true });
  });

  it('resuming twice sends one idempotency key: the second call has nothing to resume', async () => {
    const w = world(cancelledMonthly);
    await resumeSubscription(await accountOf(w), w.deps, ackWith());
    const second = ackWith();
    await expect(resumeSubscription(await accountOf(w), w.deps, second)).rejects.toMatchObject({ code: 'nothing_to_resume' });
    expect(second.record).not.toHaveBeenCalled();
    expect(w.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(w.stripe.subscriptions.update.mock.calls[0]![2]).toEqual({ idempotencyKey: `resume:sub_1:${LATER_S}:v${ROW_AT.getTime()}:b${BUCKET}` });
  });

  it('two clicks at once send one idempotency key', async () => {
    const w = world(cancelledMonthly);
    const [a, b] = [await accountOf(w), await accountOf(w)];
    await Promise.all([resumeSubscription(a, w.deps, ackWith()), resumeSubscription(b, w.deps, ackWith())]);
    const keys = w.stripe.subscriptions.update.mock.calls.map((c) => c[2]?.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  describe('a row that does not know its price', () => {
    it('asks Stripe what the plan renews at, and acknowledges that price', async () => {
      const w = world({ ...cancelledMonthly, amountMinor: null, currency: null });
      w.stripe.subscriptions.retrieve.mockResolvedValueOnce({ id: 'sub_1', items: { data: [{ id: 'si_1', price: { id: 'price_old', unit_amount: 1999, currency: 'usd' } }] } });
      const a = ackWith();
      await expect(resumeSubscription(await accountOf(w), w.deps, a)).resolves.toMatchObject({ status: 'resumed' });
      // An older subscriber's price, not today's catalog amount (2499).
      expect(a.record).toHaveBeenCalledWith({ planKey: 'pro_monthly', interval: 'month', amountMinor: 1999, currency: 'USD' });
      expect(w.stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
    });

    it('refuses with 502, recording nothing, when Stripe does not say either', async () => {
      const unknown = world({ ...cancelledMonthly, amountMinor: null });
      // The default fake subscription carries no price on its item.
      const a = ackWith();
      await expect(resumeSubscription(await accountOf(unknown), unknown.deps, a)).rejects.toMatchObject({ code: 'payment_provider_error', details: { reason: 'renewal_price_unknown' } });
      const down = world({ ...cancelledMonthly, currency: null });
      down.stripe.subscriptions.retrieve.mockRejectedValueOnce(new Error('stripe is down'));
      await expect(resumeSubscription(await accountOf(down), down.deps, a)).rejects.toMatchObject({ code: 'payment_provider_error', status: 502 });
      expect(a.record).not.toHaveBeenCalled();
      for (const w of [unknown, down]) {
        expect(w.stripe.subscriptions.update).not.toHaveBeenCalled();
        expect((await row(w)).cancelAtPeriodEnd).toBe(true);
      }
    });
  });
});

// MARKET_STRATEGY §5.1 "Idempotency keys": cancel|resume:<subId>:<periodEnd>,
// plus what keeps a repeated key from standing for a different request.
describe('the idempotency key of a cancel and a resume', () => {
  const sub = { stripeSubscriptionId: 'sub_1', currentPeriodEnd: LATER, updatedAt: ROW_AT };

  it('starts with the verb, the subscription and the period end, then the row version and the minute', () => {
    expect(renewalChangeIdempotencyKey('cancel', sub, NOW)).toBe(`cancel:sub_1:${LATER_S}:v${ROW_AT.getTime()}:b${BUCKET}`);
    expect(renewalChangeIdempotencyKey('resume', sub, NOW)).toBe(`resume:sub_1:${LATER_S}:v${ROW_AT.getTime()}:b${BUCKET}`);
    // Later in the same minute: the same key (a double click).
    expect(renewalChangeIdempotencyKey('cancel', sub, new Date(NOW.getTime() + RENEWAL_CHANGE_RETRY_MS - 1))).toBe(renewalChangeIdempotencyKey('cancel', sub, NOW));
    // The next minute, the next period, or a row written since: a new key.
    expect(renewalChangeIdempotencyKey('cancel', sub, new Date(NOW.getTime() + RENEWAL_CHANGE_RETRY_MS))).not.toBe(renewalChangeIdempotencyKey('cancel', sub, NOW));
    expect(renewalChangeIdempotencyKey('cancel', { ...sub, currentPeriodEnd: new Date(LATER.getTime() + 86_400_000) }, NOW)).not.toBe(renewalChangeIdempotencyKey('cancel', sub, NOW));
    expect(renewalChangeIdempotencyKey('cancel', { ...sub, updatedAt: new Date(ROW_AT.getTime() + 1) }, NOW)).not.toBe(renewalChangeIdempotencyKey('cancel', sub, NOW));
    // A row built by hand (no version, no period end) still gets a well-formed key.
    expect(renewalChangeIdempotencyKey('cancel', { stripeSubscriptionId: 'sub_1', currentPeriodEnd: null }, NOW)).toBe(`cancel:sub_1:0:v0:b${BUCKET}`);
  });

  it('cancel, keep, cancel again in one period and one minute: the second cancel is a new request to Stripe', async () => {
    // With cancel:<subId>:<periodEnd> alone Stripe would answer the second
    // cancel with the stored answer of the first and change nothing: we would
    // say "cancelled" while the plan still renews.
    const w = world(liveMonthly);
    await cancelSubscription(await accountOf(w), { source: 'in_app' }, w.deps);
    await resumeSubscription(await accountOf(w), w.deps, { autoRenewAck: true, record: async () => undefined });
    await cancelSubscription(await accountOf(w), { source: 'in_app' }, w.deps);
    const calls = w.stripe.subscriptions.update.mock.calls;
    expect(calls.map((c) => c[1].cancel_at_period_end)).toEqual([true, false, true]);
    const keys = calls.map((c) => c[2]?.idempotencyKey as string);
    expect(keys[0]).toMatch(/^cancel:sub_1:/);
    expect(keys[1]).toMatch(/^resume:sub_1:/);
    expect(keys[2]).toMatch(/^cancel:sub_1:/);
    // Same parameters as the first cancel, and a different key.
    expect(calls[2]![1]).toEqual(calls[0]![1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect((await row(w)).cancelAtPeriodEnd).toBe(true);
  });
});

// ST-8 (MARKET_STRATEGY §5.1 "Tax"): STRIPE_TAX_ENABLED, off by default.
describe('switch and the tax switch', () => {
  const legacy = { tier: 'starter', status: 'active', planKey: null, stripeSubscriptionId: 'sub_old', stripeCustomerId: 'cus_1', currentPeriodEnd: LATER };
  const target = () => getPlan('roboapply', 'pro_quarterly', PRICES)!;

  it.each([[{}], [{ STRIPE_TAX_ENABLED: 'false' }], [{ STRIPE_TAX_ENABLED: '' }], [{ STRIPE_TAX_ENABLED: '0' }]] as Array<[Record<string, string>]>)(
    'off (%j): the quote preview carries no tax field',
    async (env) => {
      const w = world(legacy, { env });
      await quoteSwitch(await accountOf(w), target(), w.deps);
      // Exactly the request the quote sent before the switch existed.
      expect(w.stripe.invoices.createPreview.mock.calls[0]![0]).toEqual({
        customer: 'cus_1',
        subscription: 'sub_old',
        subscription_details: { items: [{ id: 'si_1', price: 'price_q' }], proration_behavior: 'always_invoice', proration_date: Math.floor(NOW.getTime() / 1000) },
      });
    },
  );

  /** The quote's whole request without any tax field. */
  const plainPreview = {
    customer: 'cus_1',
    subscription: 'sub_old',
    subscription_details: { items: [{ id: 'si_1', price: 'price_q' }], proration_behavior: 'always_invoice', proration_date: Math.floor(NOW.getTime() / 1000) },
  };
  /** The running subscription as Stripe returns it, with the given automatic-tax setting (absent = an old subscription). */
  const subscriptionWith = (w: ReturnType<typeof world>, automaticTax?: AnyRecord) =>
    w.stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
      id,
      customer: 'cus_1',
      metadata: { product: 'roboapply' },
      ...(automaticTax ? { automatic_tax: automaticTax } : {}),
      items: { data: [{ id: 'si_1', current_period_end: LATER_S, current_period_start: Math.floor(NOW.getTime() / 1000) }] },
    }));
  /** Created by a tax-enabled Checkout: the charge of a switch is computed with automatic tax. */
  const taxed = (w: ReturnType<typeof world>) => subscriptionWith(w, { enabled: true, liability: { type: 'self' } });

  it.each([['true'], ['1'], ['TRUE']])('on (%s), and the subscription carries automatic tax: the quote asks for automatic tax', async (value) => {
    const w = world(legacy, { env: { STRIPE_TAX_ENABLED: value } });
    taxed(w);
    await quoteSwitch(await accountOf(w), target(), w.deps);
    expect(w.stripe.invoices.createPreview.mock.calls[0]![0]).toEqual({ ...plainPreview, automatic_tax: { enabled: true } });
  });

  it.each([
    ['has no automatic_tax field (subscribed before the switch was turned on)', undefined],
    ['has automatic tax off', { enabled: false, liability: null }],
  ] as Array<[string, AnyRecord | undefined]>)('on, and the subscription %s: the quote is computed as the charge will be, without automatic tax', async (_name, automaticTax) => {
    const w = world(legacy, { env: { STRIPE_TAX_ENABLED: 'true' } });
    subscriptionWith(w, automaticTax);
    await expect(quoteSwitch(await accountOf(w), target(), w.deps)).resolves.toMatchObject({ planKey: 'pro_quarterly', amountDueTodayMinor: 1234 });
    // One request, and exactly the one the quote sends with the switch off.
    expect(w.stripe.invoices.createPreview).toHaveBeenCalledTimes(1);
    expect(w.stripe.invoices.createPreview.mock.calls[0]![0]).toEqual(plainPreview);
  });

  it('off: a subscription that carries automatic tax is quoted with no tax field from us (Stripe applies the subscription\'s own setting)', async () => {
    const w = world(legacy);
    taxed(w);
    await quoteSwitch(await accountOf(w), target(), w.deps);
    expect(w.stripe.invoices.createPreview.mock.calls[0]![0]).toEqual(plainPreview);
  });

  it('on, and Stripe Tax cannot place the customer: the quote is made without the tax lines (prices are tax-inclusive)', async () => {
    const w = world(legacy, { env: { STRIPE_TAX_ENABLED: 'true' } });
    taxed(w);
    w.stripe.invoices.createPreview.mockRejectedValueOnce(Object.assign(new Error('The customer has no valid tax location'), { code: 'customer_tax_location_invalid' }));
    await expect(quoteSwitch(await accountOf(w), target(), w.deps)).resolves.toMatchObject({ planKey: 'pro_quarterly', amountDueTodayMinor: 1234 });
    const calls = w.stripe.invoices.createPreview.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ automatic_tax: { enabled: true } });
    expect(calls[1]).not.toHaveProperty('automatic_tax');
    expect(calls[1]!.subscription_details).toEqual(calls[0]!.subscription_details);
  });

  it('any other Stripe failure of the quote is not retried, with the switch on or off', async () => {
    for (const env of [{ STRIPE_TAX_ENABLED: 'true' }, {}] as Array<Record<string, string>>) {
      const w = world(legacy, { env });
      taxed(w);
      w.stripe.invoices.createPreview.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'customer_tax_location_invalid_not' }));
      // Not retried, and answered as the provider's failure (502), never as a raw error (M2 gate).
      await expect(quoteSwitch(await accountOf(w), target(), w.deps)).rejects.toMatchObject({ code: 'payment_provider_error', status: 502 });
      expect(w.stripe.invoices.createPreview).toHaveBeenCalledTimes(1);
    }
    // Off: even the location error is not retried (no tax was asked for).
    const off = world(legacy);
    taxed(off);
    off.stripe.invoices.createPreview.mockRejectedValueOnce(Object.assign(new Error('location'), { code: 'customer_tax_location_invalid' }));
    await expect(quoteSwitch(await accountOf(off), target(), off.deps)).rejects.toMatchObject({ code: 'payment_provider_error', status: 502 });
    expect(off.stripe.invoices.createPreview).toHaveBeenCalledTimes(1);
  });

  it('on: the update still sends no automatic_tax (pending updates do not take it)', async () => {
    const w = world(legacy, { env: { STRIPE_TAX_ENABLED: 'true' } });
    taxed(w);
    await confirmSwitch(await accountOf(w), target(), Math.floor(NOW.getTime() / 1000), w.deps, { autoRenewAck: true, record: async () => undefined });
    const params = w.stripe.subscriptions.update.mock.calls[0]![1];
    expect(params).not.toHaveProperty('automatic_tax');
    expect(Object.keys(params).sort()).toEqual(['cancel_at_period_end', 'items', 'metadata', 'payment_behavior', 'proration_behavior', 'proration_date']);
  });
});

describe('stripePeriod', () => {
  it('reads item-level periods (current API) and falls back to top-level ones', () => {
    const start = 1_760_000_000;
    expect(stripePeriod({ items: { data: [{ current_period_start: start, current_period_end: start + 10 }] } } as never)).toEqual({
      start: new Date(start * 1000),
      end: new Date((start + 10) * 1000),
    });
    expect(stripePeriod({ current_period_start: start, current_period_end: start + 5, items: { data: [] } } as never).end).toEqual(new Date((start + 5) * 1000));
  });
});
