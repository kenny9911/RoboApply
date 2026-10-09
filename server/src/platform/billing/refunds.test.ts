// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { computeRefund, paidOnlyCreditsUsed, type RefundInput } from './refunds.js';
import { showsWithdrawalWaiver, withdrawalRegion } from './acknowledgements.js';

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

  it('with the waiver ticked, EU falls back to the standard policy', () => {
    const d = computeRefund(input({ billingCountry: 'FR', withdrawalWaiver: true, now: days(10) }));
    expect(d).toMatchObject({ eligible: false, rule: 'first_purchase_7d', blocker: 'window_passed' });
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
