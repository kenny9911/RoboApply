// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), orders: vi.fn(), invoices: vi.fn(), subscription: vi.fn(), upsert: vi.fn(), adjustment: vi.fn(),
  /** Every Stripe SDK client built while a test ran (the SDK is mocked: nothing reaches Stripe). */
  constructed: [] as Array<{ key: string; config: unknown }>,
}));
vi.mock('../../../lib/prisma.js', () => ({ default: {
  $queryRawUnsafe: mocks.query, alipayOrder: { findMany: mocks.orders },
  seekerProfile: { findUnique: async () => ({ id: 'profile' }) },
  seekerSubscription: { findUnique: mocks.subscription, upsert: mocks.upsert },
  roboApplyMission: { update: async () => ({}) }, adminAdjustment: { create: mocks.adjustment },
} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('stripe', () => ({ default: class {
  invoices = { list: mocks.invoices };
  constructor(key: string, config: unknown) { mocks.constructed.push({ key, config }); }
} }));
vi.mock('../../../lib/rateCard.js', () => ({ getRateCard: async () => ({}), tierPriceUsd: () => 19, tierDailyCap: () => 3 }));

import { actualMrrUsd, resolveRange, setUserPlan } from './RAAdminAnalyticsService.js';
import { getOperationsOverview, getOperationsPayments, getOperationsUsers, summarizePayments } from './RAAdminOperationsService.js';
import { resetStripeClientForTests, setStripeClientForTests } from '../../../platform/billing/stripeClient.js';

const range = resolveRange('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
const user = { id: 'u1', email: 'user@example.com', name: 'User', region: 'us', tier: 'premium', stripeCustomerId: null };
let testId = 0;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.constructed.length = 0;
  resetStripeClientForTests();
  setStripeClientForTests(undefined);
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_dummy');
  vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION', '');
  testId++;
  mocks.query.mockResolvedValue([user]);
  mocks.orders.mockResolvedValue([]);
  mocks.invoices.mockResolvedValue({ data: [], has_more: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  setStripeClientForTests(undefined);
});

// ST-0: the payments report used to build its own Stripe client from the raw
// key, which bypassed the live-key guard. It now asks the one factory.
describe('the payments report reads Stripe through the shared client factory', () => {
  const stripeUser = { ...user, stripeCustomerId: 'cus_seeker' };
  const invoice = { id: 'in_1', number: 'INV-1', customer: 'cus_seeker', currency: 'usd', status: 'paid', amount_paid: 2499, amount_due: 2499,
    created: Date.parse('2026-10-02') / 1000, status_transitions: { paid_at: Date.parse('2026-10-02') / 1000 },
    customer_address: { country: 'US' }, billing_reason: 'subscription_create' };

  it('builds the client once through getStripe (shared options), and scans with its own short timeout and no retry per request', async () => {
    mocks.query.mockResolvedValue([stripeUser]);
    mocks.invoices.mockResolvedValue({ data: [invoice], has_more: false });
    const result = await getOperationsPayments({ range, q: String(testId) });
    expect(result.coverage.stripe).toBe('complete');
    expect(result.rows[0]).toMatchObject({ id: 'in_1', provider: 'stripe', amountMinor: 2499, currency: 'USD' });
    expect(mocks.constructed).toEqual([{ key: 'sk_test_dummy', config: { maxNetworkRetries: 2, appInfo: { name: 'RoboApply', url: 'https://www.roboapply.io' } } }]);
    expect(mocks.invoices).toHaveBeenCalledTimes(1);
    expect(mocks.invoices.mock.calls[0][1]).toEqual({ timeout: 6000, maxNetworkRetries: 0 });
  });

  it('no client is built for a refused key: a live key outside production reports not_configured and scans nothing', async () => {
    mocks.query.mockResolvedValue([stripeUser]);
    mocks.invoices.mockResolvedValue({ data: [invoice], has_more: false });
    for (const key of ['sk_live_example', 'rk_live_example']) {
      vi.stubEnv('STRIPE_SECRET_KEY', key);
      testId++;
      const result = await getOperationsPayments({ range, q: String(testId) });
      expect(result.coverage.stripe, key).toBe('not_configured');
      expect(result.rows).toEqual([]);
    }
    vi.stubEnv('VERCEL_ENV', 'preview');
    testId++;
    expect((await getOperationsPayments({ range, q: String(testId) })).coverage.stripe).toBe('not_configured');
    expect(mocks.constructed).toEqual([]);
    expect(mocks.invoices).not.toHaveBeenCalled();
  });

  it('the same live key is used in production, and outside it only with the explicit override', async () => {
    mocks.query.mockResolvedValue([stripeUser]);
    mocks.invoices.mockResolvedValue({ data: [invoice], has_more: false });
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_example');
    vi.stubEnv('VERCEL_ENV', 'production');
    expect((await getOperationsPayments({ range, q: String(testId) })).coverage.stripe).toBe('complete');
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION', 'true');
    testId++;
    expect((await getOperationsPayments({ range, q: String(testId) })).coverage.stripe).toBe('complete');
    expect(mocks.constructed.map((c) => c.key)).toEqual(['sk_live_example']);
  });

  it('without a key the coverage is not_configured, as before; with no Stripe customer in scope it is complete and nothing is asked', async () => {
    mocks.query.mockResolvedValue([stripeUser]);
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect((await getOperationsPayments({ range, q: String(testId) })).coverage.stripe).toBe('not_configured');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_dummy');
    mocks.query.mockResolvedValue([user]);
    testId++;
    expect((await getOperationsPayments({ range, q: String(testId) })).coverage.stripe).toBe('complete');
    expect(mocks.constructed).toEqual([]);
    expect(mocks.invoices).not.toHaveBeenCalled();
  });

  it('a client installed with setStripeClientForTests is the one the report uses', async () => {
    mocks.query.mockResolvedValue([stripeUser]);
    const list = vi.fn(async () => ({ data: [{ ...invoice, id: 'in_fake' }], has_more: false }));
    setStripeClientForTests({ invoices: { list } } as never);
    const result = await getOperationsPayments({ range, q: String(testId) });
    expect(result.rows.map((r) => r.id)).toEqual(['in_fake']);
    expect(list).toHaveBeenCalledTimes(1);
    expect(mocks.constructed).toEqual([]);
  });
});

describe('admin native-currency accounting', () => {
  it('does not relabel CNY, JPY, missing currency, or catalog prices as USD MRR', () => {
    expect(actualMrrUsd({ amountMinor: 1900, currency: 'CNY', status: 'active', tier: 'premium' })).toBeNull();
    expect(actualMrrUsd({ amountMinor: 1900, currency: 'JPY', status: 'active', tier: 'premium' })).toBeNull();
    expect(actualMrrUsd({ amountMinor: 1900, currency: null, status: 'active', tier: 'premium' })).toBeNull();
    expect(actualMrrUsd({ amountMinor: null, currency: 'USD', status: 'active', tier: 'premium' })).toBeNull();
    expect(actualMrrUsd({ amountMinor: 1900, currency: 'usd', status: 'active', tier: 'premium' })).toBe(19);
    expect(actualMrrUsd({ amountMinor: 1900, currency: 'USD', status: 'canceled', tier: 'premium' })).toBe(0);
  });

  it('groups only paid amounts without mixing currencies or counting failed orders', () => {
    const rows = [
      { currency: 'USD', amountMinor: 1900, status: 'paid' },
      { currency: 'CNY', amountMinor: 1900, status: 'paid' },
      { currency: 'CNY', amountMinor: 3900, status: 'paid' },
      { currency: 'CNY', amountMinor: 9999, status: 'failed' },
      { currency: 'JPY', amountMinor: 300, status: 'paid' },
    ];
    expect(summarizePayments(rows as never)).toEqual([
      { currency: 'CNY', paidMinor: 5800, paidCount: 2 },
      { currency: 'JPY', paidMinor: 300, paidCount: 1 },
      { currency: 'USD', paidMinor: 1900, paidCount: 1 },
    ]);
  });

  it('never reinterprets a USD catalog amount as a CNY admin override', async () => {
    mocks.subscription.mockResolvedValue({ tier: 'free', currency: 'CNY', amountMinor: 0 });
    await expect(setUserPlan({ userId: 'u1', tier: 'premium', reason: 'Plan correction', adminId: 'a1' }))
      .rejects.toMatchObject({ code: 'amount_required' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('retains an unchanged explicitly priced CNY subscription and audits its currency', async () => {
    mocks.subscription.mockResolvedValue({ tier: 'premium', currency: 'CNY', amountMinor: 1900 });
    const result = await setUserPlan({ userId: 'u1', tier: 'premium', reason: 'Restore access', adminId: 'a1' });
    expect(result).toMatchObject({ amountMinor: 1900, currency: 'CNY' });
    expect(mocks.upsert.mock.calls[0][0].update).toMatchObject({ amountMinor: 1900, currency: 'CNY' });
    expect(JSON.parse(mocks.adjustment.mock.calls[0][0].data.newValue).currency).toBe('CNY');
  });

  it('uses real Alipay receipts, billing region, original CNY and paid timestamp', async () => {
    mocks.orders.mockResolvedValue([{ id: 'p1', userId: 'u1', outTradeNo: 'ra_123', tier: 'ra_starter',
      amount: 19, status: 'completed', createdAt: new Date('2026-09-30T12:00:00Z'), completedAt: new Date('2026-10-02T12:00:00Z') }]);
    const result = await getOperationsPayments({ range, q: String(testId), region: 'cn' });
    expect(result.rows[0]).toMatchObject({ provider: 'alipay', currency: 'CNY', amountMinor: 1900, status: 'paid', region: 'cn', paidAt: '2026-10-02T12:00:00.000Z' });
    expect(result.currencies).toEqual([{ currency: 'CNY', paidMinor: 1900, paidCount: 1 }]);
    expect(mocks.orders.mock.calls[0][0].where.OR).toContainEqual({ completedAt: { gte: range.from, lt: range.to } });
    expect(result.coverage.refundsIncluded).toBe(false);
  });

  it('paginates owned Stripe invoices and filters by payment time, currency and type', async () => {
    mocks.query.mockResolvedValue([{ ...user, stripeCustomerId: 'cus_seeker' }]);
    const invoice = { id: 'in_1', number: 'INV-1', customer: 'cus_seeker', currency: 'cny', status: 'paid', amount_paid: 1900, amount_due: 1900,
      created: Date.parse('2026-09-01') / 1000, status_transitions: { paid_at: Date.parse('2026-10-08') / 1000 },
      customer_address: { country: 'CN' }, billing_reason: 'subscription_cycle' };
    mocks.invoices.mockResolvedValueOnce({ data: [{ ...invoice, customer: 'cus_recruiter', id: 'in_other' }], has_more: true })
      .mockResolvedValueOnce({ data: [invoice], has_more: false });
    const result = await getOperationsPayments({ range, q: String(testId), currency: 'CNY', type: 'renewal', provider: 'stripe' });
    expect(result.total).toBe(1);
    expect(result.rows[0]).toMatchObject({ id: 'in_1', amountMinor: 1900, currency: 'CNY', region: 'cn', paidAt: '2026-10-08T00:00:00.000Z' });
    expect(mocks.invoices.mock.calls[1][0]).toMatchObject({ starting_after: 'in_other' });
    expect(result.coverage.stripe).toBe('complete');
  });

  it('reports missing Stripe coverage while preserving known Alipay collections', async () => {
    mocks.query.mockResolvedValue([{ ...user, stripeCustomerId: 'cus_seeker' }]);
    mocks.invoices.mockRejectedValue(new Error('provider unavailable'));
    const result = await getOperationsPayments({ range, q: String(testId) });
    expect(result.coverage.stripe).toBe('unavailable');
    expect(result.coverage.refundsIncluded).toBe(false);
  });

  it('bounds provider scans and explicitly reports partial coverage', async () => {
    mocks.query.mockResolvedValue([{ ...user, stripeCustomerId: 'cus_seeker' }]);
    mocks.invoices.mockResolvedValue({ data: [{ id: 'in_other', customer: 'other' }], has_more: true });
    const result = await getOperationsPayments({ range, q: String(testId) });
    expect(mocks.invoices).toHaveBeenCalledTimes(10);
    expect(result.coverage.stripe).toBe('partial');
  });

  it('keeps the full total for an empty late user page and parameterizes filters', async () => {
    mocks.query.mockResolvedValueOnce([{ total: 23n }]).mockResolvedValueOnce([]);
    const result = await getOperationsUsers({ range, q: "' OR 1=1 --", region: 'cn', page: 5, pageSize: 10 });
    expect(result).toEqual({ rows: [], total: 23, page: 5, pageSize: 10 });
    const [sql, ...values] = mocks.query.mock.calls[0];
    expect(sql).not.toContain("' OR 1=1 --");
    expect(values).toContain("' OR 1=1 --");
    expect(sql).toContain('"SeekerProfile"');
    expect(sql).toContain('"RoboApplyMission"');
  });

  it('deduplicates feature users across SKUs, fills missing days and includes shared platform cost', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM scoped_users')) return [user];
      if (sql.includes('ARRAY_AGG')) return [
        { key: 'ra_resume_tailor', source: 'usage_ledger', events: 2n, userIds: ['u1'], units: 2n, cost: 0.02 },
        { key: 'seeker_tailor', source: 'usage_ledger', events: 3n, userIds: ['u1', 'u2'], units: 3n, cost: 0.03 },
      ];
      if (sql.includes('AS "loginUsers"')) return [{ total: 2n, new: 1n, active: 2n, loginUsers: 1n, loginEvents: 2n, featureEvents: 0n, cost: 0.05 }];
      if (sql.includes('GROUP BY day')) return [{ day: '2026-10-02', logins: 2n, features: 0n, active: 2n }];
      if (sql.includes('GROUP BY region')) return [{ region: 'cn', users: 2n }];
      if (sql.includes('MIN(a.')) return [{ since: null }];
      if (sql.includes('WHERE "userId"=$1')) return [{ cost: 0.01 }];
      throw new Error('Unexpected query');
    });
    const result = await getOperationsOverview({ range: resolveRange('2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z') });
    expect(result.featureUsage).toEqual([{ key: 'resume_tailor', source: 'usage_ledger', events: 5, users: 2, units: 5, costUsd: 0.05 }]);
    expect(result.costUsd).toBe(0.06);
    expect(result.activitySeries).toEqual([
      { day: '2026-10-01', logins: 0, featureEvents: 0, activeUsers: 0 },
      { day: '2026-10-02', logins: 2, featureEvents: 0, activeUsers: 2 },
      { day: '2026-10-03', logins: 0, featureEvents: 0, activeUsers: 0 },
    ]);
  });
});

describe('admin date ranges', () => {
  it('includes a complete local calendar day for date-only from/to', () => {
    const value = resolveRange('2026-10-09', '2026-10-09', 'Asia/Shanghai');
    expect(value.from.toISOString()).toBe('2026-10-08T16:00:00.000Z');
    expect(value.to.toISOString()).toBe('2026-10-09T16:00:00.000Z');
  });
  it('handles a DST transition day and preserves explicit ISO end instants', () => {
    const value = resolveRange('2026-03-08', '2026-03-08', 'America/New_York');
    expect(value.to.getTime() - value.from.getTime()).toBe(23 * 60 * 60 * 1000);
    expect(resolveRange('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z').to.toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });
  it.each([['garbage','2026-10-09'], ['2026-10-10','2026-10-08'], ['2026-02-30','2026-03-02']])('rejects invalid ranges %s → %s', (from, to) => {
    expect(() => resolveRange(from, to)).toThrow(RangeError);
  });
});
