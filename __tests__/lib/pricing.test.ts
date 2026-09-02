// lib/pricing — the currency rule and the plan price table the public landing
// page (and its JSON-LD) render from.
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
  PLAN_PRICES_MINOR,
  formatMoney,
  marketFromCountry,
  marketFromLocale,
  planPriceMinor,
  resolveMarket,
} from '../../lib/pricing';
import { landingJsonLd } from '../../lib/seo';

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

  it('the landing JSON-LD offers follow the market', () => {
    const usd = landingJsonLd('en');
    expect(usd).toContain('"priceCurrency":"USD"');
    expect(usd).toContain('"name":"Starter","price":"15"');
    expect(usd).toContain('"highPrice":"29"');
    expect(usd).not.toContain('CNY');

    const cny = landingJsonLd('zh', 'cn');
    expect(cny).toContain('"priceCurrency":"CNY"');
    expect(cny).toContain('"name":"Starter","price":"19"');
    expect(cny).toContain('"name":"Growth","price":"45"');
    expect(cny).toContain('"highPrice":"45"');
    expect(cny).not.toContain('USD');
  });
});
