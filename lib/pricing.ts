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

// ─────────────────────────────────────────────────────────────────────────────
// Clone plan catalog helpers (WP-21b; PRODUCT_PLAN.md §6.1–§6.4, TASK_PLAN.md
// R-08, R-25). The plan sheet, /settings#billing and PriceReference read the
// server catalog (`GET /billing/plans`); these helpers only DERIVE display
// numbers from those server prices — no amount is hard-coded here. A GoApply
// plan always arrives with its CNY amount (the catalog default or a
// whole-yuan override), so on GoApply `amountMinor` is never null; whether a
// payment can open is the response's `paymentsOpen` and `checkout.rails`,
// never something derived here or from the brand.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Countries where the consumer has a 14-day right of withdrawal at checkout,
 * so the plan sheet adds the optional withdrawal-waiver acknowledgement
 * (PRODUCT F-BILL-08): the EU 27, the UK, and Taiwan (digital-services
 * exemption only with prior agreement). Unknown country → no box, so the
 * buyer keeps the full 14-day refund (the safe default for the consumer).
 */
export const WITHDRAWAL_WAIVER_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'GB', 'TW',
]);

export function requiresWithdrawalWaiver(country: string | null | undefined): boolean {
  const c = (country ?? '').trim().toUpperCase();
  return c.length === 2 && WITHDRAWAL_WAIVER_COUNTRIES.has(c);
}

/**
 * Weekly price → the monthly equivalent ("about $43 a month"): 52 weeks / 12,
 * rounded to a whole currency unit because the line says "about". Minor units.
 */
export function monthlyEquivalentMinor(amountMinor: number | null | undefined): number | null {
  if (amountMinor === null || amountMinor === undefined || !Number.isFinite(amountMinor) || amountMinor <= 0) return null;
  return Math.round((amountMinor * 52) / 12 / 100) * 100;
}

/**
 * "Save N%" against our own monthly price × months, rounded DOWN so the claim
 * is never larger than the real saving (PRODUCT §6.1 rule 2). Null when a
 * price is unknown or there is no saving.
 */
export function savingsPercent(
  amountMinor: number | null | undefined,
  monthlyMinor: number | null | undefined,
  months: number,
): number | null {
  if (!amountMinor || !monthlyMinor || months < 2) return null;
  const reference = monthlyMinor * months;
  if (reference <= 0 || amountMinor >= reference) return null;
  const pct = Math.floor(((reference - amountMinor) / reference) * 100);
  return pct > 0 ? pct : null;
}

/** The TWD reference line hides itself when the admin rate is older than this (CN L-7). */
export const FX_REFERENCE_MAX_AGE_DAYS = 45;

/** The admin-entered reference rate (`fx.reference` AppConfig) as the web receives it. */
export interface FxReference {
  currency: 'TWD';
  ratePerUsd: number;
  source: string;
  /** YYYY-MM-DD. */
  asOf: string;
}

/** True when the rate has a source and is at most 45 days old. Never guesses. */
export function isFxReferenceFresh(ref: FxReference | null | undefined, now: Date = new Date()): ref is FxReference {
  if (!ref || ref.currency !== 'TWD' || !(ref.ratePerUsd > 0) || !ref.source?.trim()) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ref.asOf)) return false;
  const asOf = Date.parse(`${ref.asOf}T00:00:00Z`);
  if (Number.isNaN(asOf)) return false;
  const ageDays = (now.getTime() - asOf) / 86_400_000;
  return ageDays >= -1 && ageDays <= FX_REFERENCE_MAX_AGE_DAYS;
}

/** USD cents → whole New Taiwan dollars at the reference rate (rounded to the nearest dollar). */
export function twdReferenceAmount(usdMinor: number, ratePerUsd: number): number | null {
  if (!Number.isFinite(usdMinor) || usdMinor <= 0 || !(ratePerUsd > 0)) return null;
  return Math.round((usdMinor / 100) * ratePerUsd);
}

// ─────────────────────────────────────────────────────────────────────────────
// Account V2 (WP-79; PRODUCT_PLAN.md §6.3–§6.4, F-BILL-06, TW-06). Pure
// helpers for the plan sheet's V2 lines and the one quarterly suggestion.
// Every amount still comes from the server catalog.
// ─────────────────────────────────────────────────────────────────────────────

/** A plan's price as this buyer is charged: the Taiwan price when the server sent one, else the base price. */
export interface DisplayPrice {
  amountMinor: number | null;
  currency: string;
  /** "Save N%" in that currency (null when there is no real saving). */
  savingsPercent: number | null;
  /** Weekly plans: about this much a month, in that currency. */
  monthlyEquivalentMinor: number | null;
  /** True when this is a real local-currency price (no reference line needed). */
  local: boolean;
  /** Student plans: % below the regular price, computed in this same currency. */
  studentDiscountPercent: number | null;
}

export interface PricedPlanLike {
  key: string;
  interval: string | null;
  amountMinor: number | null;
  currency: string;
  passDays?: number | null;
  localPrice?: {
    currency: string;
    amountMinor: number;
    savingsPercent: number | null;
    monthlyEquivalentMinor: number | null;
    studentDiscountPercent?: number | null;
  } | null;
  studentDiscountPercent?: number | null;
}

export function displayPrice(plan: PricedPlanLike, monthly: PricedPlanLike | null | undefined): DisplayPrice {
  if (plan.localPrice) {
    return {
      amountMinor: plan.localPrice.amountMinor,
      currency: plan.localPrice.currency,
      savingsPercent: plan.localPrice.savingsPercent,
      monthlyEquivalentMinor: plan.localPrice.monthlyEquivalentMinor,
      local: true,
      studentDiscountPercent: plan.localPrice.studentDiscountPercent ?? null,
    };
  }
  const months = plan.key === 'pro_quarterly' || plan.key === 'student_quarterly' || plan.passDays === 90 ? 3 : 0;
  return {
    amountMinor: plan.amountMinor,
    currency: plan.currency,
    savingsPercent: months ? savingsPercent(plan.amountMinor, monthly?.amountMinor, months) : null,
    monthlyEquivalentMinor: plan.interval === 'week' ? monthlyEquivalentMinor(plan.amountMinor) : null,
    local: false,
    studentDiscountPercent: plan.studentDiscountPercent ?? null,
  };
}

/** The monthly plan → the quarterly plan it may be switched to. */
export const QUARTERLY_SWITCH: Readonly<Record<string, string>> = {
  pro_monthly: 'pro_quarterly',
  student_monthly: 'student_quarterly',
};

/** ui-state keys (server-side, follow the user across devices). */
export const QUARTERLY_SUGGESTION_KEYS = {
  /** First time this browser saw the user on a monthly plan (ISO). */
  monthlySeenAt: 'billing.monthlySeenAt',
  /** The suggestion was shown (ISO); it is never shown again. */
  shownAt: 'billing.quarterlySuggestion.shownAt',
  /** Dismissal key ("No thanks"). */
  dismissal: 'billing.quarterlySuggestion',
} as const;

export const QUARTERLY_SUGGESTION_AFTER_DAYS = 30;

export interface QuarterlySuggestion {
  targetKey: string;
  currency: string;
  quarterlyMinor: number;
  /** 3 × the monthly price, the honest comparison. */
  threeMonthsMinor: number;
  savingsPercent: number;
}

/** A plan's price in `currency`: its base price, else its Taiwan price (sent as `localPrice` or `twdPrice`); null when not configured in it. */
function priceIn(
  plan: { amountMinor: number | null; currency: string; localPrice?: { currency: string; amountMinor: number } | null; twdPrice?: { amountMinor: number } | null },
  currency: string,
): number | null {
  if (plan.currency.toUpperCase() === currency) return plan.amountMinor;
  if (plan.localPrice && plan.localPrice.currency.toUpperCase() === currency) return plan.localPrice.amountMinor;
  if (currency === 'TWD' && plan.twdPrice) return plan.twdPrice.amountMinor;
  return null;
}

/**
 * The one "switch to quarterly" suggestion (PRODUCT_PLAN.md §6.4: monthly
 * subscriber after 30 days; once, ever; dismissible forever). Null unless:
 * the plan renews monthly and is not cancelled; we first saw it as monthly at
 * least 30 days ago (`monthlySeenAt` — never earlier than the truth, since
 * the user was monthly at least that long); the quarterly plan is on sale and
 * really cheaper than 3 months of monthly; and it was never shown or
 * dismissed. The saving is computed from the two real prices, rounded down.
 */
export function quarterlySuggestion(input: {
  planKey: string | null;
  willRenew: boolean;
  legacy: boolean;
  monthlySeenAt: string | null;
  shownAt: string | null;
  dismissed: boolean;
  now: Date;
  /**
   * The currency the subscription is charged in (billing plan `current.currency`).
   * A switch is charged in that currency (a TWD subscription moves only to a
   * TWD price), so both amounts are read in it; unknown → no suggestion.
   */
  subscriptionCurrency: string | null;
  plans: ReadonlyArray<{
    key: string;
    amountMinor: number | null;
    currency: string;
    sellable: boolean;
    localPrice?: { currency: string; amountMinor: number } | null;
    twdPrice?: { amountMinor: number } | null;
  }>;
}): QuarterlySuggestion | null {
  const targetKey = input.planKey ? QUARTERLY_SWITCH[input.planKey] : undefined;
  if (!targetKey || !input.willRenew || input.legacy || input.shownAt || input.dismissed || !input.monthlySeenAt) return null;
  const seen = Date.parse(input.monthlySeenAt);
  if (!Number.isFinite(seen) || input.now.getTime() - seen < QUARTERLY_SUGGESTION_AFTER_DAYS * 86_400_000) return null;
  const monthly = input.plans.find((p) => p.key === input.planKey);
  const quarterly = input.plans.find((p) => p.key === targetKey);
  const currency = input.subscriptionCurrency?.trim().toUpperCase() || null;
  if (!monthly || !quarterly || !quarterly.sellable || !currency) return null;
  const monthlyMinor = priceIn(monthly, currency);
  const quarterlyMinor = priceIn(quarterly, currency);
  if (monthlyMinor === null || quarterlyMinor === null) return null;
  const pct = savingsPercent(quarterlyMinor, monthlyMinor, 3);
  if (pct === null) return null;
  return { targetKey, currency, quarterlyMinor, threeMonthsMinor: monthlyMinor * 3, savingsPercent: pct };
}
