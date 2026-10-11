// @vitest-environment node
//
// What happens to practice credits when a Stripe subscription ends (market
// wave M2 carry-over, entry MKT-4B.7; handoff MKT-2D, Known gaps 4):
//
//   - a subscription that ends BEFORE its paid period runs out (a statutory
//     withdrawal cancels at once and refunds the unused days; so does a
//     cancellation made at once in the Dashboard) takes the period's practice
//     allowance with it: the balance goes back to the Free allotment, unspent
//     packs stay, once per subscription;
//   - a subscription that runs to the end of its paid period (the ordinary
//     cancellation) keeps the behaviour it had: its balance is not touched.
//
// `customer.subscription.deleted` is delivered through the service's own
// `handleRoboApplyStripeEvent`, on the in-memory Prisma with the REAL
// practice-credit service on that same database. Nothing reaches Stripe.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../test/fakePrisma.js');
  fake.db = createFakePrisma({ uniqueFields: { rACreditLedger: ['idempotencyKey'] } });
  return { default: fake.db };
});
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getMockPlanCatalog } from '../../lib/mockInterviewPlans.js';
import { handleRoboApplyStripeEvent, setBillingServiceDepsForTests } from './RoboApplyBillingService.js';

type Obj = Record<string, any>;

const DAY_S = 86_400;
const NOW = new Date('2026-10-10T08:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
/** The paid period: it began 5 days ago and has 25 days left. */
const PERIOD_START_S = NOW_S - 5 * DAY_S;
const PERIOD_END_S = NOW_S + 25 * DAY_S;

const META = { product: 'roboapply', brand: 'roboapply', planKey: 'pro_monthly', userId: 'u_1', seekerProfileId: 'sp_1' };
const PRICE = { id: 'price_m', currency: 'usd', unit_amount: 2499, lookup_key: 'ra_pro_monthly_usd_2499_incl', metadata: { product: 'roboapply', planKey: 'pro_monthly' } };

function sub(over: Obj = {}): Obj {
  return {
    id: 'sub_1',
    object: 'subscription',
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    start_date: PERIOD_START_S,
    metadata: { ...META },
    items: { data: [{ id: 'si_1', price: PRICE, current_period_start: PERIOD_START_S, current_period_end: PERIOD_END_S }] },
    ...over,
  };
}

/** The subscription as Stripe holds it after it ended at `endedAtS`. */
const ended = (endedAtS: number | undefined, over: Obj = {}) => sub({ status: 'canceled', ...(endedAtS === undefined ? {} : { ended_at: endedAtS, canceled_at: endedAtS }), ...over });

const account = { subs: new Map<string, Obj>() };
const stripe = {
  subscriptions: {
    retrieve: vi.fn(async (id: string) => {
      const found = account.subs.get(id);
      if (!found) throw Object.assign(new Error('No such subscription'), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
      return found;
    }),
  },
};

const sendEmail = vi.fn(async (_input: Obj) => ({ status: 'sent' as const }));
const invalidated: string[] = [];
const TABLES = ['user', 'seekerProfile', 'seekerSubscription', 'rACreditLedger', 'rACreditGrant', 'mockInterviewCreditLedger'];
let FREE_ALLOTMENT = 1;

async function seed(row: Obj = {}, user: Obj = {}) {
  await fake.db.user.create({ data: { id: 'u_1', email: 'u_1@example.test', name: 'U', brand: 'roboapply', ...user } });
  await fake.db.seekerProfile.create({ data: { id: 'sp_1', userId: 'u_1', locale: 'en', deletedAt: null } });
  await fake.db.seekerSubscription.create({
    data: {
      id: 'row_1',
      seekerProfileId: 'sp_1',
      tier: 'pro',
      status: 'active',
      brand: 'roboapply',
      rail: 'stripe',
      planKey: 'pro_monthly',
      interval: 'month',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      currentPeriodEnd: new Date(PERIOD_END_S * 1000),
      cancelAtPeriodEnd: false,
      mockCredits: 3,
      mockCreditsRenewedAt: new Date(PERIOD_START_S * 1000),
      mockCreditsPeriodAllotment: 3,
      ...row,
    },
  });
}

const row = () => fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } });
const claims = async () => (await fake.db.rACreditLedger.findMany({})).map((r: Obj) => r.idempotencyKey).sort();
const practiceLedger = () => fake.db.mockInterviewCreditLedger.findMany({});
async function state(): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const t of TABLES) out[t] = (await fake.db[t].findMany({})).map(({ updatedAt: _updatedAt, ...rest }: Obj) => rest);
  return JSON.stringify(out);
}

/** Stripe holds `object` now and sends the event with it. */
function deliver(type: string, object: Obj) {
  account.subs.set(object.id, object);
  return handleRoboApplyStripeEvent({ id: `evt_${type}`, type, data: { object } } as never, stripe as never);
}

beforeEach(async () => {
  vi.clearAllMocks();
  account.subs.clear();
  invalidated.length = 0;
  for (const t of TABLES) await fake.db[t].deleteMany({});
  FREE_ALLOTMENT = (await getMockPlanCatalog()).plans.free.credits;
  // `resetPracticeToFree` is the service's own default: the real practice-credit service on the fake database.
  setBillingServiceDepsForTests({
    db: fake.db as never,
    getStripe: () => stripe as never,
    now: () => NOW,
    grantIfNewPeriod: vi.fn(async () => 'skipped' as const) as never,
    grantPack: vi.fn(async () => ({})),
    sendEmail: sendEmail as never,
    getBalance: async () => ({ credits: 0, tier: 'free', periodAllotment: 1, renewedAt: null, currentPeriodEnd: null, ephemeral: false }),
    invalidate: (userId) => void invalidated.push(userId),
  });
});

afterEach(() => {
  setBillingServiceDepsForTests();
});

describe('a subscription that ends before its paid period runs out', () => {
  it('a withdrawal on day 5 of 30: the plan ends and the practice balance goes back to the Free allotment, once', async () => {
    await seed();
    expect(await deliver('customer.subscription.deleted', ended(NOW_S))).toEqual({ handled: true });

    expect(await row()).toMatchObject({ tier: 'free', planKey: 'free', status: 'canceled', mockCredits: FREE_ALLOTMENT, mockCreditsPeriodAllotment: FREE_ALLOTMENT });
    expect(await claims()).toEqual(['billing:subend:sub_1']);
    expect(await practiceLedger()).toEqual([
      expect.objectContaining({ userId: 'u_1', balanceAfter: FREE_ALLOTMENT, delta: FREE_ALLOTMENT - 3, reason: 'grant_renewal', tier: 'free', source: 'stripe' }),
    ]);
    expect((await practiceLedger())[0].metadata).toMatchObject({ cause: 'subscription_ended_early', ref: 'subend:sub_1' });
    expect(invalidated).toContain('u_1');

    // The event again (Stripe resends): nothing changes twice, even after a free credit was spent.
    await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { mockCredits: 0 } });
    const before = await state();
    expect(await deliver('customer.subscription.deleted', ended(NOW_S))).toEqual({ handled: true });
    expect(await state()).toBe(before);
    expect((await row()).mockCredits).toBe(0);
  });

  it('unspent practice packs stay: only the plan allowance goes', async () => {
    // 3 plan credits and a pack of 5, none used.
    await seed({ mockCredits: 8 });
    await fake.db.rACreditGrant.create({ data: { id: 'pack_1', userId: 'u_1', bucket: 'practice', amount: 5, remaining: 5, reason: 'pack', expiresAt: new Date((NOW_S + 300 * DAY_S) * 1000) } });
    await deliver('customer.subscription.deleted', ended(NOW_S));
    expect((await row()).mockCredits).toBe(FREE_ALLOTMENT + 5);
    expect((await fake.db.rACreditGrant.findUnique({ where: { id: 'pack_1' } })).remaining).toBe(5);
  });

  it('Stripe giving up on an unpaid renewal ends the plan inside the period it could not collect: the allowance goes too', async () => {
    // The renewal was due 10 days ago; the subscription now shows the unpaid period and is cancelled today.
    await seed({ status: 'past_due', mockCredits: 2 });
    const unpaid = ended(NOW_S, { items: { data: [{ id: 'si_1', price: PRICE, current_period_start: NOW_S - 10 * DAY_S, current_period_end: NOW_S + 20 * DAY_S }] } });
    await deliver('customer.subscription.deleted', unpaid);
    expect(await row()).toMatchObject({ tier: 'free', status: 'canceled', mockCredits: FREE_ALLOTMENT });
  });
});

describe('a subscription that is not cut short keeps its balance', () => {
  it('an ordinary cancellation that runs to the end of the paid period changes no practice credit', async () => {
    await seed({ cancelAtPeriodEnd: true, mockCredits: 2 });
    expect(await deliver('customer.subscription.deleted', ended(PERIOD_END_S, { cancel_at_period_end: true }))).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'free', status: 'canceled', mockCredits: 2, mockCreditsPeriodAllotment: 3 });
    expect(await claims()).toEqual([]);
    expect(await practiceLedger()).toEqual([]);

    // A few minutes before the period end is still "ran its period".
    await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { tier: 'pro', status: 'active', planKey: 'pro_monthly' } });
    await deliver('customer.subscription.deleted', ended(PERIOD_END_S - 600));
    expect((await row()).mockCredits).toBe(2);
    expect(await claims()).toEqual([]);
  });

  it('an ended subscription whose end time Stripe does not state is left alone', async () => {
    await seed();
    expect(await deliver('customer.subscription.deleted', ended(undefined))).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'free', mockCredits: 3 });
    expect(await claims()).toEqual([]);
  });

  it('a cancellation that only turns renewal off (the plan still runs) changes no practice credit', async () => {
    await seed();
    expect(await deliver('customer.subscription.updated', sub({ cancel_at_period_end: true, metadata: { ...META, cancelSource: 'app' } }))).toEqual({ handled: true });
    expect(await row()).toMatchObject({ tier: 'pro', cancelAtPeriodEnd: true, mockCredits: 3 });
    expect(await claims()).toEqual([]);
  });

  it('the end of a subscription the row no longer tracks changes nothing', async () => {
    // A pass replaced the subscription: the row carries no subscription id any more.
    await seed({ stripeSubscriptionId: null, planKey: 'pro_week_pass', interval: 'pass', mockCredits: 1 });
    const before = await state();
    expect(await deliver('customer.subscription.deleted', ended(NOW_S))).toEqual({ handled: false });
    expect(await state()).toBe(before);
  });

  it('a row of another brand is never changed by a Stripe event (rule A11)', async () => {
    await seed({ brand: 'goapply' }, { brand: 'goapply' });
    const before = await state();
    expect(await deliver('customer.subscription.deleted', ended(NOW_S))).toEqual({ handled: false });
    expect(await state()).toBe(before);
  });
});
