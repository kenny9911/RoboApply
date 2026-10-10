// lib/pricing — the currency rule and the legacy practice-plan price table.
// (The public pages print plan prices from the plan catalog config; their
// JSON-LD carries no prices at all — asserted at the end.)
//
// The rule under test is the owner's: mainland China pays RMB, everyone else —
// Taiwan and Hong Kong included — pays US dollars. The table under test must
// equal the owner-locked defaults in server/src/lib/mockInterviewPlans.ts,
// which is the authority at checkout; the first assertion reads that file so
// a price change on one side cannot ship without the other.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  MARKET_CURRENCY,
  PLAN_PRICES_MINOR,
  displayPrice,
  formatMoney,
  marketFromCountry,
  marketFromLocale,
  planPriceMinor,
  quarterlySuggestion,
  resolveMarket,
} from '../../lib/pricing';
import { marketingJsonLd } from '../../lib/seo';
import { buildPlanViews } from '../../server/src/platform/billing/planViews';

describe('lib/pricing', () => {
  it('matches the owner-locked defaults in server/src/lib/mockInterviewPlans.ts', () => {
    // Vitest runs from the repo root; import.meta.url is not a file: URL here.
    const src = readFileSync(join(process.cwd(), 'server/src/lib/mockInterviewPlans.ts'), 'utf8');
    const def = (env: string) => {
      const m = new RegExp(`envInt\\('${env}',\\s*(\\d+)\\)`).exec(src);
      if (!m) throw new Error(`${env} default not found in mockInterviewPlans.ts`);
      return Number(m[1]);
    };
    expect(PLAN_PRICES_MINOR.starter).toEqual({
      USD: def('RA_MOCK_PLAN_STARTER_USD_MINOR'),
      CNY: def('RA_MOCK_PLAN_STARTER_CNY_MINOR'),
    });
    expect(PLAN_PRICES_MINOR.growth).toEqual({
      USD: def('RA_MOCK_PLAN_GROWTH_USD_MINOR'),
      CNY: def('RA_MOCK_PLAN_GROWTH_CNY_MINOR'),
    });
    expect(PLAN_PRICES_MINOR.free).toEqual({ USD: 0, CNY: 0 });
    expect(planPriceMinor('starter', 'cn')).toBe(PLAN_PRICES_MINOR.starter.CNY);
    expect(planPriceMinor('starter', 'other')).toBe(PLAN_PRICES_MINOR.starter.USD);
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

  // These were asserted through the legacy landing's JSON-LD (deleted in
  // INT-06). The prices and the market rule are the pricing module's own, so
  // they are asserted on it directly.
  it('each market is charged in its own currency, at the table price', () => {
    expect(MARKET_CURRENCY).toEqual({ cn: 'CNY', other: 'USD' });
    const shown = (plan: 'free' | 'starter' | 'growth', market: 'cn' | 'other', locale: string) =>
      formatMoney(locale, planPriceMinor(plan, market), MARKET_CURRENCY[market]);
    expect(shown('free', 'other', 'en')).toBe('$0');
    expect(shown('starter', 'other', 'en')).toBe('$15');
    expect(shown('growth', 'other', 'en')).toBe('$29');
    expect(shown('free', 'cn', 'zh')).toBe('¥0');
    expect(shown('starter', 'cn', 'zh')).toBe('¥19');
    expect(shown('growth', 'cn', 'zh')).toBe('¥45');
    // The highest price of a market is its Growth price (what the old AggregateOffer printed as highPrice).
    for (const market of ['cn', 'other'] as const) {
      const prices = (['free', 'starter', 'growth'] as const).map((plan) => planPriceMinor(plan, market));
      expect(Math.max(...prices)).toBe(planPriceMinor('growth', market));
    }
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

    it('a GoApply pass never gets the "switch to quarterly" suggestion: nothing renews, so there is nothing to switch', () => {
      const plans = view();
      expect(
        quarterlySuggestion({ planKey: 'pro_monthly', willRenew: false, legacy: false, monthlySeenAt: '2026-01-01T00:00:00Z', shownAt: null, dismissed: false, now: new Date('2026-10-10T00:00:00Z'), subscriptionCurrency: 'CNY', plans }),
      ).toBeNull();
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
