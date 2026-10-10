// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { FX_REFERENCE_MAX_AGE_DAYS as CONTRACT_MAX_AGE } from '../../features/credits/contract.js';
import {
  FX_REFERENCE_MAX_AGE_DAYS,
  fxAgeDays,
  isFxFresh,
  publicFxReference,
  readFxReference,
  saveFxReference,
  twdReferenceWhole,
  type FxDb,
  type FxReference,
} from './fxReference.js';
import { computeTwRevenue, taipeiYearStart, type ChargeLike } from './twRevenue.js';
import { OFFERS_SHIPPED, activeOffers, offerViolations } from './offers.js';
import { buildPlanViews } from './planViews.js';
import {
  CHECKOUT_ACK_PROSE_VERSION,
  WITHDRAWAL_WAIVER_SENTENCE,
  autoRenewAckSentence,
  proseHash,
  recordCheckoutAcknowledgements,
  type ConsentDb,
} from './acknowledgements.js';
import { getPlan } from './planCatalog.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');

const PRICES = {
  STRIPE_PRICE_PRO_WEEKLY: 'price_w',
  STRIPE_PRICE_PRO_WEEKLY_CENTS: '999',
  STRIPE_PRICE_PRO_MONTHLY: 'price_m',
  STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499',
  STRIPE_PRICE_PRO_QUARTERLY: 'price_q',
  STRIPE_PRICE_PRO_QUARTERLY_CENTS: '5999',
  STRIPE_PRICE_PRO_WEEK_PASS: 'price_p',
  STRIPE_PRICE_PRO_WEEK_PASS_CENTS: '699',
  CN_PRICE_PRO_MONTHLY_FEN: '3900',
  CN_PRICE_PRO_QUARTERLY_FEN: '9900',
  CN_PRICE_PRO_WEEK_PASS_FEN: '1200',
};

describe('TWD reference line (R-25, CN L-7)', () => {
  const ref = (asOf: string): FxReference => ({ currency: 'TWD', ratePerUsd: 32.4, source: 'Central Bank of the ROC', asOf, updatedAt: null, updatedBy: null });

  it('mirrors the contract constant (45 days)', () => {
    expect(FX_REFERENCE_MAX_AGE_DAYS).toBe(CONTRACT_MAX_AGE);
  });

  it('is shown up to 45 days old and hidden after, or when missing or dated in the future', () => {
    expect(fxAgeDays(ref('2026-08-26'), NOW)).toBe(45);
    expect(isFxFresh(ref('2026-08-26'), NOW)).toBe(true);
    expect(isFxFresh(ref('2026-08-25'), NOW)).toBe(false);
    expect(isFxFresh(ref('2026-10-11'), NOW)).toBe(false);
    expect(publicFxReference(null, NOW)).toBeNull();
    expect(publicFxReference(ref('2026-08-25'), NOW)).toBeNull();
    expect(publicFxReference(ref('2026-10-01'), NOW)).toEqual({ currency: 'TWD', ratePerUsd: 32.4, source: 'Central Bank of the ROC', asOf: '2026-10-01' });
  });

  it('converts cents to whole NT$', () => {
    expect(twdReferenceWhole(2499, 32.4)).toBe(810);
    expect(twdReferenceWhole(999, 32.4)).toBe(324);
  });

  it('round-trips through AppConfig and ignores a malformed blob', async () => {
    const db = createFakePrisma({ uniqueFields: { appConfig: ['key'] } });
    expect(await readFxReference(db as unknown as FxDb)).toBeNull();
    await saveFxReference(db as unknown as FxDb, { ratePerUsd: 32.4, source: ' Central Bank ', asOf: '2026-10-01' }, 'admin_1', NOW);
    expect(await readFxReference(db as unknown as FxDb)).toMatchObject({ ratePerUsd: 32.4, source: 'Central Bank', asOf: '2026-10-01', updatedBy: 'admin_1' });
    await db.appConfig.update({ where: { key: 'fx.reference' }, data: { value: '{"TWD":{"ratePerUsd":-1}}' } });
    expect(await readFxReference(db as unknown as FxDb)).toBeNull();
  });
});

describe('TW revenue monitor (TW-06)', () => {
  const charge = (id: string, over: Partial<ChargeLike> = {}): ChargeLike => ({
    id,
    amount: 10_000_00,
    amount_refunded: 0,
    currency: 'usd',
    status: 'succeeded',
    paid: true,
    created: Math.floor(NOW.getTime() / 1000),
    payment_method_details: { card: { country: 'TW' } },
    ...over,
  });
  const fx: FxReference = { currency: 'TWD', ratePerUsd: 32, source: 'Central Bank', asOf: '2026-10-01', updatedAt: null, updatedBy: null };

  it('sums TW-card charges net of refunds since the Taipei new year, warns at 70 % of NT$600k', async () => {
    const pages = [
      { data: [charge('ch_1'), charge('ch_2', { payment_method_details: { card: { country: 'US' } } }), charge('ch_3', { amount_refunded: 1_000_00 })], has_more: true },
      { data: [charge('ch_4', { currency: 'twd', amount: 30_000_00 }), charge('ch_5', { status: 'failed', paid: false }), charge('ch_6', { currency: 'eur' })], has_more: false },
    ];
    const list = vi.fn(async (params: { created: { gte: number }; starting_after?: string }) => {
      expect(params.created.gte).toBe(Math.floor(taipeiYearStart(NOW).getTime() / 1000));
      return pages[params.starting_after ? 1 : 0]!;
    });
    const r = await computeTwRevenue({ stripe: { charges: { list } }, fx, now: NOW });
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]![0].starting_after).toBe('ch_3');
    expect(r.revenueUsdMinor).toBe(10_000_00 + 9_000_00);
    expect(r.revenueTwdChargesWhole).toBe(30_000);
    expect(r.revenueTwd).toBe(19_000 * 32 + 30_000);
    expect(r).toMatchObject({ thresholdTwd: 600000, warnAt: 420000, warning: true, chargeCount: 3, skippedOtherCurrency: 1, source: 'stripe' });
  });

  it('reports NT$ as null (never guessed) without a fresh rate', async () => {
    const r = await computeTwRevenue({
      stripe: { charges: { list: async () => ({ data: [charge('ch_1', { amount: 100_00 })], has_more: false }) } },
      fx: { ...fx, asOf: '2026-01-01' },
      now: NOW,
    });
    expect(r.revenueTwd).toBeNull();
    expect(r.warning).toBe(false);
    expect(r.fx).toMatchObject({ fresh: false });
  });

  it('starts the year at midnight Asia/Taipei', () => {
    expect(taipeiYearStart(new Date('2026-12-31T17:00:00.000Z')).toISOString()).toBe('2026-12-31T16:00:00.000Z');
    expect(taipeiYearStart(NOW).toISOString()).toBe('2025-12-31T16:00:00.000Z');
  });
});

describe('offers seam (no offer at launch)', () => {
  it('ships nothing', () => {
    expect(OFFERS_SHIPPED).toBe(false);
    expect(activeOffers({ brand: 'roboapply', userId: 'u', signedUpAt: NOW, now: NOW })).toEqual([]);
  });

  it('flags a comparison price that was never charged for 30 days and windows over 7 days', () => {
    const v = offerViolations(
      { id: 'w', kind: 'welcome_price', brand: 'roboapply', planKey: 'pro_week_pass', amountMinor: 499, startsAt: NOW.toISOString(), endsAt: new Date(NOW.getTime() + 8 * 86_400_000).toISOString(), regularAmountMinor: 699 },
      { now: NOW, regularPriceChargedSince: new Date(NOW.getTime() - 10 * 86_400_000) },
    );
    expect(v).toEqual(['longer_than_7_days', 'comparison_price_not_established']);
  });
});

describe('plan views (F-BILL-02 honesty)', () => {
  it('computes "Save N%" from our own monthly price, rounded down, and the weekly monthly equivalent', () => {
    const { plans, defaultSelection } = buildPlanViews('roboapply', { env: PRICES, currentPlanKey: 'pro_weekly' });
    const q = plans.find((p) => p.key === 'pro_quarterly')!;
    // 3 × $24.99 = $74.97 → $59.99 saves 19.98 % → 19 (never rounded up to 20).
    expect(q.savingsPercent).toBe(19);
    expect(plans.find((p) => p.key === 'pro_weekly')).toMatchObject({ monthlyEquivalentMinor: 4329, current: true, isDefaultSelection: false });
    expect(defaultSelection).toBe('pro_monthly');
    expect(plans.some((p) => p.key.startsWith('student_'))).toBe(false);
  });

  it('never preselects weekly or the pass, even when only they are priced', () => {
    const { defaultSelection } = buildPlanViews('roboapply', {
      env: { STRIPE_PRICE_PRO_WEEKLY: 'price_w', STRIPE_PRICE_PRO_WEEKLY_CENTS: '999', STRIPE_PRICE_PRO_WEEK_PASS: 'p', STRIPE_PRICE_PRO_WEEK_PASS_CENTS: '699' },
    });
    expect(defaultSelection).toBeNull();
  });

  it('GoApply: passes only, on sale at the catalog prices with an empty env, 省 15 % on the quarter pass', () => {
    const open = buildPlanViews('goapply', { env: {} });
    expect(open.plans.every((p) => !p.autoRenews)).toBe(true);
    expect(open.plans.filter((p) => p.kind !== 'free').map((p) => [p.key, p.amountMinor, p.sellable])).toEqual([
      ['pro_week_pass', 1200, true],
      ['pro_monthly', 3900, true],
      ['pro_quarterly', 9900, true],
      ['practice_pack_5', 2900, true],
      ['practice_pack_15', 7900, true],
    ]);
    expect(open.plans.find((p) => p.key === 'pro_quarterly')?.savingsPercent).toBe(15);
    expect(open.plans.find((p) => p.key === 'pro_week_pass')?.monthlyEquivalentMinor).toBeNull();
    expect(open.defaultSelection).toBe('pro_monthly');
    // No promotion codes on GoApply (they belong to the Stripe rail), whatever the switch says.
    expect(buildPlanViews('goapply', { env: { STRIPE_PROMOTION_CODES: 'true' } }).plans.every((p) => !p.promotionCodes)).toBe(true);
  });

  it('GoApply kill switch: prices stay listed, nothing is sellable and nothing is preselected', () => {
    const closed = buildPlanViews('goapply', { env: { CN_PAYMENTS_ENABLED: 'false' } });
    expect(closed.plans.every((p) => !p.sellable)).toBe(true);
    expect(closed.plans.filter((p) => p.kind !== 'free').every((p) => p.unsellableReason === 'payments_disabled' && p.amountMinor !== null)).toBe(true);
    expect(closed.plans.find((p) => p.key === 'pro_quarterly')?.savingsPercent).toBe(15);
    expect(closed.defaultSelection).toBeNull();
  });

  it('GoApply student passes: listed with the student capability, 25 % and 30 % from the catalog amounts', () => {
    expect(buildPlanViews('goapply', { env: {} }).plans.some((p) => p.key.startsWith('student_'))).toBe(false);
    const { plans, defaultSelection } = buildPlanViews('goapply', { env: {}, studentEnabled: true });
    expect(plans.filter((p) => p.key.startsWith('student_')).map((p) => [p.key, p.amountMinor, p.passDays, p.studentDiscountPercent, p.sellable])).toEqual([
      ['student_monthly', 2900, 30, 25, true],
      ['student_quarterly', 6900, 90, 30, true],
    ]);
    expect(defaultSelection).toBe('pro_monthly');
  });

  it('shows student plans only with the student capability', () => {
    expect(buildPlanViews('roboapply', { env: PRICES, studentEnabled: true }).plans.some((p) => p.key === 'student_monthly')).toBe(true);
  });
});

describe('checkout acknowledgements', () => {
  it('builds the auto-renew sentence from the real price and period', () => {
    expect(autoRenewAckSentence(getPlan('roboapply', 'pro_quarterly', PRICES)!)).toBe('I agree this renews automatically every 3 months at $59.99 until I cancel');
    expect(autoRenewAckSentence(getPlan('roboapply', 'pro_weekly', PRICES)!)).toBe('I agree this renews automatically every week at $9.99 until I cancel');
  });

  it('records auto_renew_ack and withdrawal_waiver with version and hash', async () => {
    const db = createFakePrisma();
    const plan = getPlan('roboapply', 'pro_monthly', PRICES)!;
    const out = await recordCheckoutAcknowledgements(db as unknown as ConsentDb, {
      seekerProfileId: 'sp_1',
      plan,
      autoRenewAck: true,
      withdrawalWaiver: true,
      ip: '1.2.3.4',
      userAgent: 'test',
    });
    const rows = await db.seekerConsentRecord.findMany({});
    expect(rows.map((r) => r.consentType).sort()).toEqual(['auto_renew_ack', 'withdrawal_waiver']);
    expect(rows.every((r) => r.proseVersion === CHECKOUT_ACK_PROSE_VERSION && r.granted === true)).toBe(true);
    expect(out.withdrawalWaiver.proseHash).toBe(proseHash(WITHDRAWAL_WAIVER_SENTENCE));
    expect(out.autoRenewAck.proseHash).toBe(proseHash(autoRenewAckSentence(plan)));
  });

  it('writes nothing for a pass (no auto-renewal) without a waiver', async () => {
    const db = createFakePrisma();
    await recordCheckoutAcknowledgements(db as unknown as ConsentDb, {
      seekerProfileId: 'sp_1',
      plan: getPlan('roboapply', 'pro_week_pass', PRICES)!,
      autoRenewAck: true,
      withdrawalWaiver: false,
    });
    expect(await db.seekerConsentRecord.findMany({})).toEqual([]);
  });
});
