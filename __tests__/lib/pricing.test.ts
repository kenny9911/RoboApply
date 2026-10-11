// lib/pricing — the currency rule and the display numbers derived from the
// plans the server sends. (The public pages print plan prices from the plan
// catalog; their JSON-LD carries no prices at all, asserted at the end.)
//
// The rule under test is the owner's: mainland China pays RMB, everyone else,
// Taiwan and Hong Kong included, pays US dollars. No amount lives in
// lib/pricing (MARKET_STRATEGY §4.3): the first test reads the source and
// fails if a price table comes back.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import * as pricing from '../../lib/pricing';
import {
  MARKET_CURRENCY,
  displayPrice,
  formatMoney,
  marketFromCountry,
  marketFromLocale,
  monthlyEquivalentMinor,
  quarterlySuggestion,
  resolveMarket,
  samePriceAsWeeklyBilling,
  savingsPercent,
} from '../../lib/pricing';
import { marketingJsonLd } from '../../lib/seo';
import { buildPlanViews } from '../../server/src/platform/billing/planViews';

describe('lib/pricing', () => {
  it('holds no price table: every amount comes from the plans API', () => {
    // The legacy practice-plan table and its reader are gone.
    for (const name of ['PLAN_PRICES_MINOR', 'planPriceMinor']) expect(name in pricing, name).toBe(false);
    // And no exported value of the module is a table of amounts.
    const src = readFileSync(join(process.cwd(), 'lib/pricing.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    // No currency symbol followed by a digit outside comments, and no "<currency>: <amount>" pair.
    expect(code).not.toMatch(/[$¥€£]\s?\d/);
    expect(code).not.toMatch(/\b(USD|CNY|TWD)\s*:\s*\d/);
    expect(MARKET_CURRENCY).toEqual({ cn: 'CNY', other: 'USD' });
  });

  it('mainland China is the only RMB market — Taiwan, Hong Kong and the rest pay US dollars', () => {
    expect(marketFromCountry('CN')).toBe('cn');
    expect(marketFromCountry('cn')).toBe('cn');
    for (const c of ['TW', 'HK', 'MO', 'US', 'DE', 'JP', 'SG']) {
      expect(marketFromCountry(c)).toBe('other');
    }
    // No header, or the placeholders Cloudflare sends for unknown / Tor, is
    // no signal at all — not "other".
    expect(marketFromCountry('')).toBeNull();
    expect(marketFromCountry(null)).toBeNull();
    expect(marketFromCountry('XX')).toBeNull();
    expect(marketFromCountry('T1')).toBeNull();
  });

  it('by language, only mainland simplified Chinese implies RMB', () => {
    expect(marketFromLocale('zh')).toBe('cn');
    expect(marketFromLocale('zh-CN')).toBe('cn');
    expect(marketFromLocale('zh-TW')).toBe('other');
    expect(marketFromLocale('en')).toBe('other');
    expect(marketFromLocale(null)).toBe('other');
  });

  it('the country header decides before the language does', () => {
    // A /zh reader in Taipei pays US dollars; an /en reader in Shanghai pays RMB.
    expect(resolveMarket({ countryHeader: 'TW', locale: 'zh' })).toBe('other');
    expect(resolveMarket({ countryHeader: 'CN', locale: 'en' })).toBe('cn');
    expect(resolveMarket({ countryHeader: null, locale: 'zh' })).toBe('cn');
    expect(resolveMarket({ countryHeader: 'XX', locale: 'zh-TW' })).toBe('other');
    expect(resolveMarket({})).toBe('other');
  });

  it('formats with the narrow symbol and no cents on a whole amount', () => {
    expect(formatMoney('en', 1500, 'USD')).toBe('$15');
    expect(formatMoney('en', 1900, 'CNY')).toBe('¥19');
    expect(formatMoney('zh', 1500, 'USD')).toBe('$15');
    expect(formatMoney('zh', 4500, 'CNY')).toBe('¥45');
    expect(formatMoney('en', 1550, 'USD')).toBe('$15.50');
    expect(formatMoney('en', 0, 'USD')).toBe('$0');
  });

  it('a weekly price reads as a whole monthly amount: 999 a week is "about $43 a month"', () => {
    // 999 × 52 / 12 = 4,329 cents; the line says "about", so it is a whole dollar.
    expect(monthlyEquivalentMinor(999)).toBe(4300);
    expect(formatMoney('en', monthlyEquivalentMinor(999)!, 'USD')).toBe('$43');
    expect(monthlyEquivalentMinor(29900)).toBe(129600);
    expect(monthlyEquivalentMinor(null)).toBeNull();
    expect(monthlyEquivalentMinor(0)).toBeNull();
    // Through displayPrice, which is what both the pricing page and the plan sheet print.
    const weekly = { key: 'pro_weekly', interval: 'week', amountMinor: 999, currency: 'USD' };
    const d = displayPrice(weekly, { key: 'pro_monthly', interval: 'month', amountMinor: 2499, currency: 'USD' });
    expect(d).toMatchObject({ amountMinor: 999, currency: 'USD', monthlyEquivalentMinor: 4300, savingsPercent: null, local: false, studentDiscountPercent: null });
    expect(formatMoney('en', d.monthlyEquivalentMinor!, d.currency)).toBe('$43');
    // The number the server computes (4,329) is never what is printed.
    expect(displayPrice({ ...weekly, monthlyEquivalentMinor: 4329 } as typeof weekly, null).monthlyEquivalentMinor).toBe(4300);
    // A real Taiwan price gets the same whole-amount rule in its own currency.
    const local = displayPrice({ ...weekly, localPrice: { currency: 'TWD', amountMinor: 29900, savingsPercent: null, monthlyEquivalentMinor: 129567 } }, null);
    expect(local).toMatchObject({ amountMinor: 29900, currency: 'TWD', local: true, monthlyEquivalentMinor: 129600 });
    // Only a weekly plan has the line.
    expect(displayPrice({ key: 'pro_monthly', interval: 'month', amountMinor: 2499, currency: 'USD' }, null).monthlyEquivalentMinor).toBeNull();
  });

  it('"Save N%" is computed from the two amounts and rounded down', () => {
    expect(savingsPercent(5499, 2499, 3)).toBe(26); // 26.65% → 26
    expect(savingsPercent(5999, 2499, 3)).toBe(19); // 19.98% is never rounded up to 20
    expect(savingsPercent(9900, 3900, 3)).toBe(15);
    expect(savingsPercent(7497, 2499, 3)).toBeNull();
    expect(savingsPercent(5499, null, 3)).toBeNull();
    expect(savingsPercent(5499, 2499, 1)).toBeNull();
    const monthly = { key: 'pro_monthly', interval: 'month', amountMinor: 2499, currency: 'USD' };
    expect(displayPrice({ key: 'pro_quarterly', interval: 'quarter', amountMinor: 5499, currency: 'USD' }, monthly).savingsPercent).toBe(26);
    // A student plan never prints "Save N%": the reference is the REGULAR monthly price, which a
    // student does not pay (3799 against 3 × 2499 would print 49%; the student's own saving is 27%).
    // Not from the base amounts, and not from a local price an older server still computed one for.
    const studentQuarterly = { key: 'student_quarterly', interval: 'quarter', amountMinor: 3799, currency: 'USD', requiresFlag: 'student', studentDiscountPercent: 30 };
    expect(displayPrice(studentQuarterly, monthly)).toMatchObject({ savingsPercent: null, studentDiscountPercent: 30 });
    expect(displayPrice({ key: 'student_quarterly', interval: null, amountMinor: 6900, currency: 'CNY', passDays: 90 }, { ...monthly, amountMinor: 3900, currency: 'CNY' }).savingsPercent).toBeNull();
    expect(
      displayPrice({ ...studentQuarterly, localPrice: { currency: 'TWD', amountMinor: 115000, savingsPercent: 48, monthlyEquivalentMinor: null, studentDiscountPercent: 30 } }, monthly),
    ).toMatchObject({ amountMinor: 115000, savingsPercent: null, studentDiscountPercent: 30, local: true });
    // The student percentage is the server's own computation, passed through in the currency shown.
    expect(displayPrice({ key: 'student_monthly', interval: 'month', amountMinor: 1749, currency: 'USD', studentDiscountPercent: 30 }, monthly).studentDiscountPercent).toBe(30);
  });

  it('"same price as weekly billing" is true only while the two amounts the API sent are equal', () => {
    const weekly = { key: 'pro_weekly', kind: 'subscription', interval: 'week', amountMinor: 999, currency: 'USD', passDays: null };
    const pass = { key: 'pro_week_pass', kind: 'pass', interval: 'pass', amountMinor: 999, currency: 'USD', passDays: 7 };
    const monthly = { key: 'pro_monthly', kind: 'subscription', interval: 'month', amountMinor: 2499, currency: 'USD', passDays: null };
    expect(samePriceAsWeeklyBilling(pass, [weekly, monthly, pass])).toBe(true);
    // A different amount, either way round.
    expect(samePriceAsWeeklyBilling({ ...pass, amountMinor: 699 }, [weekly, pass])).toBe(false);
    expect(samePriceAsWeeklyBilling(pass, [{ ...weekly, amountMinor: 1099 }, pass])).toBe(false);
    // No weekly plan (GoApply sells none), no list, or an amount that is not stated.
    expect(samePriceAsWeeklyBilling({ ...pass, amountMinor: 1200, currency: 'CNY' }, [monthly, pass])).toBe(false);
    expect(samePriceAsWeeklyBilling(pass, null)).toBe(false);
    expect(samePriceAsWeeklyBilling({ ...pass, amountMinor: null }, [{ ...weekly, amountMinor: null }])).toBe(false);
    // Only the 7-day pass carries the line: not the weekly plan itself, a pack or a longer pass.
    expect(samePriceAsWeeklyBilling(weekly, [weekly, pass])).toBe(false);
    expect(samePriceAsWeeklyBilling({ ...pass, key: 'pro_monthly', passDays: 30 }, [weekly])).toBe(false);
    expect(samePriceAsWeeklyBilling({ ...pass, kind: 'pack', passDays: null }, [weekly])).toBe(false);
    // The same amount in another currency is not the same price.
    expect(samePriceAsWeeklyBilling(pass, [{ ...weekly, currency: 'TWD' }])).toBe(false);
    // Compared in the currency shown: a Taiwan price on both, equal → true; on one only → false.
    const twd = (amountMinor: number) => ({ currency: 'TWD', amountMinor, savingsPercent: null, monthlyEquivalentMinor: null });
    expect(samePriceAsWeeklyBilling({ ...pass, localPrice: twd(29900) }, [{ ...weekly, localPrice: twd(29900) }])).toBe(true);
    expect(samePriceAsWeeklyBilling({ ...pass, localPrice: twd(29900) }, [weekly])).toBe(false);
  });

  // The plan sheet and /pricing derive every display number from the plans the
  // server sends (`displayPrice`); nothing in lib/pricing knows an amount.
  describe('GoApply plans as the server sends them (catalog defaults in fen; D5, D6)', () => {
    const view = (env: Record<string, string> = {}) => buildPlanViews('goapply', { env, studentEnabled: true }).plans;
    const shown = (plans: ReturnType<typeof view>, key: string) => {
      const plan = plans.find((p) => p.key === key)!;
      const d = displayPrice(plan, plans.find((p) => p.key === 'pro_monthly'));
      return { ...d, text: d.amountMinor === null ? null : formatMoney('zh', d.amountMinor, d.currency) };
    };

    it('with an empty env every paid plan has a price to show: none is "price not set" and none is off sale', () => {
      const plans = view();
      const paid = plans.filter((p) => p.kind !== 'free');
      expect(paid.map((p) => [p.key, shown(plans, p.key).text])).toEqual([
        ['pro_week_pass', '¥12'],
        ['pro_monthly', '¥39'],
        ['pro_quarterly', '¥99'],
        ['practice_pack_5', '¥29'],
        ['practice_pack_15', '¥79'],
        ['student_monthly', '¥29'],
        ['student_quarterly', '¥69'],
      ]);
      expect(paid.every((p) => p.sellable && p.unsellableReason === null && p.currency === 'CNY')).toBe(true);
      expect(plans.some((p) => p.unsellableReason === 'price_unset' || p.unsellableReason === 'payments_disabled')).toBe(false);
    });

    it('the labels are computed from those amounts: 省 15% on the 90-day pass, 25% and 30% for students, no weekly equivalent', () => {
      const plans = view();
      expect(shown(plans, 'pro_quarterly')).toMatchObject({ savingsPercent: 15, monthlyEquivalentMinor: null, local: false, studentDiscountPercent: null });
      expect(shown(plans, 'pro_monthly')).toMatchObject({ savingsPercent: null, studentDiscountPercent: null });
      expect(shown(plans, 'pro_week_pass')).toMatchObject({ savingsPercent: null, monthlyEquivalentMinor: null });
      expect(shown(plans, 'student_monthly').studentDiscountPercent).toBe(25);
      expect(shown(plans, 'student_quarterly').studentDiscountPercent).toBe(30);
      // An override moves the label with the amount.
      const dearer = view({ CN_PRICE_PRO_QUARTERLY_FEN: '10900' });
      expect(shown(dearer, 'pro_quarterly')).toMatchObject({ amountMinor: 10900, savingsPercent: 6 });
    });

    it('payments_disabled exists only under the kill switch, and the prices are still there to show', () => {
      const killed = view({ CN_PAYMENTS_ENABLED: 'false' });
      const paid = killed.filter((p) => p.kind !== 'free');
      expect(paid.every((p) => !p.sellable && p.unsellableReason === 'payments_disabled')).toBe(true);
      expect(shown(killed, 'pro_monthly').text).toBe('¥39');
      expect(shown(killed, 'pro_quarterly').savingsPercent).toBe(15);
      // Not a default: unset, blank and true all leave the plans on sale.
      for (const value of [undefined, '', 'true']) {
        const env: Record<string, string> = value === undefined ? {} : { CN_PAYMENTS_ENABLED: value };
        expect(view(env).filter((p) => p.kind !== 'free').every((p) => p.sellable), String(value)).toBe(true);
      }
    });

    it('GoApply sells no weekly billing, so its week pass never says "same price as weekly billing"', () => {
      const plans = view();
      expect(plans.some((p) => p.interval === 'week')).toBe(false);
      expect(samePriceAsWeeklyBilling(plans.find((p) => p.key === 'pro_week_pass')!, plans)).toBe(false);
    });

    it('a GoApply pass never gets the "switch to quarterly" suggestion: nothing renews, so there is nothing to switch', () => {
      const plans = view();
      expect(
        quarterlySuggestion({ planKey: 'pro_monthly', willRenew: false, legacy: false, monthlySeenAt: '2026-01-01T00:00:00Z', shownAt: null, dismissed: false, now: new Date('2026-10-10T00:00:00Z'), subscriptionCurrency: 'CNY', plans }),
      ).toBeNull();
    });
  });

  // RoboApply at the MARKET_STRATEGY §4.1 amounts, stated through the override
  // variables so the case means the same whichever way the catalog resolves
  // its defaults: the labels are computed, never written.
  describe('RoboApply plans at the §4.1 amounts', () => {
    const ENV = {
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      ...Object.fromEntries(
        (
          [
            ['PRO_WEEKLY', 999],
            ['PRO_MONTHLY', 2499],
            ['PRO_QUARTERLY', 5499],
            ['PRO_WEEK_PASS', 999],
            ['PRACTICE_PACK_5', 999],
            ['PRACTICE_PACK_15', 2499],
            ['STUDENT_MONTHLY', 1749],
            ['STUDENT_QUARTERLY', 3799],
          ] as const
        ).flatMap(([key, cents]) => [
          [`STRIPE_PRICE_${key}`, `price_${key.toLowerCase()}`],
          [`STRIPE_PRICE_${key}_CENTS`, String(cents)],
        ]),
      ),
    };
    const plans = buildPlanViews('roboapply', { env: ENV, studentEnabled: true }).plans;
    const monthly = plans.find((p) => p.key === 'pro_monthly');
    const shown = (key: string) => {
      const d = displayPrice(plans.find((p) => p.key === key)!, monthly);
      return { ...d, text: d.amountMinor === null ? null : formatMoney('en', d.amountMinor, d.currency) };
    };

    it('prints $9.99, $24.99, $54.99, the pass at $9.99, packs $9.99 and $24.99, student $17.49 and $37.99', () => {
      expect(plans.filter((p) => p.kind !== 'free').map((p) => [p.key, shown(p.key).text])).toEqual([
        ['pro_weekly', '$9.99'],
        ['pro_monthly', '$24.99'],
        ['pro_quarterly', '$54.99'],
        ['pro_week_pass', '$9.99'],
        ['practice_pack_5', '$9.99'],
        ['practice_pack_15', '$24.99'],
        ['student_monthly', '$17.49'],
        ['student_quarterly', '$37.99'],
      ]);
    });

    it('computes "about $43 a month", "Save 26%" and 30% / 30% for students; the pass costs what weekly billing costs', () => {
      expect(formatMoney('en', shown('pro_weekly').monthlyEquivalentMinor!, 'USD')).toBe('$43');
      expect(shown('pro_quarterly').savingsPercent).toBe(26);
      expect(shown('pro_monthly')).toMatchObject({ savingsPercent: null, monthlyEquivalentMinor: null });
      expect(shown('student_monthly').studentDiscountPercent).toBe(30);
      expect(shown('student_quarterly').studentDiscountPercent).toBe(30);
      expect(samePriceAsWeeklyBilling(plans.find((p) => p.key === 'pro_week_pass')!, plans)).toBe(true);
    });
  });

  it('the marketing JSON-LD of both brands carries no price, offer, rating or review (D3)', () => {
    for (const [brandId, locale] of [['roboapply', 'en'], ['goapply', 'zh']] as const) {
      const json = marketingJsonLd({ brandId, locale, path: '/pricing', name: 'Pricing', description: 'Plans and what each one includes.' });
      const types = (JSON.parse(json)['@graph'] as Array<{ '@type': string }>).map((n) => n['@type']);
      expect(types).toEqual(['Organization', 'WebSite', 'WebPage']);
      expect(json).not.toMatch(/"price"|priceCurrency|lowPrice|highPrice|AggregateOffer|"Offer"|AggregateRating|"Review"|USD|CNY/);
    }
  });
});
