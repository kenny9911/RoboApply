// lib/pricing.ts
//
// Which currency a visitor pays in, and the plan prices in both currencies,
// for the surfaces that render BEFORE the API can be asked: the public
// landing page and its JSON-LD. Signed-in surfaces (/settings) read the same
// decision from GET /billing/plan, which is the authority at checkout time.
//
// The rule is about location, not preference (owner ruling, mirrored from
// server/src/lib/billingRegion.ts): mainland China pays RMB through Alipay;
// everyone else — INCLUDING Taiwan, Hong Kong, US, EU, JP — pays US dollars
// by card. Only `cn` is special; `zh-TW` is `other`.
//
// The numbers are the owner-locked defaults in
// server/src/lib/mockInterviewPlans.ts. Admins can override that catalogue at
// runtime through AppConfig, which these constants cannot see — the landing
// page is marketing, and a retuned price reaches the buyer at /settings before
// any money moves. __tests__/lib/pricing.test.ts reads the server file and
// fails if the two default tables drift.

export type BillingMarket = 'cn' | 'other';
export type BillingCurrency = 'CNY' | 'USD';

export const MARKET_CURRENCY: Record<BillingMarket, BillingCurrency> = {
  cn: 'CNY',
  other: 'USD',
};

export type PlanKey = 'free' | 'starter' | 'growth';

/** Monthly price per plan, in minor units (cents / fen). */
export const PLAN_PRICES_MINOR: Record<PlanKey, Record<BillingCurrency, number>> = {
  free: { USD: 0, CNY: 0 },
  starter: { USD: 1500, CNY: 1900 },
  growth: { USD: 2900, CNY: 4500 },
};

export function planPriceMinor(plan: PlanKey, market: BillingMarket): number {
  return PLAN_PRICES_MINOR[plan][MARKET_CURRENCY[market]];
}

/**
 * Market from an edge country header (`x-vercel-ip-country`, `cf-ipcountry`).
 * Only `CN` is mainland. Empty and the unknown/Tor placeholders Cloudflare
 * sends (`XX`, `T1`) are "no signal", not "other".
 */
export function marketFromCountry(country: string | null | undefined): BillingMarket | null {
  const v = (country ?? '').trim().toUpperCase();
  if (!v || v === 'XX' || v === 'T1') return null;
  return v === 'CN' ? 'cn' : 'other';
}

/** Market from a UI locale: bare `zh` (mainland simplified) is the only CN
 *  signal; `zh-TW` / `zh-HK` are `other`. */
export function marketFromLocale(locale: string | null | undefined): BillingMarket {
  const l = (locale ?? '').trim().toLowerCase();
  return l === 'zh' || l === 'zh-cn' ? 'cn' : 'other';
}

/** Country header first, then locale, then international. Same precedence as
 *  the server's resolveBillingRegion() minus the signals a public page has no
 *  access to (an explicit choice, a persisted profile market). */
export function resolveMarket(signals: {
  countryHeader?: string | null;
  locale?: string | null;
}): BillingMarket {
  return marketFromCountry(signals.countryHeader) ?? marketFromLocale(signals.locale);
}

/**
 * Format minor units in `currency` for `locale`. `narrowSymbol` so RMB reads
 * "¥19" rather than "CN¥19" in an English UI, and dollars read "$15" rather
 * than "US$15" in a Chinese one — the note beside the price already says
 * which currency it is. Whole amounts drop the cents ("$15", not "$15.00").
 */
export function formatMoney(locale: string, amountMinor: number, currency: string): string {
  const amount = amountMinor / 100;
  const code = (currency || 'USD').toUpperCase();
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${code === 'CNY' ? '¥' : '$'}${amount}`;
  }
}
