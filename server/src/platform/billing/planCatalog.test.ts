// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { logger } from '../../services/LoggerService.js';
import {
  GOAPPLY_DEFAULT_PRICE_FEN,
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
  studentDiscountPercent,
} from './planCatalog.js';
import { buildPlanViews } from './planViews.js';

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

  it('gives GoApply passes and packs only (no auto-renew, no weekly subscription)', () => {
    const cn = PLAN_DEFINITIONS.goapply;
    expect(cn.map((p) => p.key)).toEqual(['free', 'pro_week_pass', 'pro_monthly', 'pro_quarterly', 'practice_pack_5', 'practice_pack_15', 'student_monthly', 'student_quarterly']);
    expect(cn.every((p) => !p.autoRenews)).toBe(true);
    expect(cn.every((p) => p.kind === 'free' || p.kind === 'pass' || p.kind === 'pack')).toBe(true);
    // The one intended difference between the two catalogs (MARKET_STRATEGY M-24): no renewing weekly plan.
    const intl = PLAN_DEFINITIONS.roboapply.map((p) => p.key);
    expect(intl.filter((k) => !cn.some((p) => p.key === k))).toEqual(['pro_weekly']);
    expect(cn.filter((p) => !intl.includes(p.key))).toEqual([]);
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

describe('RoboApply prices come from env (unchanged in the parity wave)', () => {
  it('marks every paid RoboApply plan unsellable when nothing is configured', () => {
    const plans = getPlanCatalog('roboapply', {});
    for (const p of plans) {
      expect(p.sellable, p.key).toBe(false);
      if (p.kind !== 'free') {
        expect(p.amountMinor).toBeNull();
        expect(p.unsellableReason).toBe('price_unset');
      }
    }
    expect(defaultSelection('roboapply', {})).toBeNull();
    expect(hasSellableProPlan('roboapply', {})).toBe(false);
  });

  it('needs both the Stripe price id and the display amount on RoboApply', () => {
    expect(getPlan('roboapply', 'pro_monthly', { STRIPE_PRICE_PRO_MONTHLY: 'price_m' })!.sellable).toBe(false);
    expect(getPlan('roboapply', 'pro_monthly', { STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499' })!.sellable).toBe(false);
    const m = getPlan('roboapply', 'pro_monthly', INTL_ENV)!;
    expect(m).toMatchObject({ sellable: true, amountMinor: 2499, stripePriceId: 'price_m', currency: 'USD', requiresAutoRenewAck: true });
    expect(getPlan('roboapply', 'pro_monthly', { ...INTL_ENV, STRIPE_PRICE_PRO_MONTHLY_CENTS: '24.99' })!.sellable).toBe(false);
  });

  it('never reads a GoApply variable: CN prices and the CN kill switch change nothing on RoboApply', () => {
    const base = getPlanCatalog('roboapply', INTL_ENV);
    expect(getPlanCatalog('roboapply', { ...INTL_ENV, CN_PAYMENTS_ENABLED: 'false', CN_PRICE_PRO_MONTHLY_FEN: '4900' })).toEqual(base);
  });

  it('documents the env names per brand', () => {
    expect(priceEnvNames('roboapply', 'pro_week_pass')).toEqual(['STRIPE_PRICE_PRO_WEEK_PASS', 'STRIPE_PRICE_PRO_WEEK_PASS_CENTS']);
    // GoApply: the optional override only. CN_PAYMENTS_ENABLED is the kill switch, not a price variable.
    expect(priceEnvNames('goapply', 'pro_monthly')).toEqual(['CN_PRICE_PRO_MONTHLY_FEN']);
  });

  it('maps a Stripe price id back to its plan', () => {
    expect(planKeyForStripePrice('price_q', INTL_ENV)).toBe('pro_quarterly');
    expect(planKeyForStripePrice('unknown', INTL_ENV)).toBeNull();
  });
});

describe('GoApply prices are catalog defaults in fen (D5, D6; MARKET_STRATEGY §4.2)', () => {
  const DEFAULTS = {
    pro_week_pass: 1200,
    pro_monthly: 3900,
    pro_quarterly: 9900,
    practice_pack_5: 2900,
    practice_pack_15: 7900,
    student_monthly: 2900,
    student_quarterly: 6900,
  } as const;

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('carries the table of the market strategy, one whole-yuan amount per paid plan', () => {
    expect(GOAPPLY_DEFAULT_PRICE_FEN).toEqual(DEFAULTS);
    for (const def of PLAN_DEFINITIONS.goapply) {
      if (def.kind === 'free') continue;
      const fen = GOAPPLY_DEFAULT_PRICE_FEN[def.key];
      expect(fen, def.key).toBeGreaterThan(0);
      expect(fen! % 100, def.key).toBe(0);
    }
    // No default for a key GoApply does not define.
    expect(Object.keys(GOAPPLY_DEFAULT_PRICE_FEN).sort()).toEqual(PLAN_DEFINITIONS.goapply.filter((d) => d.kind !== 'free').map((d) => d.key).sort());
  });

  it('with an empty env every GoApply paid plan is sellable at its default amount, and none is price_unset', () => {
    const plans = getPlanCatalog('goapply', {});
    for (const p of plans) {
      if (p.kind === 'free') {
        expect(p).toMatchObject({ sellable: false, unsellableReason: 'free', amountMinor: 0 });
        continue;
      }
      expect(p, p.key).toMatchObject({ sellable: true, unsellableReason: null, amountMinor: DEFAULTS[p.key as keyof typeof DEFAULTS], currency: 'CNY', stripePriceId: null, twdPrice: null, requiresAutoRenewAck: false });
    }
    expect(plans.filter((p) => p.kind !== 'free')).toHaveLength(7);
    expect(plans.some((p) => p.unsellableReason === 'price_unset')).toBe(false);
    expect(defaultSelection('goapply', {})).toBe('pro_monthly');
    expect(hasSellableProPlan('goapply', {})).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('CN_PRICE_<KEY>_FEN overrides one plan when it is a positive multiple of 100', () => {
    const plans = getPlanCatalog('goapply', { CN_PRICE_PRO_MONTHLY_FEN: ' 4900 ' });
    expect(plans.find((p) => p.key === 'pro_monthly')).toMatchObject({ amountMinor: 4900, sellable: true });
    // Only that plan moved.
    for (const p of plans) if (p.kind !== 'free' && p.key !== 'pro_monthly') expect(p.amountMinor, p.key).toBe(DEFAULTS[p.key as keyof typeof DEFAULTS]);
    expect(getPlan('goapply', 'student_quarterly', { CN_PRICE_STUDENT_QUARTERLY_FEN: '5900' })!.amountMinor).toBe(5900);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['3990', 'not whole yuan'],
    ['39', 'yuan, not fen'],
    ['0', 'zero'],
    ['-3900', 'negative'],
    ['39.00', 'a decimal'],
    ['¥39', 'a currency sign'],
    ['free', 'a word'],
  ])('ignores the override %s (%s), keeps the default and says so once', (value) => {
    const env = { CN_PRICE_PRO_MONTHLY_FEN: value };
    const plan = getPlan('goapply', 'pro_monthly', env)!;
    expect(plan).toMatchObject({ amountMinor: 3900, sellable: true, unsellableReason: null });
    // Read again (the catalog is read on every request): still one line.
    getPlanCatalog('goapply', env);
    getPlanCatalog('goapply', env);
    const calls = vi.mocked(logger.warn).mock.calls.filter((c) => (c[2] as { variable?: string } | undefined)?.variable === 'CN_PRICE_PRO_MONTHLY_FEN' && (c[2] as { value?: string }).value === value);
    expect(calls.length).toBeLessThanOrEqual(1);
    expect(vi.mocked(logger.warn).mock.calls.every((c) => (c[2] as { variable?: string }).variable === 'CN_PRICE_PRO_MONTHLY_FEN')).toBe(true);
  });

  it('logs an ignored override the first time it is seen, naming the variable', () => {
    const env = { CN_PRICE_PRACTICE_PACK_15_FEN: '7990' };
    expect(getPlan('goapply', 'practice_pack_15', env)!.amountMinor).toBe(7900);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('RA_BILLING', expect.stringContaining('ignored price override'), { variable: 'CN_PRICE_PRACTICE_PACK_15_FEN', value: '7990' });
    getPlan('goapply', 'practice_pack_15', env);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // A blank override is simply "unset": no log.
    getPlan('goapply', 'practice_pack_15', { CN_PRICE_PRACTICE_PACK_15_FEN: '  ' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it.each(['false', '0', 'off', 'no', 'FALSE', ' Off '])('CN_PAYMENTS_ENABLED=%s is the kill switch: every plan unsellable, prices still shown', (value) => {
    const plans = getPlanCatalog('goapply', { CN_PAYMENTS_ENABLED: value });
    for (const p of plans) {
      if (p.kind === 'free') continue;
      expect(p, p.key).toMatchObject({ sellable: false, unsellableReason: 'payments_disabled', amountMinor: DEFAULTS[p.key as keyof typeof DEFAULTS] });
    }
    expect(defaultSelection('goapply', { CN_PAYMENTS_ENABLED: value })).toBeNull();
    expect(hasSellableProPlan('goapply', { CN_PAYMENTS_ENABLED: value })).toBe(false);
  });

  it.each([undefined, '', '  ', 'true', '1', 'on', 'yes'])('CN_PAYMENTS_ENABLED=%s is not the kill switch: plans are on sale', (value) => {
    const env = value === undefined ? {} : { CN_PAYMENTS_ENABLED: value };
    expect(getPlan('goapply', 'pro_monthly', env)).toMatchObject({ sellable: true, unsellableReason: null, amountMinor: 3900 });
  });

  it('no GoApply plan is ever price_unset, whatever the env says', () => {
    const envs = [{}, { CN_PAYMENTS_ENABLED: 'false' }, { CN_PRICE_PRO_MONTHLY_FEN: '' }, { CN_PRICE_PRO_MONTHLY_FEN: '1' }, { CN_PRICE_PRO_QUARTERLY_FEN: 'abc', CN_PAYMENTS_ENABLED: '0' }];
    for (const env of envs) {
      for (const p of getPlanCatalog('goapply', env)) {
        expect(p.unsellableReason, `${p.key} ${JSON.stringify(env)}`).not.toBe('price_unset');
        expect(p.amountMinor, p.key).not.toBeNull();
      }
    }
  });
});

describe('GoApply student passes (MARKET_STRATEGY PC-2)', () => {
  it('are passes of 30 and 90 days behind the student flag, never preselected, with the practice credits of the matching pass', () => {
    const cn = PLAN_DEFINITIONS.goapply;
    const monthly = cn.find((p) => p.key === 'student_monthly')!;
    const quarterly = cn.find((p) => p.key === 'student_quarterly')!;
    expect(monthly).toMatchObject({ kind: 'pass', interval: 'pass', passDays: 30, autoRenews: false, entitlementProfile: 'pro', requiresFlag: 'student', neverPreselected: true, defaultLabel: '学生月卡' });
    expect(quarterly).toMatchObject({ kind: 'pass', interval: 'pass', passDays: 90, autoRenews: false, entitlementProfile: 'pro', requiresFlag: 'student', neverPreselected: true, defaultLabel: '学生季卡' });
    expect(monthly.practice).toEqual(cn.find((p) => p.key === 'pro_monthly')!.practice);
    expect(quarterly.practice).toEqual(cn.find((p) => p.key === 'pro_quarterly')!.practice);
    expect(entitlementProfileFor({ planKey: 'student_monthly' })).toBe('pro');
    expect(entitlementProfileFor({ planKey: 'student_quarterly' })).toBe('pro');
  });

  it('cost ¥29 and ¥69 by default, and the saving is computed from the catalog amounts: 25 and 30, rounded down', () => {
    const catalog = getPlanCatalog('goapply', {});
    const monthly = catalog.find((p) => p.key === 'student_monthly')!;
    const quarterly = catalog.find((p) => p.key === 'student_quarterly')!;
    expect([monthly.amountMinor, quarterly.amountMinor]).toEqual([2900, 6900]);
    // (3900 − 2900) / 3900 = 25.6 % → 25; (9900 − 6900) / 9900 = 30.3 % → 30.
    expect(studentDiscountPercent(monthly, catalog)).toBe(25);
    expect(studentDiscountPercent(quarterly, catalog)).toBe(30);
    // An override moves the number; it is never a constant.
    const cheaper = getPlanCatalog('goapply', { CN_PRICE_STUDENT_MONTHLY_FEN: '1900' });
    expect(studentDiscountPercent(cheaper.find((p) => p.key === 'student_monthly')!, cheaper)).toBe(51);
    const same = getPlanCatalog('goapply', { CN_PRICE_STUDENT_MONTHLY_FEN: '3900' });
    expect(studentDiscountPercent(same.find((p) => p.key === 'student_monthly')!, same)).toBeNull();
  });

  it('the plan sheet lists them only while the student capability is on, and never as the default', () => {
    const off = buildPlanViews('goapply', { env: {} });
    expect(off.plans.map((p) => p.key)).toEqual(['free', 'pro_week_pass', 'pro_monthly', 'pro_quarterly', 'practice_pack_5', 'practice_pack_15']);
    const on = buildPlanViews('goapply', { env: {}, studentEnabled: true });
    expect(on.plans.map((p) => p.key)).toEqual(['free', 'pro_week_pass', 'pro_monthly', 'pro_quarterly', 'practice_pack_5', 'practice_pack_15', 'student_monthly', 'student_quarterly']);
    expect(on.defaultSelection).toBe('pro_monthly');
    expect(on.plans.find((p) => p.key === 'student_monthly')).toMatchObject({ amountMinor: 2900, sellable: true, studentDiscountPercent: 25, promotionCodes: false, isDefaultSelection: false });
    expect(on.plans.find((p) => p.key === 'student_quarterly')).toMatchObject({ amountMinor: 6900, sellable: true, studentDiscountPercent: 30, promotionCodes: false });
    // Regular plans carry no student number.
    expect(on.plans.find((p) => p.key === 'pro_monthly')!.studentDiscountPercent).toBeNull();
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
    // GoApply, catalog defaults (no env): ¥99 vs 3 × ¥39 = ¥117 → 15.38% → 15 ("省 15%").
    const cnDefault = getPlanCatalog('goapply', {});
    expect(savingsPercent(cnDefault.find((p) => p.key === 'pro_quarterly')!, cnDefault.find((p) => p.key === 'pro_monthly'))).toBe(15);
    const cn = getPlanCatalog('goapply', CN_ENV);
    // The same with the amounts given as overrides.
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
