// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PRORATA_WITHDRAWAL_PLANS, REFUND_POLICY_VERSION, computeRefund, isWithdrawalRule, paidOnlyCreditsUsed, type RefundInput } from './refunds.js';
import { showsWithdrawalWaiver, withdrawalRegion } from './acknowledgements.js';
import { PLAN_DEFINITIONS } from './planCatalog.js';

const T0 = new Date('2026-10-01T12:00:00.000Z');
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);

function input(over: Partial<RefundInput> = {}): RefundInput {
  return {
    brand: 'roboapply',
    planKey: 'pro_monthly',
    chargeKind: 'first_purchase',
    chargedAt: T0,
    amountMinor: 2499,
    currency: 'USD',
    now: days(1),
    billingCountry: 'US',
    withdrawalWaiver: false,
    paidOnlyCreditsUsed: 0,
    ...over,
  };
}

describe('computeRefund (F-BILL-08)', () => {
  it('EU checkout without the withdrawal waiver → full refund within 14 days, even after heavy use', () => {
    const d = computeRefund(input({ billingCountry: 'DE', now: days(13), paidOnlyCreditsUsed: 40 }));
    expect(d).toMatchObject({ eligible: true, amountMinor: 2499, rule: 'withdrawal_14d', withdrawalRegion: 'eu' });
    expect(d.deadline).toBe(days(14).toISOString());
    expect(computeRefund(input({ billingCountry: 'DE', now: days(15), paidOnlyCreditsUsed: 40 })).eligible).toBe(false);
  });

  it('UK and TW get the same 14-day withdrawal right without the waiver', () => {
    expect(computeRefund(input({ billingCountry: 'GB', now: days(10), paidOnlyCreditsUsed: 9 })).rule).toBe('withdrawal_14d');
    expect(computeRefund(input({ billingCountry: 'TW', now: days(10), paidOnlyCreditsUsed: 9 })).rule).toBe('withdrawal_14d');
  });

  it('with the waiver ticked and no period bounds known, EU falls back to the standard policy', () => {
    const d = computeRefund(input({ billingCountry: 'FR', withdrawalWaiver: true, now: days(10) }));
    expect(d).toMatchObject({ eligible: false, rule: 'first_purchase_7d', blocker: 'window_passed', prorata: null, endsAccess: false });
  });

  it('the withdrawal right never covers a renewal', () => {
    const d = computeRefund(input({ billingCountry: 'DE', chargeKind: 'renewal', now: days(5) }));
    expect(d).toMatchObject({ eligible: false, rule: 'accidental_renewal_3d', blocker: 'window_passed' });
  });

  it('first purchase: 7 days if fewer than 5 paid-only credits were used', () => {
    expect(computeRefund(input({ now: days(6), paidOnlyCreditsUsed: 4 }))).toMatchObject({ eligible: true, rule: 'first_purchase_7d' });
    expect(computeRefund(input({ now: days(6), paidOnlyCreditsUsed: 5 }))).toMatchObject({ eligible: false, blocker: 'credits_used' });
    expect(computeRefund(input({ now: days(8) }))).toMatchObject({ eligible: false, blocker: 'window_passed' });
  });

  it('weekly plan and the 7-day pass: 48 hours', () => {
    expect(computeRefund(input({ planKey: 'pro_weekly', amountMinor: 999, now: hours(47) }))).toMatchObject({ eligible: true, rule: 'first_purchase_48h' });
    expect(computeRefund(input({ planKey: 'pro_week_pass', amountMinor: 699, now: hours(49) }))).toMatchObject({ eligible: false, rule: 'first_purchase_48h' });
  });

  it('an accidental renewal is refundable within 3 days', () => {
    expect(computeRefund(input({ chargeKind: 'renewal', now: days(2) }))).toMatchObject({ eligible: true, rule: 'accidental_renewal_3d' });
    expect(computeRefund(input({ chargeKind: 'renewal', now: days(4) }))).toMatchObject({ eligible: false });
  });

  it('practice packs: refundable while unused, within 12 months', () => {
    const pack = { planKey: 'practice_pack_5', amountMinor: 999 };
    expect(computeRefund(input({ ...pack, now: days(200), packCreditsUsed: 0 }))).toMatchObject({ eligible: true, rule: 'unused_pack' });
    expect(computeRefund(input({ ...pack, now: days(2), packCreditsUsed: 1 }))).toMatchObject({ eligible: false, blocker: 'pack_used' });
    expect(computeRefund(input({ ...pack, now: days(400), packCreditsUsed: 0 }))).toMatchObject({ eligible: false, blocker: 'window_passed' });
    // EU withdrawal still applies to a used pack inside 14 days without the waiver.
    expect(computeRefund(input({ ...pack, billingCountry: 'IE', now: days(3), packCreditsUsed: 2 })).rule).toBe('withdrawal_14d');
  });

  it('nothing charged → nothing to refund; GoApply carries its pending-counsel policy version', () => {
    expect(computeRefund(input({ amountMinor: 0 }))).toMatchObject({ eligible: false, blocker: 'nothing_charged' });
    expect(computeRefund(input({ brand: 'goapply', currency: 'CNY', amountMinor: 3900 })).policyVersion).toMatch(/pending-counsel/);
  });
});

describe('computeRefund: statutory withdrawal with the waiver ticked (ST-9, MARKET_STRATEGY §4.4)', () => {
  /** A monthly subscription bought at T0: the paid period is the 30 days from T0. */
  const sub = (over: Partial<RefundInput> = {}): RefundInput =>
    input({ billingCountry: 'DE', withdrawalWaiver: true, periodStart: T0, periodEnd: days(30), now: days(5), ...over });

  it('a German subscriber who ticked the waiver and withdraws on day 5 of 30 is quoted 25/30 of the price', () => {
    const d = computeRefund(sub());
    expect(d).toMatchObject({
      eligible: true,
      rule: 'withdrawal_14d_prorata',
      amountMinor: 2082, // floor(2499 * 25 / 30)
      currency: 'USD',
      blocker: null,
      withdrawalRegion: 'eu',
      prorata: { usedDays: 5, periodDays: 30 },
      endsAccess: true,
    });
    expect(d.deadline).toBe(days(14).toISOString());
    expect(isWithdrawalRule(d.rule)).toBe(true);
    // Use does not change a withdrawal: the same quote after heavy use.
    expect(computeRefund(sub({ paidOnlyCreditsUsed: 40 })).amountMinor).toBe(2082);
  });

  it('the same buyer without the waiver is quoted the full price, and the refund ends the contract too', () => {
    const d = computeRefund(sub({ withdrawalWaiver: false }));
    expect(d).toMatchObject({ eligible: true, rule: 'withdrawal_14d', amountMinor: 2499, prorata: null, endsAccess: true });
  });

  it('a started day counts as used; the purchase instant itself has used nothing', () => {
    expect(computeRefund(sub({ now: T0 }))).toMatchObject({ rule: 'withdrawal_14d_prorata', amountMinor: 2499, prorata: { usedDays: 0, periodDays: 30 } });
    expect(computeRefund(sub({ now: hours(1) }))).toMatchObject({ amountMinor: Math.floor((2499 * 29) / 30), prorata: { usedDays: 1, periodDays: 30 } });
    expect(computeRefund(sub({ now: new Date(days(5).getTime() + 1) }))).toMatchObject({ prorata: { usedDays: 6, periodDays: 30 } });
  });

  it('day 14 is the last moment; day 15 is not eligible under the withdrawal rules', () => {
    expect(computeRefund(sub({ now: days(14) }))).toMatchObject({ eligible: true, rule: 'withdrawal_14d_prorata', amountMinor: Math.floor((2499 * 16) / 30), prorata: { usedDays: 14, periodDays: 30 } });
    const late = computeRefund(sub({ now: new Date(days(14).getTime() + 1) }));
    expect(late).toMatchObject({ eligible: false, rule: 'first_purchase_7d', blocker: 'window_passed', prorata: null, endsAccess: false });
    expect(isWithdrawalRule(computeRefund(sub({ now: days(15) })).rule)).toBe(false);
    expect(isWithdrawalRule(computeRefund(sub({ now: days(15), withdrawalWaiver: false })).rule)).toBe(false);
  });

  it('a weekly plan: pro rata until the period ends, then no withdrawal rule; the deadline is the period end', () => {
    const weekly = (over: Partial<RefundInput>) => sub({ planKey: 'pro_weekly', amountMinor: 999, periodEnd: days(7), ...over });
    const d = computeRefund(weekly({ now: days(3) }));
    expect(d).toMatchObject({ eligible: true, rule: 'withdrawal_14d_prorata', amountMinor: Math.floor((999 * 4) / 7), prorata: { usedDays: 3, periodDays: 7 } });
    expect(d.deadline).toBe(days(7).toISOString());
    // The last started day: the contract can still be ended, nothing is left to return.
    expect(computeRefund(weekly({ now: new Date(days(6).getTime() + 1) }))).toMatchObject({ eligible: true, amountMinor: 0, prorata: { usedDays: 7, periodDays: 7 }, endsAccess: true });
    // At the period end the rule stops (the next charge is a renewal).
    expect(computeRefund(weekly({ now: days(7) }))).toMatchObject({ eligible: false, rule: 'first_purchase_48h' });
  });

  it('a Norwegian, a British and a Taiwanese buyer get the same rule; a US buyer gets none', () => {
    for (const country of ['NO', 'IS', 'LI', 'GB', 'TW', 'FR']) {
      expect(computeRefund(sub({ billingCountry: country })), country).toMatchObject({ rule: 'withdrawal_14d_prorata', amountMinor: 2082 });
    }
    const us = computeRefund(sub({ billingCountry: 'US' }));
    expect(us).toMatchObject({ eligible: true, rule: 'first_purchase_7d', amountMinor: 2499, prorata: null, endsAccess: false, withdrawalRegion: null });
    expect(computeRefund(sub({ billingCountry: null })).rule).toBe('first_purchase_7d');
  });

  it('a renewal never qualifies, with or without the waiver', () => {
    for (const withdrawalWaiver of [true, false]) {
      const d = computeRefund(sub({ chargeKind: 'renewal', withdrawalWaiver, now: days(2) }));
      expect(d).toMatchObject({ eligible: true, rule: 'accidental_renewal_3d', endsAccess: false, prorata: null });
      expect(computeRefund(sub({ chargeKind: 'renewal', withdrawalWaiver })).rule).toBe('accidental_renewal_3d');
    }
  });

  it('a pass with the waiver falls to the 48-hour rule, and a pack to the unused-pack rule', () => {
    const pass = { planKey: 'pro_week_pass', amountMinor: 999, periodStart: T0, periodEnd: days(7) };
    expect(computeRefund(sub({ ...pass, now: hours(47) }))).toMatchObject({ eligible: true, rule: 'first_purchase_48h', amountMinor: 999, endsAccess: false });
    expect(computeRefund(sub({ ...pass, now: days(3) }))).toMatchObject({ eligible: false, rule: 'first_purchase_48h', blocker: 'window_passed' });
    expect(computeRefund(sub({ planKey: 'practice_pack_5', amountMinor: 999, packCreditsUsed: 1 }))).toMatchObject({ eligible: false, rule: 'unused_pack', blocker: 'pack_used' });
    // Without the waiver both are withdrawn in full.
    expect(computeRefund(sub({ ...pass, withdrawalWaiver: false, now: days(3) }))).toMatchObject({ rule: 'withdrawal_14d', amountMinor: 999, endsAccess: true });
  });

  it('applies to every auto-renewing RoboApply plan and to no GoApply plan (its plans are one-time passes)', () => {
    const renewing = PLAN_DEFINITIONS.roboapply.filter((d) => d.autoRenews).map((d) => d.key).sort();
    expect([...PRORATA_WITHDRAWAL_PLANS].sort()).toEqual(renewing);
    expect(PLAN_DEFINITIONS.goapply.some((d) => d.autoRenews)).toBe(false);
    for (const planKey of renewing) expect(computeRefund(sub({ planKey })).rule, planKey).toBe('withdrawal_14d_prorata');
    const go = computeRefund(sub({ brand: 'goapply', currency: 'CNY', amountMinor: 3900 }));
    expect(go.rule).toBe('first_purchase_7d');
    expect(go.policyVersion).toBe(REFUND_POLICY_VERSION.goapply);
  });

  it('needs sane period bounds: missing or inverted bounds leave the old rules in charge', () => {
    expect(computeRefund(sub({ periodStart: null })).rule).toBe('first_purchase_7d');
    expect(computeRefund(sub({ periodEnd: undefined })).rule).toBe('first_purchase_7d');
    expect(computeRefund(sub({ periodStart: days(30), periodEnd: T0 })).rule).toBe('first_purchase_7d');
  });

  it('bounds of a later period are not the paid period: a used-up first week is never quoted a share of the next one', () => {
    // Stripe moves a subscription to its next period before it collects the renewal. Charged on
    // day 0, now day 7 + 2 hours, the subscription already says day 7 to day 14, renewal unpaid.
    const rolled = computeRefund(
      sub({ planKey: 'pro_weekly', amountMinor: 999, now: new Date(days(7).getTime() + 2 * 3_600_000), periodStart: days(7), periodEnd: days(14) }),
    );
    expect(rolled).toMatchObject({ eligible: false, amountMinor: 0, rule: 'first_purchase_48h', blocker: 'window_passed', prorata: null, endsAccess: false });
    expect(isWithdrawalRule(rolled.rule)).toBe(false);
    // The same on every later day of the 14, and for a period that starts just over an hour after the charge.
    for (const day of [8, 10, 13, 14]) {
      expect(computeRefund(sub({ planKey: 'pro_weekly', amountMinor: 999, now: days(day), periodStart: days(7), periodEnd: days(14) })).eligible, `day ${day}`).toBe(false);
    }
    expect(computeRefund(sub({ periodStart: new Date(hours(1).getTime() + 1), periodEnd: days(31) })).rule).toBe('first_purchase_7d');
    // A period that started with the charge, up to an hour either way of the provider's clock, is the paid one.
    expect(computeRefund(sub({ periodStart: hours(1), periodEnd: days(30) })).rule).toBe('withdrawal_14d_prorata');
    expect(computeRefund(sub({ periodStart: hours(-2), periodEnd: days(30) }))).toMatchObject({ rule: 'withdrawal_14d_prorata', prorata: { usedDays: 6, periodDays: 30 } });
    // A charge after the period ended (bounds of an earlier period) is not inside it either.
    expect(computeRefund(sub({ chargedAt: days(4), now: days(5), periodStart: days(-30), periodEnd: days(0) })).rule).toBe('first_purchase_7d');
  });

  it('never refunds more than was charged or a fraction of a minor unit', () => {
    for (let day = 0; day <= 14; day++) {
      for (const amountMinor of [1, 999, 1749, 2499, 5499, 79900]) {
        const d = computeRefund(sub({ amountMinor, now: days(day), planKey: 'pro_quarterly', periodEnd: days(92) }));
        expect(Number.isInteger(d.amountMinor)).toBe(true);
        expect(d.amountMinor).toBeGreaterThanOrEqual(0);
        expect(d.amountMinor).toBeLessThanOrEqual(amountMinor);
      }
    }
  });

  it('the stored policy version names the rule set: v2 on RoboApply, GoApply unchanged', () => {
    expect(REFUND_POLICY_VERSION.roboapply).toBe('refund-v2-2026-10');
    expect(REFUND_POLICY_VERSION.goapply).toBe('refund-v1-2026-10-pending-counsel');
    expect(computeRefund(sub()).policyVersion).toBe('refund-v2-2026-10');
  });
});

// M2 gate: the 14 days run from the PURCHASE. A weekly plan renews on day 7, inside them.
describe('a renewal paid inside the purchase\'s 14 days (`purchasedAt`)', () => {
  const renewal = (over: Partial<RefundInput> = {}) =>
    input({ planKey: 'pro_weekly', amountMinor: 999, billingCountry: 'DE', withdrawalWaiver: true, chargedAt: days(7), purchasedAt: T0, periodStart: days(7), periodEnd: days(14), ...over });

  it('with the waiver: the unused days of the running week, until day 14 of the purchase', () => {
    const d = computeRefund(renewal({ now: days(10) }));
    expect(d).toMatchObject({ eligible: true, rule: 'withdrawal_14d_prorata', amountMinor: Math.floor((999 * 4) / 7), prorata: { usedDays: 3, periodDays: 7 }, endsAccess: true });
    expect(d.deadline).toBe(days(14).toISOString());
    expect(isWithdrawalRule(computeRefund(renewal({ now: new Date(days(14).getTime() + 1) })).rule)).toBe(false);
  });

  it('a monthly plan is unaffected: its 14 days end before its first renewal, and without `purchasedAt` the window runs from the charge', () => {
    // A third week (charged on day 14) is outside the purchase's 14 days.
    expect(isWithdrawalRule(computeRefund(renewal({ chargedAt: days(14), periodStart: days(14), periodEnd: days(21), now: days(15) })).rule)).toBe(false);
    // The same charge described as a purchase of its own would be inside its own window: only `purchasedAt` says otherwise.
    expect(computeRefund(renewal({ purchasedAt: null, chargedAt: days(14), periodStart: days(14), periodEnd: days(21), now: days(15) })).rule).toBe('withdrawal_14d_prorata');
  });

  it('without the waiver the full amount handed in, with the purchase\'s deadline', () => {
    const d = computeRefund(renewal({ withdrawalWaiver: false, chargedAt: T0, purchasedAt: null, amountMinor: 1998, now: days(10) }));
    expect(d).toMatchObject({ eligible: true, rule: 'withdrawal_14d', amountMinor: 1998 });
    expect(d.deadline).toBe(days(14).toISOString());
  });
});

describe('paidOnlyCreditsUsed', () => {
  it('counts units above the Free cap per window only', () => {
    const used = paidOnlyCreditsUsed(
      [
        { bucket: 'tailor', windowKey: 'd:2026-10-01', units: 3 },
        { bucket: 'tailor', windowKey: 'd:2026-10-01', units: 2 },
        { bucket: 'tailor', windowKey: 'd:2026-10-02', units: 1 },
        { bucket: 'assistant', windowKey: 'd:2026-10-01', units: 31 },
        { bucket: 'unknown', windowKey: 'd:2026-10-01', units: 9 },
      ],
      { tailor: 2, assistant: 30 },
    );
    expect(used).toBe(3 + 0 + 1);
  });
});

describe('withdrawal regions', () => {
  it.each([
    ['DE', 'eu'],
    ['no', 'eu'],
    ['GB', 'uk'],
    ['TW', 'tw'],
    ['US', null],
    ['CN', null],
    [null, null],
  ])('%s → %s', (country, region) => {
    expect(withdrawalRegion(country)).toBe(region);
    expect(showsWithdrawalWaiver(country)).toBe(region !== null);
  });
});
