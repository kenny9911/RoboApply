/**
 * CurrencyService
 *
 * Pure utilities for the multi-currency overage billing system. No I/O,
 * no side effects — safe to unit-test exhaustively. The contract is
 * documented in docs/design-multicurrency-overage-billing.md §3.1.
 *
 * Core invariants (must hold project-wide):
 *  1. Money is stored as integer minor units — never floats.
 *  2. A user's `market` is the only input to currency resolution. We
 *     never branch on i18n.language server-side or on IP.
 *  3. We never perform FX conversion. Each market has its own price.
 */

export type Market = 'cn' | 'tw' | 'jp' | 'other';
export type Currency = 'CNY' | 'TWD' | 'JPY' | 'USD';
export type PayPerUseSku = 'resume_match' | 'interview' | 'agent_run_resume';

export const MARKETS: readonly Market[] = ['cn', 'tw', 'jp', 'other'] as const;
export const CURRENCIES: readonly Currency[] = ['CNY', 'TWD', 'JPY', 'USD'] as const;
export const PAY_PER_USE_SKUS: readonly PayPerUseSku[] = [
  'resume_match',
  'interview',
  'agent_run_resume',
] as const;

export const MARKET_CURRENCY: Record<Market, Currency> = {
  cn: 'CNY',
  tw: 'TWD',
  jp: 'JPY',
  other: 'USD',
};

// How many decimal places the currency uses in its minor unit. TWD/JPY
// don't use sub-unit denominations in common commerce; we store their
// amounts as whole units with zero decimal places.
export const CURRENCY_DECIMALS: Record<Currency, number> = {
  USD: 2,
  CNY: 2,
  TWD: 0,
  JPY: 0,
};

// Symbol used for display. UI layer can override via i18n if needed
// (e.g. "NT$" vs "TWD") but this is the canonical baseline.
export const CURRENCY_SYMBOL: Record<Currency, string> = {
  USD: '$',
  CNY: '¥',
  TWD: 'NT$',
  JPY: '¥',
};

/**
 * Convert a major-unit amount to minor. Rounds half-up to keep stored
 * values integer. `majorToMinor(0.2, 'CNY') === 20`. Passing a float
 * that can't round-trip cleanly (e.g. 0.1 in USD = 10 cents) is fine
 * because we're rounding.
 */
export function majorToMinor(amount: number, currency: Currency): number {
  if (!Number.isFinite(amount)) throw new Error(`majorToMinor: non-finite amount ${amount}`);
  const decimals = CURRENCY_DECIMALS[currency];
  const factor = 10 ** decimals;
  return Math.round(amount * factor);
}

export function minorToMajor(amountMinor: number, currency: Currency): number {
  if (!Number.isFinite(amountMinor)) {
    throw new Error(`minorToMajor: non-finite amount ${amountMinor}`);
  }
  const decimals = CURRENCY_DECIMALS[currency];
  const factor = 10 ** decimals;
  return amountMinor / factor;
}

/**
 * Format a minor-units amount for display. Uses Intl.NumberFormat for
 * locale grouping. Caller passes a locale hint; defaults to 'en-US' for
 * USD, 'zh-CN' for CNY, etc. If `locale` is provided, it's used
 * verbatim.
 */
export function formatMoney(
  amountMinor: number,
  currency: Currency,
  locale?: string,
): string {
  const major = minorToMajor(amountMinor, currency);
  const decimals = CURRENCY_DECIMALS[currency];
  const effectiveLocale = locale ?? defaultLocaleForCurrency(currency);
  const formatter = new Intl.NumberFormat(effectiveLocale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${CURRENCY_SYMBOL[currency]}${formatter.format(major)}`;
}

function defaultLocaleForCurrency(currency: Currency): string {
  switch (currency) {
    case 'USD':
      return 'en-US';
    case 'CNY':
      return 'zh-CN';
    case 'TWD':
      return 'zh-TW';
    case 'JPY':
      return 'ja-JP';
  }
}

/**
 * Coerce arbitrary input (DB row string, query param) to a valid Market.
 * Unknown values fall back to 'other' — safer than throwing because
 * legacy rows may be null and we don't want to block reads.
 */
export function normalizeMarket(raw: unknown): Market {
  if (typeof raw !== 'string') return 'other';
  const lower = raw.toLowerCase();
  if ((MARKETS as readonly string[]).includes(lower)) return lower as Market;
  return 'other';
}

/**
 * Derive a market from an Accept-Language header at signup time.
 *
 * Priority by language tag prefix:
 *   zh-TW, zh-HK, zh-Hant* → 'tw'
 *   zh-*                   → 'cn'
 *   ja*                    → 'jp'
 *   anything else          → 'other'
 *
 * We intentionally don't use country-code-only tags (e.g. 'TW') because
 * Accept-Language is a language header, not a geo header. Ops can
 * correct the market post-signup via the admin UI.
 */
export function marketFromAcceptLanguage(header: string | undefined | null): Market {
  if (!header || typeof header !== 'string') return 'other';
  // Take the first (highest-priority) tag. Strip q= weights.
  const primary = header.split(',')[0]?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!primary) return 'other';
  if (primary.startsWith('zh-tw') || primary.startsWith('zh-hk') || primary.startsWith('zh-hant')) {
    return 'tw';
  }
  if (primary.startsWith('zh')) return 'cn';
  if (primary.startsWith('ja')) return 'jp';
  return 'other';
}

/**
 * Resolve the currency for a market. Small one-line wrapper around
 * MARKET_CURRENCY, kept as a function so future logic (e.g. admin
 * override that decouples currency from market) has a single hook.
 */
export function currencyForMarket(market: Market): Currency {
  return MARKET_CURRENCY[market];
}
