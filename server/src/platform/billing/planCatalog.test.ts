// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PLAN_DEFINITIONS,
  PLAN_KEYS,
  defaultSelection,
  entitlementProfileFor,
  getPlan,
  getPlanCatalog,
  hasSellableProPlan,
  monthlyEquivalentMinor,
  planKeyForStripePrice,
  priceEnvNames,
  savingsPercent,
} from './planCatalog.js';

const INTL_ENV = {
  STRIPE_PRICE_PRO_WEEKLY: 'price_w',
  STRIPE_PRICE_PRO_WEEKLY_CENTS: '999',
  STRIPE_PRICE_PRO_MONTHLY: 'price_m',
  STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499',
  STRIPE_PRICE_PRO_QUARTERLY: 'price_q',
  STRIPE_PRICE_PRO_QUARTERLY_CENTS: '5999',
};

const CN_ENV = {
  CN_PRICE_PRO_WEEK_PASS_FEN: '1200',
  CN_PRICE_PRO_MONTHLY_FEN: '3900',
  CN_PRICE_PRO_QUARTERLY_FEN: '9900',
};

describe('plan keys (R-08)', () => {
  it('lists the canonical keys', () => {
    expect(PLAN_KEYS).toEqual([
      'free',
      'pro_weekly',
      'pro_monthly',
      'pro_quarterly',
      'pro_week_pass',
      'practice_pack_5',
      'practice_pack_15',
      'student_monthly',
      'student_quarterly',
    ]);
  });

  it('gives GoApply passes only (no auto-renew, no weekly subscription)', () => {
    const cn = PLAN_DEFINITIONS.goapply;
    expect(cn.map((p) => p.key)).toEqual(['free', 'pro_week_pass', 'pro_monthly', 'pro_quarterly', 'practice_pack_5', 'practice_pack_15']);
    expect(cn.every((p) => !p.autoRenews)).toBe(true);
  });

  it('uses distinct names for the weekly plan and the 7-day pass', () => {
    const intl = PLAN_DEFINITIONS.roboapply;
    const weekly = intl.find((p) => p.key === 'pro_weekly')!;
    const pass = intl.find((p) => p.key === 'pro_week_pass')!;
    expect(weekly.defaultLabel).toBe('Pro, billed weekly (renews until you cancel)');
    expect(pass.defaultLabel).toBe('7-day pass (no renewal)');
    expect(weekly.labelKey).toBe('billing.plans.pro_weekly.name');
  });
});

describe('prices come from env, never from code', () => {
  it('marks every paid plan unsellable when nothing is configured', () => {
    for (const brand of ['roboapply', 'goapply'] as const) {
      const plans = getPlanCatalog(brand, {});
      for (const p of plans) {
        expect(p.sellable, `${brand}.${p.key}`).toBe(false);
        if (p.kind !== 'free') {
          expect(p.amountMinor).toBeNull();
          expect(p.unsellableReason).toBe('price_unset');
        }
      }
      expect(defaultSelection(brand, {})).toBeNull();
      expect(hasSellableProPlan(brand, {})).toBe(false);
    }
  });

  it('needs both the Stripe price id and the display amount on RoboApply', () => {
    expect(getPlan('roboapply', 'pro_monthly', { STRIPE_PRICE_PRO_MONTHLY: 'price_m' })!.sellable).toBe(false);
    expect(getPlan('roboapply', 'pro_monthly', { STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499' })!.sellable).toBe(false);
    const m = getPlan('roboapply', 'pro_monthly', INTL_ENV)!;
    expect(m).toMatchObject({ sellable: true, amountMinor: 2499, stripePriceId: 'price_m', currency: 'USD', requiresAutoRenewAck: true });
    expect(getPlan('roboapply', 'pro_monthly', { ...INTL_ENV, STRIPE_PRICE_PRO_MONTHLY_CENTS: '24.99' })!.sellable).toBe(false);
  });

  it('keeps GoApply unsellable until CN_PAYMENTS_ENABLED (R-15) but shows the fee schedule', () => {
    const off = getPlan('goapply', 'pro_monthly', CN_ENV)!;
    expect(off).toMatchObject({ sellable: false, unsellableReason: 'payments_disabled', amountMinor: 3900, currency: 'CNY' });
    const on = getPlan('goapply', 'pro_monthly', { ...CN_ENV, CN_PAYMENTS_ENABLED: 'true' })!;
    expect(on).toMatchObject({ sellable: true, unsellableReason: null, requiresAutoRenewAck: false });
    expect(hasSellableProPlan('goapply', { ...CN_ENV, CN_PAYMENTS_ENABLED: 'true' })).toBe(true);
  });

  it('documents the env names per brand', () => {
    expect(priceEnvNames('roboapply', 'pro_week_pass')).toEqual(['STRIPE_PRICE_PRO_WEEK_PASS', 'STRIPE_PRICE_PRO_WEEK_PASS_CENTS']);
    expect(priceEnvNames('goapply', 'pro_monthly')).toEqual(['CN_PRICE_PRO_MONTHLY_FEN', 'CN_PAYMENTS_ENABLED']);
  });

  it('maps a Stripe price id back to its plan', () => {
    expect(planKeyForStripePrice('price_q', INTL_ENV)).toBe('pro_quarterly');
    expect(planKeyForStripePrice('unknown', INTL_ENV)).toBeNull();
  });
});

describe('default selection (H24)', () => {
  it('preselects monthly and never a weekly plan or pass', () => {
    expect(defaultSelection('roboapply', INTL_ENV)).toBe('pro_monthly');
    const onlyWeekly = { STRIPE_PRICE_PRO_WEEKLY: 'w', STRIPE_PRICE_PRO_WEEKLY_CENTS: '999', STRIPE_PRICE_PRO_WEEK_PASS: 'p', STRIPE_PRICE_PRO_WEEK_PASS_CENTS: '699' };
    expect(defaultSelection('roboapply', onlyWeekly)).toBeNull();
    const plans = getPlanCatalog('roboapply', onlyWeekly);
    expect(plans.filter((p) => p.isDefaultSelection)).toEqual([]);
    expect(PLAN_DEFINITIONS.roboapply.filter((p) => p.interval === 'week' || p.kind === 'pass').every((p) => p.neverPreselected)).toBe(true);
  });
});

describe('computed numbers (PRODUCT §6.1 rule 2)', () => {
  it('computes "Save N%" from our own monthly price, rounded down', () => {
    const plans = getPlanCatalog('roboapply', INTL_ENV);
    const monthly = plans.find((p) => p.key === 'pro_monthly')!;
    const quarterly = plans.find((p) => p.key === 'pro_quarterly')!;
    // 5999 vs 3 × 2499 = 7497 → 19.98% → 19 (never overstated).
    expect(savingsPercent(quarterly, monthly)).toBe(19);
    expect(savingsPercent(monthly, monthly)).toBeNull();
    const cn = getPlanCatalog('goapply', CN_ENV);
    // ¥99 vs 3 × ¥39 = ¥117 → 15.38% → 15.
    expect(savingsPercent(cn.find((p) => p.key === 'pro_quarterly')!, cn.find((p) => p.key === 'pro_monthly'))).toBe(15);
    expect(savingsPercent(quarterly, null)).toBeNull();
  });

  it('computes the weekly monthly equivalent', () => {
    const weekly = getPlan('roboapply', 'pro_weekly', INTL_ENV)!;
    expect(monthlyEquivalentMinor(weekly)).toBe(4329); // about $43 a month
    expect(monthlyEquivalentMinor(getPlan('roboapply', 'pro_monthly', INTL_ENV)!)).toBeNull();
  });
});

describe('entitlementProfileFor', () => {
  it('maps plan keys and grandfathers legacy tiers to Free', () => {
    expect(entitlementProfileFor({ planKey: 'pro_monthly' })).toBe('pro');
    expect(entitlementProfileFor({ planKey: 'pro_week_pass' })).toBe('pro');
    expect(entitlementProfileFor({ planKey: 'practice_pack_5' })).toBe('free');
    expect(entitlementProfileFor({ planKey: 'free' })).toBe('free');
    expect(entitlementProfileFor({ planKey: null, tier: 'pro' })).toBe('pro');
    expect(entitlementProfileFor({ planKey: 'starter', tier: 'starter' })).toBe('free');
    expect(entitlementProfileFor({ planKey: null, tier: 'growth' })).toBe('free');
  });
});
