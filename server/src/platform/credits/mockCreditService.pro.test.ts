// @vitest-environment node
//
// Practice credits for the clone's Pro plans and packs (WP-21a):
//   - tier 'pro' is paid: no free monthly reset while the plan is live;
//   - a pass that has ended counts as free again;
//   - quarterly Pro re-grants 3 credits on a new month;
//   - plan grants keep unspent pack credits on top (plan credits spend first);
//   - an expired pack removes only what is left of it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../test/fakePrisma.js');
  fake.db = createFakePrisma();
  return { default: fake.db };
});
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { allocatePackRemaining, getBalance, grantForPlan, grantForPlanIfNewPeriod, paidPlanLive, planPracticeAllowance } from '../../lib/mockCreditService.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');

function seed(sub: Record<string, unknown>, packs: Record<string, unknown>[] = []) {
  for (const t of ['seekerProfile', 'seekerSubscription', 'mockInterviewCreditLedger', 'rACreditGrant']) fake.db[t].deleteMany({});
  fake.db.seekerProfile.create({ data: { id: 'sp_1', userId: 'u_1' } });
  fake.db.seekerSubscription.create({ data: { id: 'sub_1', seekerProfileId: 'sp_1', status: 'active', cancelAtPeriodEnd: false, stripeSubscriptionId: null, ...sub } });
  for (const p of packs) fake.db.rACreditGrant.create({ data: { userId: 'u_1', bucket: 'practice', reason: 'pack', ...p } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('LLM_SETTINGS_DB_DISABLED', 'true');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('pure helpers', () => {
  it('allocates unspent pack credits to the latest-expiring packs first', () => {
    const packs = [
      { id: 'a', remaining: 5, expiresAt: new Date('2027-01-01') },
      { id: 'b', remaining: 5, expiresAt: new Date('2027-06-01') },
    ];
    expect([...allocatePackRemaining(packs, 7)]).toEqual([
      ['b', 5],
      ['a', 2],
    ]);
    expect([...allocatePackRemaining(packs, 20)].map(([, v]) => v)).toEqual([5, 5]);
    expect([...allocatePackRemaining(packs, 0)].map(([, v]) => v)).toEqual([0, 0]);
  });

  it('a paid plan is live while active and inside its period (auto-renewing plans get 3 days of grace)', () => {
    const end = new Date(NOW.getTime() - 86_400_000);
    expect(paidPlanLive({ tier: 'pro', status: 'active', currentPeriodEnd: end, autoRenewing: false }, NOW)).toBe(false);
    expect(paidPlanLive({ tier: 'pro', status: 'active', currentPeriodEnd: end, autoRenewing: true }, NOW)).toBe(true);
    expect(paidPlanLive({ tier: 'pro', status: 'unpaid', currentPeriodEnd: null, autoRenewing: true }, NOW)).toBe(false);
    expect(paidPlanLive({ tier: 'starter', status: 'active', currentPeriodEnd: null, autoRenewing: false }, NOW)).toBe(true);
    expect(paidPlanLive({ tier: 'free', status: 'active', currentPeriodEnd: null, autoRenewing: false }, NOW)).toBe(false);
  });

  it('reads practice allowances from the plan catalog', () => {
    expect(planPracticeAllowance('pro_quarterly')).toEqual({ credits: 3, per: 'month' });
    expect(planPracticeAllowance('pro_weekly')).toEqual({ credits: 1, per: 'period' });
    expect(planPracticeAllowance('starter')).toBeNull();
  });
});

describe('getBalance with Pro', () => {
  it('never resets a live Pro balance to the free allotment', async () => {
    seed({ tier: 'pro', planKey: 'pro_monthly', mockCredits: 2, mockCreditsRenewedAt: new Date('2026-09-20T00:00:00Z'), currentPeriodEnd: new Date('2026-10-20T00:00:00Z'), stripeSubscriptionId: 'st_1' });
    const b = await getBalance('u_1');
    expect(b).toMatchObject({ credits: 2, tier: 'pro' });
  });

  it('treats an ended pass as free (lazy free grant)', async () => {
    seed({ tier: 'pro', planKey: 'pro_week_pass', interval: 'pass', mockCredits: 0, mockCreditsRenewedAt: new Date('2026-09-01T00:00:00Z'), currentPeriodEnd: new Date('2026-10-01T00:00:00Z') });
    const b = await getBalance('u_1');
    expect(b).toMatchObject({ tier: 'free', credits: 1 });
  });

  it('re-grants quarterly Pro credits on a new month while live', async () => {
    seed({ tier: 'pro', planKey: 'pro_quarterly', mockCredits: 0.5, mockCreditsRenewedAt: new Date('2026-09-15T00:00:00Z'), currentPeriodEnd: new Date('2026-12-15T00:00:00Z'), stripeSubscriptionId: 'st_1' });
    expect(await getBalance('u_1')).toMatchObject({ credits: 3, tier: 'pro', periodAllotment: 3 });
    const ledger = await fake.db.mockInterviewCreditLedger.findMany({});
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ reason: 'grant_renewal', balanceAfter: 3 });
    expect(await getBalance('u_1')).toMatchObject({ credits: 3 });
    expect(await fake.db.mockInterviewCreditLedger.findMany({})).toHaveLength(1);
  });
});

describe('packs', () => {
  it('a plan grant keeps unspent pack credits on top of the allotment', async () => {
    seed({ tier: 'pro', planKey: 'pro_monthly', mockCredits: 6, mockCreditsRenewedAt: new Date('2026-09-10T00:00:00Z'), currentPeriodEnd: NOW }, [
      { id: 'pk_1', amount: 5, remaining: 5, expiresAt: new Date('2027-10-01T00:00:00Z') },
    ]);
    await grantForPlan({ userId: 'u_1', tier: 'pro', credits: 3, reason: 'grant_renewal', source: 'stripe', currentPeriodEnd: new Date('2026-11-10T00:00:00Z') });
    const sub = await fake.db.seekerSubscription.findUnique({ where: { id: 'sub_1' } });
    expect(sub).toMatchObject({ mockCredits: 8, mockCreditsPeriodAllotment: 3 });
    // 6 left before the grant → pack credits (spent last) are all still there.
    expect((await fake.db.rACreditGrant.findUnique({ where: { id: 'pk_1' } })).remaining).toBe(5);
  });

  it('trims a pack the user already dipped into', async () => {
    seed({ tier: 'pro', planKey: 'pro_monthly', mockCredits: 2, currentPeriodEnd: NOW }, [{ id: 'pk_1', amount: 5, remaining: 5, expiresAt: new Date('2027-10-01T00:00:00Z') }]);
    await grantForPlan({ userId: 'u_1', tier: 'pro', credits: 3, reason: 'grant_renewal', source: 'stripe' });
    expect((await fake.db.seekerSubscription.findUnique({ where: { id: 'sub_1' } })).mockCredits).toBe(5);
    expect((await fake.db.rACreditGrant.findUnique({ where: { id: 'pk_1' } })).remaining).toBe(2);
  });

  it('an expired pack removes what is left of it, once', async () => {
    seed({ tier: 'pro', planKey: 'pro_monthly', mockCredits: 4, mockCreditsRenewedAt: new Date('2026-10-01T00:00:00Z'), currentPeriodEnd: new Date('2026-10-30T00:00:00Z'), stripeSubscriptionId: 'st_1' }, [
      { id: 'pk_old', amount: 5, remaining: 3, expiresAt: new Date('2026-10-09T00:00:00Z') },
    ]);
    expect((await getBalance('u_1')).credits).toBe(1);
    expect((await getBalance('u_1')).credits).toBe(1);
    expect((await fake.db.rACreditGrant.findUnique({ where: { id: 'pk_old' } })).remaining).toBe(0);
    const expire = (await fake.db.mockInterviewCreditLedger.findMany({})).filter((r: any) => r.reason === 'expire');
    expect(expire).toHaveLength(1);
  });
});

// M2 gate (payments-safety): every Pro ↔ Pro switch is offered since M2, and a
// paid switch invoice used to SET the balance to the new plan's full
// allowance. A subscriber who had used the month's 3 credits could switch to
// weekly and back for the price of a proration and hold 3 again.
describe('a paid plan switch between two Pro plans tops the balance up; it never refills it', () => {
  const HOUR = 3_600_000;
  const row = () => fake.db.seekerSubscription.findUnique({ where: { id: 'sub_1' } });
  /** The grant a paid `subscription_update` invoice makes: forced, as a plan change; the period started at the switch. */
  const planChange = (credits: number, tier: 'pro' | 'starter' = 'pro') =>
    grantForPlanIfNewPeriod({ userId: 'u_1', tier, credits, periodStart: new Date(), currentPeriodEnd: new Date('2026-11-10T08:00:00Z'), source: 'stripe', force: true, planChange: true });
  /** A subscriber whose current allotment was granted `daysAgo` days ago for `tier`. */
  function subscriber(planKey: string, allotment: number, left: number, tier = 'pro', packs: Record<string, unknown>[] = []) {
    const grantedAt = new Date(NOW.getTime() - 10 * 24 * HOUR);
    seed({ tier, planKey, mockCredits: left, mockCreditsRenewedAt: grantedAt, mockCreditsPeriodAllotment: allotment, currentPeriodEnd: new Date('2026-10-30T08:00:00Z'), stripeSubscriptionId: 'st_1' }, packs);
    fake.db.mockInterviewCreditLedger.create({ data: { seekerProfileId: 'sp_1', userId: 'u_1', delta: allotment, balanceAfter: allotment, reason: 'grant_purchase', tier, createdAt: grantedAt } });
  }
  const later = (hours: number) => vi.setSystemTime(new Date(NOW.getTime() + hours * HOUR));

  it('pro_monthly with 0 credits left → pro_weekly → pro_monthly ends with 0 credits', async () => {
    subscriber('pro_monthly', 3, 0);
    expect(await planChange(1)).toBe('granted');
    expect(await row()).toMatchObject({ mockCredits: 0, mockCreditsPeriodAllotment: 3, mockCreditsRenewedAt: NOW });
    later(1);
    expect(await planChange(3)).toBe('granted');
    expect(await row()).toMatchObject({ mockCredits: 0, mockCreditsPeriodAllotment: 3 });
    // The interval change moved the period start to the switch. The period guard must not read that as an ungranted period.
    expect(await grantForPlanIfNewPeriod({ userId: 'u_1', tier: 'pro', credits: 3, periodStart: new Date(), source: 'stripe', force: false })).toBe('skipped');
    expect((await row()).mockCredits).toBe(0);
    // Every switch leaves a readable ledger row that adds nothing.
    const changes = (await fake.db.mockInterviewCreditLedger.findMany({})).filter((r: any) => r.metadata?.planChange === true);
    expect(changes.map((r: any) => [r.delta, r.balanceAfter, r.tier])).toEqual([
      [0, 0, 'pro'],
      [0, 0, 'pro'],
    ]);
  });

  it('pro_weekly (1 granted) → pro_monthly gains 2, whether the weekly credit was used or not', async () => {
    subscriber('pro_weekly', 1, 1);
    await planChange(3);
    expect(await row()).toMatchObject({ mockCredits: 3, mockCreditsPeriodAllotment: 3 });

    subscriber('pro_weekly', 1, 0);
    await planChange(3);
    expect(await row()).toMatchObject({ mockCredits: 2, mockCreditsPeriodAllotment: 3 });
    // Back to weekly and to monthly again: nothing more.
    later(1);
    await planChange(1);
    later(2);
    await planChange(3);
    expect((await row()).mockCredits).toBe(2);
  });

  it('a top-up adds to the balance, so unspent pack credits and what is left of the plan stay as they are', async () => {
    subscriber('pro_weekly', 1, 6, 'pro', [{ id: 'pk_1', amount: 5, remaining: 5, expiresAt: new Date('2027-10-01T00:00:00Z') }]);
    await planChange(3);
    expect((await row()).mockCredits).toBe(8);
    expect((await fake.db.rACreditGrant.findUnique({ where: { id: 'pk_1' } })).remaining).toBe(5);
  });

  it('a legacy practice plan moving to Pro still gets the new plan\'s allowance, set as before', async () => {
    subscriber('starter', 5, 0, 'starter');
    await planChange(3);
    expect(await row()).toMatchObject({ mockCredits: 3, mockCreditsPeriodAllotment: 3 });
    // An account with no grant on record is set too (nothing says what its balance was granted for).
    seed({ tier: 'pro', planKey: 'pro_monthly', mockCredits: 0, mockCreditsRenewedAt: null, mockCreditsPeriodAllotment: null, currentPeriodEnd: new Date('2026-10-30T08:00:00Z') });
    await planChange(3);
    expect((await row()).mockCredits).toBe(3);
  });

  it('the next paid renewal sets the plan\'s allowance afresh, and a forced grant that is not a plan change still sets', async () => {
    subscriber('pro_monthly', 3, 0);
    await planChange(1); // now weekly; the highest allowance granted this period is still 3
    later(7 * 24);
    expect(await grantForPlanIfNewPeriod({ userId: 'u_1', tier: 'pro', credits: 1, periodStart: new Date(), source: 'stripe', force: false })).toBe('granted');
    expect(await row()).toMatchObject({ mockCredits: 1, mockCreditsPeriodAllotment: 1 });
    later(7 * 24 + 1);
    expect(await grantForPlanIfNewPeriod({ userId: 'u_1', tier: 'pro', credits: 3, periodStart: new Date(), source: 'stripe', force: true })).toBe('granted');
    expect(await row()).toMatchObject({ mockCredits: 3, mockCreditsPeriodAllotment: 3 });
  });
});
