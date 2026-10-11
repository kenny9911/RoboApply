// @vitest-environment node
//
// Market wave M1 gate: the seam between MKT-1A (server, `GET /billing/plans`)
// and MKT-1B (web, /pricing and the plan sheet). The two were built in separate
// worktrees against the contract text of MARKET_TASK_PLAN.md 3.1; the web tests
// use a fixture and the server tests assert the response, so neither proves that
// the web READS what the server SENDS. This test feeds the real response of the
// server's plans service, after a JSON round trip, to the web's own reader.
//
// No network, no database (a fake Prisma), no Stripe: the plans service never
// calls a provider.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../server/src/lib/prisma.js', () => ({ default: {} }));
vi.mock('../../server/src/services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { plansBillingFacts } from '../../lib/api/account';
import { samePriceAsWeeklyBilling } from '../../lib/pricing';
import { CreditsAreaService, type CreditsDb } from '../../server/src/features/credits/index.js';
import { getBrand } from '../../server/src/platform/brand/registry.js';
import { createFakePrisma } from '../../server/src/test/fakePrisma.js';

const NOW = new Date('2026-10-11T08:00:00.000Z');
const db = createFakePrisma();

/** What the browser receives: the service's answer through JSON, as an untyped value. */
async function wire(brand: 'roboapply' | 'goapply', env: Record<string, string>): Promise<unknown> {
  const svc = new CreditsAreaService({ db: async () => db as unknown as CreditsDb, env: () => env, now: () => NOW });
  return JSON.parse(JSON.stringify(await svc.plans(getBrand(brand), { userId: null, country: null })));
}

type WirePlan = { key: string; amountMinor: number | null; currency: string; sellable: boolean; unsellableReason: string | null };
const plansOf = (view: unknown) => (view as { plans: WirePlan[] }).plans;

describe('GET /billing/plans: what the server sends is what /pricing reads (MKT-1A to MKT-1B)', () => {
  const RAIL_READY = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test' };

  it('RoboApply: the refund rules are stated (six positive whole numbers and the public version), no entity, no separate student list', async () => {
    const facts = plansBillingFacts(await wire('roboapply', RAIL_READY));
    expect(facts.refundPolicy).toEqual({
      firstPurchaseDays: 7,
      shortPlanHours: 48,
      paidOnlyCreditLimit: 5,
      accidentalRenewalDays: 3,
      withdrawalDays: 14,
      packValidMonths: 12,
      version: 'refund-v1-2026-10',
    });
    expect(facts.collectingEntity).toBeNull();
    expect(facts.studentOffer).toEqual([]);
  });

  it('GoApply: the same rules under the public label, the collecting entity only when configured, and the published student prices', async () => {
    const plain = plansBillingFacts(await wire('goapply', {}));
    expect(plain.refundPolicy).not.toBeNull();
    // The label a buyer can read never carries the internal review suffix.
    expect(plain.refundPolicy!.version).toMatch(/^refund-v\d+-\d{4}-\d{2}$/);
    expect(plain.collectingEntity).toBeNull();
    expect(plain.studentOffer).toEqual([
      { key: 'student_monthly', amountMinor: 2900, studentDiscountPercent: 25 },
      { key: 'student_quarterly', amountMinor: 6900, studentDiscountPercent: 30 },
    ]);
    const named = plansBillingFacts(await wire('goapply', { CN_PAYMENT_COLLECTING_ENTITY: '  Example Collecting Co.  ' }));
    expect(named.collectingEntity).toBe('Example Collecting Co.');
  });

  it('RoboApply plans arrive with the catalog amounts and no price variable, on sale only while the Stripe rail is ready', async () => {
    const amounts = (view: unknown) => Object.fromEntries(plansOf(view).filter((p) => p.key !== 'free').map((p) => [p.key, p.amountMinor]));
    const ready = await wire('roboapply', RAIL_READY);
    expect(amounts(ready)).toMatchObject({ pro_weekly: 999, pro_monthly: 2499, pro_quarterly: 5499, pro_week_pass: 999, practice_pack_5: 999, practice_pack_15: 2499 });
    expect(plansOf(ready).filter((p) => p.key !== 'free').every((p) => p.sellable && p.currency === 'USD')).toBe(true);
    expect((ready as { paymentsOpen: boolean; checkout: { rails: string[] } }).checkout.rails).toEqual(['stripe']);
    // A key without a webhook secret, or a live key outside production: the same amounts, closed, never "price not set".
    const CLOSED: Array<Record<string, string>> = [{ STRIPE_SECRET_KEY: 'sk_test_x' }, { ...RAIL_READY, STRIPE_SECRET_KEY: 'sk_live_example' }, {}];
    for (const env of CLOSED) {
      const closed = await wire('roboapply', env);
      expect(amounts(closed)).toEqual(amounts(ready));
      const paid = plansOf(closed).filter((p) => p.key !== 'free');
      expect(paid.every((p) => !p.sellable && p.unsellableReason === 'payments_disabled')).toBe(true);
      expect((closed as { paymentsOpen: boolean }).paymentsOpen).toBe(false);
      expect((closed as { checkout: { rails: string[] } }).checkout.rails).toEqual([]);
    }
    // The web's same-price rule reads the two amounts the server sent (weekly billing and the 7-day pass are both $9.99).
    const byKey = new Map(plansOf(ready).map((p) => [p.key, p]));
    expect(samePriceAsWeeklyBilling(byKey.get('pro_week_pass') as never, plansOf(ready) as never)).toBe(true);
  });
});
