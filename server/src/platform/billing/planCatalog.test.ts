// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { logger } from '../../services/LoggerService.js';
import {
  GOAPPLY_DEFAULT_PRICE_FEN,
  ROBOAPPLY_DEFAULT_PRICE_USD_CENTS,
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
  resetPlanCatalogReportsForTests,
  savingsPercent,
  studentDiscountPercent,
  twdPriceEnvNames,
  twdPriceFor,
  type PlanKey,
} from './planCatalog.js';
import { buildPlanViews } from './planViews.js';
import { STRIPE_WEBHOOK_TRIES_EVERY_SECRET } from './stripeEnv.js';

/** The Stripe rail is ready: a usable key and a webhook secret (ST-0). Nothing else is needed to sell. */
const READY = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test' };

/** The older pair per plan: a pinned price id and its amount (still honoured). */
const INTL_ENV = {
  ...READY,
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

describe('RoboApply prices are catalog defaults in USD cents (D6; MARKET_STRATEGY §4.1, §4.3)', () => {
  const DEFAULTS = {
    pro_weekly: 999,
    pro_monthly: 2499,
    pro_quarterly: 5499,
    pro_week_pass: 999,
    practice_pack_5: 999,
    practice_pack_15: 2499,
    student_monthly: 1749,
    student_quarterly: 3799,
  } as const;
  const warnsFor = (variable: string) => vi.mocked(logger.warn).mock.calls.filter((c) => (c[2] as { variable?: string } | undefined)?.variable === variable);

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('carries the table of the market strategy, one amount per paid plan', () => {
    expect(ROBOAPPLY_DEFAULT_PRICE_USD_CENTS).toEqual(DEFAULTS);
    expect(Object.keys(ROBOAPPLY_DEFAULT_PRICE_USD_CENTS).sort()).toEqual(PLAN_DEFINITIONS.roboapply.filter((d) => d.kind !== 'free').map((d) => d.key).sort());
  });

  it('with an empty env every paid plan lists its default amount; none is price_unset; nothing is on sale without the rail', () => {
    const plans = getPlanCatalog('roboapply', {});
    for (const p of plans) {
      if (p.kind === 'free') {
        expect(p).toMatchObject({ sellable: false, unsellableReason: 'free', amountMinor: 0 });
        continue;
      }
      expect(p, p.key).toMatchObject({
        amountMinor: DEFAULTS[p.key as keyof typeof DEFAULTS],
        currency: 'USD',
        stripePriceId: null,
        twdPrice: null,
        sellable: false,
        unsellableReason: 'payments_disabled',
      });
    }
    expect(plans.filter((p) => p.kind !== 'free')).toHaveLength(8);
    expect(plans.some((p) => p.unsellableReason === 'price_unset')).toBe(false);
    expect(defaultSelection('roboapply', {})).toBeNull();
    expect(hasSellableProPlan('roboapply', {})).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('with a Stripe key and a webhook secret and no price variable every plan is sellable with no price id', () => {
    const plans = getPlanCatalog('roboapply', READY);
    for (const p of plans.filter((x) => x.kind !== 'free')) {
      expect(p, p.key).toMatchObject({ sellable: true, unsellableReason: null, amountMinor: DEFAULTS[p.key as keyof typeof DEFAULTS], stripePriceId: null, requiresAutoRenewAck: p.autoRenews });
    }
    expect(plans.filter((p) => p.phase === 'mvp' && p.kind !== 'free').map((p) => p.key)).toEqual(['pro_weekly', 'pro_monthly', 'pro_quarterly', 'pro_week_pass', 'practice_pack_5', 'practice_pack_15']);
    expect(defaultSelection('roboapply', READY)).toBe('pro_monthly');
    expect(hasSellableProPlan('roboapply', READY)).toBe(true);
    expect(getPlan('roboapply', 'pro_monthly', { STRIPE_SECRET_KEY: 'sk_test_x', ROBOAPPLY_STRIPE_WEBHOOK_SECRET: 'whsec_a' })!.sellable).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['the key alone (no webhook secret)', { STRIPE_SECRET_KEY: 'sk_test_x' }],
    ['a webhook secret alone', { STRIPE_WEBHOOK_SECRET: 'whsec_test' }],
    ['a live key outside production', { STRIPE_SECRET_KEY: 'sk_live_example', STRIPE_WEBHOOK_SECRET: 'whsec_test' }],
    ['a live key on a preview deployment', { STRIPE_SECRET_KEY: 'sk_live_example', STRIPE_WEBHOOK_SECRET: 'whsec_test', VERCEL_ENV: 'preview' }],
    // The guard fails closed on a key it does not recognise.
    ['a key that is not a test key, outside production', { STRIPE_SECRET_KEY: 'sk_org_live_abc', STRIPE_WEBHOOK_SECRET: 'whsec_test' }],
  ])('with %s every plan lists its amount with payments_disabled', (_name, env) => {
    for (const p of getPlanCatalog('roboapply', env).filter((x) => x.kind !== 'free')) {
      expect(p, p.key).toMatchObject({ sellable: false, unsellableReason: 'payments_disabled', amountMinor: DEFAULTS[p.key as keyof typeof DEFAULTS] });
    }
    expect(hasSellableProPlan('roboapply', env)).toBe(false);
  });

  it('a list of webhook secrets sells only once the webhook route tries each one (stripeEnv.ts STRIPE_WEBHOOK_TRIES_EVERY_SECRET)', () => {
    // Until then the route verifies with the one string it reads: a list would open a rail that never fulfils.
    const env = { STRIPE_SECRET_KEY: 'sk_test_x', ROBOAPPLY_STRIPE_WEBHOOK_SECRET: 'whsec_a,whsec_b' };
    for (const p of getPlanCatalog('roboapply', env).filter((x) => x.kind !== 'free')) {
      expect(p, p.key).toMatchObject({
        sellable: STRIPE_WEBHOOK_TRIES_EVERY_SECRET,
        unsellableReason: STRIPE_WEBHOOK_TRIES_EVERY_SECRET ? null : 'payments_disabled',
        amountMinor: DEFAULTS[p.key as keyof typeof DEFAULTS],
      });
    }
    expect(hasSellableProPlan('roboapply', env)).toBe(STRIPE_WEBHOOK_TRIES_EVERY_SECRET);
  });

  it('says once why the rail is closed when a key is set and the webhook secret is the problem; names variables, never values', () => {
    const closed = (reason: string) => vi.mocked(logger.warn).mock.calls.filter((c) => typeof c[1] === 'string' && c[1].startsWith('Stripe payments are closed') && c[1].includes(reason));
    resetPlanCatalogReportsForTests();
    // No key at all is the normal state of a machine that does not sell: not a word.
    getPlanCatalog('roboapply', {});
    getPlanCatalog('roboapply', { STRIPE_WEBHOOK_SECRET: 'whsec_test' });
    // A refused live key is reported by the client factory, not here.
    getPlanCatalog('roboapply', { STRIPE_SECRET_KEY: 'sk_live_example', STRIPE_WEBHOOK_SECRET: 'whsec_test' });
    expect(logger.warn).not.toHaveBeenCalled();
    // A key without a secret, and a key with a list: one line each, however often the catalog is read.
    for (let i = 0; i < 3; i++) {
      getPlanCatalog('roboapply', { STRIPE_SECRET_KEY: 'sk_test_secretvalue' });
      getPlanCatalog('roboapply', { STRIPE_SECRET_KEY: 'sk_test_secretvalue', STRIPE_WEBHOOK_SECRET: 'whsec_one,whsec_two' });
    }
    expect(closed('without a webhook secret')).toHaveLength(1);
    expect(closed('without a webhook secret')[0]![2]).toEqual({ needs: 'STRIPE_WEBHOOK_SECRET' });
    // The list is a reason only while the webhook route verifies with one secret.
    expect(closed('one secret')).toHaveLength(STRIPE_WEBHOOK_TRIES_EVERY_SECRET ? 0 : 1);
    for (const c of closed('one secret')) expect(c[2]).toEqual({ variables: ['ROBOAPPLY_STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET'] });
    expect(logger.warn).toHaveBeenCalledTimes(STRIPE_WEBHOOK_TRIES_EVERY_SECRET ? 1 : 2);
    const lines = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    for (const secret of ['sk_test_secretvalue', 'whsec_one', 'whsec_two']) expect(lines).not.toContain(secret);
    // GoApply never reports on Stripe.
    vi.mocked(logger.warn).mockClear();
    getPlanCatalog('goapply', { STRIPE_SECRET_KEY: 'sk_test_x' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a live key sells in production, and outside it only with the explicit override', () => {
    const live = { STRIPE_SECRET_KEY: 'sk_live_example', STRIPE_WEBHOOK_SECRET: 'whsec_test' };
    expect(getPlan('roboapply', 'pro_monthly', { ...live, VERCEL_ENV: 'production' })!.sellable).toBe(true);
    expect(getPlan('roboapply', 'pro_monthly', { ...live, STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION: 'true' })!.sellable).toBe(true);
  });

  it('PRICE_<KEY>_USD_CENTS wins over the alias STRIPE_PRICE_<KEY>_CENTS, which wins over the default', () => {
    expect(getPlan('roboapply', 'pro_monthly', READY)!.amountMinor).toBe(2499);
    expect(getPlan('roboapply', 'pro_monthly', { ...READY, STRIPE_PRICE_PRO_MONTHLY_CENTS: '2399' })!.amountMinor).toBe(2399);
    expect(getPlan('roboapply', 'pro_monthly', { ...READY, PRICE_PRO_MONTHLY_USD_CENTS: ' 2999 ' })!.amountMinor).toBe(2999);
    expect(getPlan('roboapply', 'pro_monthly', { ...READY, PRICE_PRO_MONTHLY_USD_CENTS: '2999', STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499' })!.amountMinor).toBe(2999);
    // Only that plan moved, and the override does not need the rail to be listed.
    const plans = getPlanCatalog('roboapply', { PRICE_PRACTICE_PACK_15_USD_CENTS: '2799' });
    for (const p of plans) if (p.kind !== 'free') expect(p.amountMinor, p.key).toBe(p.key === 'practice_pack_15' ? 2799 : DEFAULTS[p.key as keyof typeof DEFAULTS]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['24.99', 'a decimal'],
    ['0', 'zero'],
    ['-2499', 'negative'],
    ['$25', 'a currency sign'],
    ['free', 'a word'],
  ])('ignores the override %s (%s), falls through to the next source and says so once', (value) => {
    const name = 'PRICE_PRO_QUARTERLY_USD_CENTS';
    const env = { ...READY, [name]: value };
    expect(getPlan('roboapply', 'pro_quarterly', env)).toMatchObject({ amountMinor: 5499, sellable: true, unsellableReason: null });
    // The alias is the next source.
    expect(getPlan('roboapply', 'pro_quarterly', { ...env, STRIPE_PRICE_PRO_QUARTERLY_CENTS: '5999' })!.amountMinor).toBe(5999);
    getPlanCatalog('roboapply', env);
    const calls = warnsFor(name).filter((c) => (c[2] as { value?: string }).value === value);
    expect(calls.length).toBeLessThanOrEqual(1);
    for (const c of calls) expect(c[1]).toContain('ignored price override');
  });

  it('a pin is honoured only together with an amount variable (either name)', () => {
    // The older pair, exactly as deployments set it: both the id and the amount.
    expect(getPlan('roboapply', 'pro_monthly', INTL_ENV)).toMatchObject({ sellable: true, amountMinor: 2499, stripePriceId: 'price_m', currency: 'USD', requiresAutoRenewAck: true });
    expect(getPlan('roboapply', 'pro_quarterly', INTL_ENV)).toMatchObject({ amountMinor: 5999, stripePriceId: 'price_q' });
    // The new amount name next to a pin.
    expect(getPlan('roboapply', 'pro_weekly', { ...READY, STRIPE_PRICE_PRO_WEEKLY: ' price_w2 ', PRICE_PRO_WEEKLY_USD_CENTS: '1099' })).toMatchObject({ amountMinor: 1099, stripePriceId: 'price_w2' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a pin next to two amount variables that differ is ignored: the amount shown is always the amount charged', () => {
    // The older pair (pin + its amount), then the price changed with the new name and the pair left in place.
    const env = { ...READY, PRICE_PRO_MONTHLY_USD_CENTS: '1999', STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499', STRIPE_PRICE_PRO_MONTHLY: 'price_old_2499' };
    // The amount in force is the new name's; the pin was set with the other amount, so it does not stand.
    expect(getPlan('roboapply', 'pro_monthly', env)).toMatchObject({ amountMinor: 1999, stripePriceId: null, sellable: true });
    expect(planKeyForStripePrice('price_old_2499', env)).toBeNull();
    getPlanCatalog('roboapply', env);
    getPlanCatalog('roboapply', { ...env, STRIPE_PRICE_PRO_MONTHLY: 'price_another' });
    const calls = warnsFor('STRIPE_PRICE_PRO_MONTHLY');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toContain('ignored Stripe price pin');
    expect(calls[0]![2]).toEqual({ variable: 'STRIPE_PRICE_PRO_MONTHLY', amount: 'PRICE_PRO_MONTHLY_USD_CENTS', alias: 'STRIPE_PRICE_PRO_MONTHLY_CENTS' });
    // Neither the price id nor an amount is logged.
    expect(JSON.stringify(calls[0])).not.toContain('price_old_2499');
    // Other plans of the same env keep their own pins.
    expect(getPlan('roboapply', 'pro_quarterly', { ...INTL_ENV, ...env })).toMatchObject({ amountMinor: 5999, stripePriceId: 'price_q' });
    vi.mocked(logger.warn).mockClear();
    // Two amount variables that agree: the pin stands.
    expect(getPlan('roboapply', 'pro_monthly', { ...env, PRICE_PRO_MONTHLY_USD_CENTS: '2499' })).toMatchObject({ amountMinor: 2499, stripePriceId: 'price_old_2499' });
    // One valid amount next to an invalid one: there is one amount, the pin stands (the invalid value is reported on its own).
    expect(getPlan('roboapply', 'pro_weekly', { ...READY, PRICE_PRO_WEEKLY_USD_CENTS: '1099', STRIPE_PRICE_PRO_WEEKLY_CENTS: '10.99', STRIPE_PRICE_PRO_WEEKLY: 'price_w3' })).toMatchObject({ amountMinor: 1099, stripePriceId: 'price_w3' });
    expect(warnsFor('STRIPE_PRICE_PRO_WEEKLY')).toHaveLength(0);
    expect(warnsFor('STRIPE_PRICE_PRO_WEEKLY_CENTS')).toHaveLength(1);
  });

  it('a pin without an amount variable is ignored and logged once per key: we cannot know it equals the default', () => {
    const env = { ...READY, STRIPE_PRICE_PRACTICE_PACK_5: 'price_pinned_pack' };
    const plan = getPlan('roboapply', 'practice_pack_5', env)!;
    expect(plan).toMatchObject({ amountMinor: 999, stripePriceId: null, sellable: true });
    getPlanCatalog('roboapply', env);
    getPlanCatalog('roboapply', { ...env, STRIPE_PRICE_PRACTICE_PACK_5: 'price_another' });
    const calls = warnsFor('STRIPE_PRICE_PRACTICE_PACK_5');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toContain('ignored Stripe price pin');
    expect(calls[0]![2]).toEqual({ variable: 'STRIPE_PRICE_PRACTICE_PACK_5', needs: 'PRICE_PRACTICE_PACK_5_USD_CENTS' });
    // The price id itself is never logged.
    expect(JSON.stringify(calls[0])).not.toContain('price_pinned_pack');
    // An invalid amount next to the pin is no amount: the pin stays ignored.
    expect(getPlan('roboapply', 'practice_pack_5', { ...env, PRICE_PRACTICE_PACK_5_USD_CENTS: '9.99' })!.stripePriceId).toBeNull();
  });

  it('never reads a GoApply variable: CN prices and the CN kill switch change nothing on RoboApply', () => {
    const base = getPlanCatalog('roboapply', INTL_ENV);
    expect(getPlanCatalog('roboapply', { ...INTL_ENV, CN_PAYMENTS_ENABLED: 'false', CN_PRICE_PRO_MONTHLY_FEN: '4900' })).toEqual(base);
    // And the other way round: Stripe settings change nothing on GoApply.
    expect(getPlanCatalog('goapply', { ...INTL_ENV, PRICE_PRO_MONTHLY_USD_CENTS: '2999' })).toEqual(getPlanCatalog('goapply', {}));
  });

  it('documents the env names per brand, the name to use first', () => {
    expect(priceEnvNames('roboapply', 'pro_week_pass')).toEqual(['PRICE_PRO_WEEK_PASS_USD_CENTS', 'STRIPE_PRICE_PRO_WEEK_PASS_CENTS', 'STRIPE_PRICE_PRO_WEEK_PASS']);
    expect(twdPriceEnvNames('pro_week_pass')).toEqual(['PRICE_PRO_WEEK_PASS_TWD_CENTS', 'STRIPE_PRICE_PRO_WEEK_PASS_TWD_CENTS', 'STRIPE_PRICE_PRO_WEEK_PASS_TWD']);
    // GoApply: the optional override only. CN_PAYMENTS_ENABLED is the kill switch, not a price variable.
    expect(priceEnvNames('goapply', 'pro_monthly')).toEqual(['CN_PRICE_PRO_MONTHLY_FEN']);
  });

  it('maps a pinned Stripe price id back to its plan (pins only; synced prices are resolved in stripeCatalog)', () => {
    expect(planKeyForStripePrice('price_q', INTL_ENV)).toBe('pro_quarterly');
    expect(planKeyForStripePrice('unknown', INTL_ENV)).toBeNull();
    expect(planKeyForStripePrice(null, INTL_ENV)).toBeNull();
    // A pin that is ignored (no amount variable) maps to nothing.
    expect(planKeyForStripePrice('price_lonely', { ...READY, STRIPE_PRICE_PRO_MONTHLY: 'price_lonely' })).toBeNull();
    // A Taiwan pin counts.
    expect(planKeyForStripePrice('price_m_twd', { ...READY, PRICE_PRO_MONTHLY_TWD_CENTS: '74900', STRIPE_PRICE_PRO_MONTHLY_TWD: 'price_m_twd' })).toBe('pro_monthly');
  });
});

describe('Taiwan prices (V2, off unless set; MARKET_STRATEGY §4.3)', () => {
  const warnsFor = (variable: string) => vi.mocked(logger.warn).mock.calls.filter((c) => (c[2] as { variable?: string } | undefined)?.variable === variable);
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('no TWD amount, no Taiwan price', () => {
    expect(twdPriceFor('pro_monthly', {})).toBeNull();
    expect(twdPriceFor('pro_monthly', { STRIPE_PRICE_PRO_MONTHLY_TWD: 'price_m_twd' })).toBeNull();
    expect(getPlanCatalog('roboapply', READY).every((p) => p.twdPrice === null)).toBe(true);
  });

  it('a whole-NT$ amount gives the Taiwan price, with a null price id (resolved at checkout)', () => {
    const env = { ...READY, PRICE_PRO_MONTHLY_TWD_CENTS: '74900' };
    expect(twdPriceFor('pro_monthly', env)).toEqual({ currency: 'TWD', amountMinor: 74900, stripePriceId: null });
    expect(getPlan('roboapply', 'pro_monthly', env)!.twdPrice).toEqual({ currency: 'TWD', amountMinor: 74900, stripePriceId: null });
    // Other plans keep none.
    expect(getPlan('roboapply', 'pro_weekly', env)!.twdPrice).toBeNull();
    // It is a fact about the price list, not about the rail: listed while payments are closed too.
    expect(getPlan('roboapply', 'pro_monthly', { PRICE_PRO_MONTHLY_TWD_CENTS: '74900' })).toMatchObject({ sellable: false, twdPrice: { amountMinor: 74900 } });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('PRICE_PRO_MONTHLY_TWD_CENTS=74950 is ignored and logged: NT$ prices are whole dollars', () => {
    const env = { ...READY, PRICE_PRO_MONTHLY_TWD_CENTS: '74950' };
    expect(getPlan('roboapply', 'pro_monthly', env)!.twdPrice).toBeNull();
    getPlanCatalog('roboapply', env);
    const calls = warnsFor('PRICE_PRO_MONTHLY_TWD_CENTS');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toContain('ignored price override');
    expect(calls[0]![2]).toEqual({ variable: 'PRICE_PRO_MONTHLY_TWD_CENTS', value: '74950' });
  });

  it('STRIPE_PRICE_<KEY>_TWD_CENTS is read as an alias, and STRIPE_PRICE_<KEY>_TWD is the optional pin', () => {
    expect(twdPriceFor('pro_quarterly', { STRIPE_PRICE_PRO_QUARTERLY_TWD_CENTS: '165000' })).toEqual({ currency: 'TWD', amountMinor: 165000, stripePriceId: null });
    expect(twdPriceFor('pro_quarterly', { STRIPE_PRICE_PRO_QUARTERLY_TWD_CENTS: '165000', STRIPE_PRICE_PRO_QUARTERLY_TWD: ' price_q_twd ' })).toEqual({
      currency: 'TWD',
      amountMinor: 165000,
      stripePriceId: 'price_q_twd',
    });
    // The new name wins over the alias.
    expect(twdPriceFor('pro_quarterly', { PRICE_PRO_QUARTERLY_TWD_CENTS: '159900', STRIPE_PRICE_PRO_QUARTERLY_TWD_CENTS: '165000' })!.amountMinor).toBe(159900);
    // An alias that is not whole dollars is ignored like the new name.
    expect(twdPriceFor('pro_quarterly', { STRIPE_PRICE_PRO_QUARTERLY_TWD_CENTS: '165050' })).toBeNull();
  });

  it('the Taiwan pin follows the same rule: next to two TWD amounts that differ it is ignored and logged once', () => {
    const env = { PRICE_PRO_WEEKLY_TWD_CENTS: '29900', STRIPE_PRICE_PRO_WEEKLY_TWD_CENTS: '31900', STRIPE_PRICE_PRO_WEEKLY_TWD: 'price_w_twd_old' };
    expect(twdPriceFor('pro_weekly', env)).toEqual({ currency: 'TWD', amountMinor: 29900, stripePriceId: null });
    twdPriceFor('pro_weekly', env);
    expect(planKeyForStripePrice('price_w_twd_old', { ...READY, ...env })).toBeNull();
    const calls = warnsFor('STRIPE_PRICE_PRO_WEEKLY_TWD');
    expect(calls).toHaveLength(1);
    expect(calls[0]![2]).toEqual({ variable: 'STRIPE_PRICE_PRO_WEEKLY_TWD', amount: 'PRICE_PRO_WEEKLY_TWD_CENTS', alias: 'STRIPE_PRICE_PRO_WEEKLY_TWD_CENTS' });
    expect(JSON.stringify(calls[0])).not.toContain('price_w_twd_old');
    // Agreeing amounts keep the pin.
    expect(twdPriceFor('pro_weekly', { ...env, STRIPE_PRICE_PRO_WEEKLY_TWD_CENTS: '29900' })).toEqual({ currency: 'TWD', amountMinor: 29900, stripePriceId: 'price_w_twd_old' });
  });
});

describe('plan key × market (MARKET_STRATEGY §4.3): every key a brand defines has its default', () => {
  // The matrix of the strategy, typed here once. `null` = the brand does not define the key.
  const MATRIX: Record<PlanKey, { roboapply: number | null; goapply: number | null }> = {
    free: { roboapply: 0, goapply: 0 },
    pro_weekly: { roboapply: 999, goapply: null },
    pro_week_pass: { roboapply: 999, goapply: 1200 },
    pro_monthly: { roboapply: 2499, goapply: 3900 },
    pro_quarterly: { roboapply: 5499, goapply: 9900 },
    practice_pack_5: { roboapply: 999, goapply: 2900 },
    practice_pack_15: { roboapply: 2499, goapply: 7900 },
    student_monthly: { roboapply: 1749, goapply: 2900 },
    student_quarterly: { roboapply: 3799, goapply: 6900 },
  };

  it.each(['roboapply', 'goapply'] as const)('%s: with an empty env every defined plan has the listed amount and none is price_unset', (brand) => {
    const catalog = getPlanCatalog(brand, {});
    expect(catalog.map((p) => p.key)).toEqual(PLAN_DEFINITIONS[brand].map((d) => d.key));
    for (const def of PLAN_DEFINITIONS[brand]) {
      const plan = catalog.find((p) => p.key === def.key)!;
      expect(MATRIX[def.key][brand], `${brand} defines ${def.key} but the matrix does not`).not.toBeNull();
      expect(plan.amountMinor, `${brand} ${def.key}`).toBe(MATRIX[def.key][brand]);
      expect(plan.unsellableReason, `${brand} ${def.key}`).not.toBe('price_unset');
    }
    // And nothing the matrix leaves out for the brand is defined.
    for (const key of PLAN_KEYS) {
      expect(PLAN_DEFINITIONS[brand].some((d) => d.key === key), `${brand} ${key}`).toBe(MATRIX[key][brand] !== null);
    }
  });

  it('pro_weekly is absent from GoApply by design (an auto-renewing plan; rule A9)', () => {
    expect(getPlan('goapply', 'pro_weekly', {})).toBeNull();
    expect(getPlanCatalog('goapply', {}).some((p) => p.key === 'pro_weekly' || p.autoRenews)).toBe(false);
  });

  it('renewal follows the rail: RoboApply subscriptions renew, its pass and packs do not, and nothing on GoApply does', () => {
    const robo = Object.fromEntries(PLAN_DEFINITIONS.roboapply.map((d) => [d.key, [d.kind, d.interval, d.passDays, d.autoRenews]]));
    expect(robo).toMatchObject({
      pro_weekly: ['subscription', 'week', null, true],
      pro_monthly: ['subscription', 'month', null, true],
      pro_quarterly: ['subscription', 'quarter', null, true],
      pro_week_pass: ['pass', 'pass', 7, false],
      practice_pack_5: ['pack', null, null, false],
      practice_pack_15: ['pack', null, null, false],
      student_monthly: ['subscription', 'month', null, true],
      student_quarterly: ['subscription', 'quarter', null, true],
    });
    const go = Object.fromEntries(PLAN_DEFINITIONS.goapply.map((d) => [d.key, [d.kind, d.passDays, d.autoRenews]]));
    expect(go).toMatchObject({
      pro_week_pass: ['pass', 7, false],
      pro_monthly: ['pass', 30, false],
      pro_quarterly: ['pass', 90, false],
      student_monthly: ['pass', 30, false],
      student_quarterly: ['pass', 90, false],
    });
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
    expect(defaultSelection('roboapply', READY)).toBe('pro_monthly');
    for (const brand of ['roboapply', 'goapply'] as const) {
      const env = brand === 'roboapply' ? READY : {};
      const chosen = getPlanCatalog(brand, env).filter((p) => p.isDefaultSelection);
      expect(chosen.map((p) => p.key), brand).toEqual(['pro_monthly']);
      expect(buildPlanViews(brand, { env, studentEnabled: true }).defaultSelection, brand).toBe('pro_monthly');
    }
    // Nothing is preselected while nothing can be bought.
    expect(defaultSelection('roboapply', {})).toBeNull();
    expect(getPlanCatalog('roboapply', {}).filter((p) => p.isDefaultSelection)).toEqual([]);
    expect(PLAN_DEFINITIONS.roboapply.filter((p) => p.interval === 'week' || p.kind === 'pass').every((p) => p.neverPreselected)).toBe(true);
  });
});

describe('computed numbers (PRODUCT §6.1 rule 2): labels come from the catalog amounts, never from copy', () => {
  it('quarterly prints "Save 26%" on RoboApply and "省 15%" on GoApply, rounded down', () => {
    const plans = getPlanCatalog('roboapply', {});
    const monthly = plans.find((p) => p.key === 'pro_monthly')!;
    const quarterly = plans.find((p) => p.key === 'pro_quarterly')!;
    // 5499 vs 3 × 2499 = 7497 → 26.65% → 26.
    expect(savingsPercent(quarterly, monthly)).toBe(26);
    expect(savingsPercent(monthly, monthly)).toBeNull();
    expect(savingsPercent(quarterly, null)).toBeNull();
    // The old $59.99 quarterly, set as an override: 19.98% → 19 (never overstated as 20).
    const old = getPlanCatalog('roboapply', INTL_ENV);
    expect(savingsPercent(old.find((p) => p.key === 'pro_quarterly')!, old.find((p) => p.key === 'pro_monthly'))).toBe(19);
    // GoApply, catalog defaults (no env): ¥99 vs 3 × ¥39 = ¥117 → 15.38% → 15.
    const cnDefault = getPlanCatalog('goapply', {});
    expect(savingsPercent(cnDefault.find((p) => p.key === 'pro_quarterly')!, cnDefault.find((p) => p.key === 'pro_monthly'))).toBe(15);
    const cn = getPlanCatalog('goapply', CN_ENV);
    // The same with the amounts given as overrides.
    expect(savingsPercent(cn.find((p) => p.key === 'pro_quarterly')!, cn.find((p) => p.key === 'pro_monthly'))).toBe(15);
  });

  it('student plans print 30 and 30 on RoboApply and 25 and 30 on GoApply', () => {
    const robo = getPlanCatalog('roboapply', {});
    // (2499 − 1749) / 2499 = 30.01% → 30; (5499 − 3799) / 5499 = 30.9% → 30.
    expect(studentDiscountPercent(robo.find((p) => p.key === 'student_monthly')!, robo)).toBe(30);
    expect(studentDiscountPercent(robo.find((p) => p.key === 'student_quarterly')!, robo)).toBe(30);
    const go = getPlanCatalog('goapply', {});
    expect(studentDiscountPercent(go.find((p) => p.key === 'student_monthly')!, go)).toBe(25);
    expect(studentDiscountPercent(go.find((p) => p.key === 'student_quarterly')!, go)).toBe(30);
    // The plan views carry the same numbers.
    const views = buildPlanViews('roboapply', { env: {}, studentEnabled: true }).plans;
    expect(views.find((p) => p.key === 'student_monthly')).toMatchObject({ amountMinor: 1749, studentDiscountPercent: 30 });
    expect(views.find((p) => p.key === 'student_quarterly')).toMatchObject({ amountMinor: 3799, studentDiscountPercent: 30 });
    expect(views.find((p) => p.key === 'pro_quarterly')).toMatchObject({ amountMinor: 5499, savingsPercent: 26 });
  });

  // MARKET_STRATEGY 4.1 / 4.2: a student plan has ONE computed label (the
  // student percentage). "Save N%" compares with 3 x the REGULAR monthly
  // price, which a student never pays: 49% on RoboApply and 41% on GoApply,
  // where the student's own saving is 27% and 20% (PRODUCT 6.1 rule 2: the
  // claim is never larger than the real saving).
  it('a student plan never carries "Save N%": on either brand, and at the Taiwan price', () => {
    for (const brand of ['roboapply', 'goapply'] as const) {
      const catalog = getPlanCatalog(brand, {});
      const monthly = catalog.find((p) => p.key === 'pro_monthly')!;
      expect(savingsPercent(catalog.find((p) => p.key === 'student_quarterly')!, monthly), brand).toBeNull();
      expect(savingsPercent(catalog.find((p) => p.key === 'student_monthly')!, monthly), brand).toBeNull();
      const views = buildPlanViews(brand, { env: {}, studentEnabled: true }).plans;
      expect(views.find((p) => p.key === 'student_quarterly'), brand).toMatchObject({ savingsPercent: null, studentDiscountPercent: 30 });
      expect(views.find((p) => p.key === 'student_monthly')!.savingsPercent, brand).toBeNull();
      // The regular quarterly plan keeps its label.
      expect(views.find((p) => p.key === 'pro_quarterly')!.savingsPercent, brand).toBe(brand === 'roboapply' ? 26 : 15);
    }
    const twEnv = {
      PRICE_PRO_MONTHLY_TWD_CENTS: '74900',
      PRICE_PRO_QUARTERLY_TWD_CENTS: '165000',
      PRICE_STUDENT_MONTHLY_TWD_CENTS: '51900',
      PRICE_STUDENT_QUARTERLY_TWD_CENTS: '115000',
    };
    const tw = buildPlanViews('roboapply', { env: twEnv, studentEnabled: true, country: 'TW' }).plans;
    expect(tw.find((p) => p.key === 'pro_quarterly')!.localPrice).toMatchObject({ amountMinor: 165000, savingsPercent: 26 });
    expect(tw.find((p) => p.key === 'student_quarterly')!.localPrice).toMatchObject({ amountMinor: 115000, savingsPercent: null, studentDiscountPercent: 30 });
  });

  it('the weekly plan is "about $43 a month": 999 × 52 / 12 = 4329', () => {
    const weekly = getPlan('roboapply', 'pro_weekly', {})!;
    expect(monthlyEquivalentMinor(weekly)).toBe(4329);
    expect(monthlyEquivalentMinor(getPlan('roboapply', 'pro_monthly', {})!)).toBeNull();
    expect(buildPlanViews('roboapply', { env: {} }).plans.find((p) => p.key === 'pro_weekly')!.monthlyEquivalentMinor).toBe(4329);
  });

  it('the 7-day pass costs what a week of the weekly plan costs, and three passes cost more than a month', () => {
    const c = getPlanCatalog('roboapply', {});
    const amount = (k: PlanKey) => c.find((p) => p.key === k)!.amountMinor!;
    expect(amount('pro_week_pass')).toBe(amount('pro_weekly'));
    expect(3 * amount('pro_week_pass')).toBeGreaterThan(amount('pro_monthly'));
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
