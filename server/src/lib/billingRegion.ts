// backend/src/lib/billingRegion.ts
//
// Resolves which currency + payment rail a RoboApply user pays with.
//
//   • Mainland China (CN) → RMB via Alipay (one-time monthly pass; the GoHire
//     Alipay worker can't auto-renew, hence the 5-day renewal reminder email).
//   • Everyone else — INCLUDING Taiwan, Hong Kong, US, EU, JP → USD via Stripe
//     recurring subscription.
//
// The owner rule: "Chinese users charge in RMB; non-Chinese users INCLUDING
// Taiwanese charge with USD." So only `cn` is special; `zh-TW` ⇒ other.
//
// Pure + deterministic: pass the available signals, get a decision. No I/O.

import type { Request } from 'express';

export type BillingMarket = 'cn' | 'other';

export interface BillingRegion {
  market: BillingMarket;
  currency: 'CNY' | 'USD';
  method: 'alipay' | 'stripe';
  /** Which signal decided it (for logging / debugging). */
  source: 'explicit' | 'country_header' | 'profile_market' | 'locale' | 'default';
}

export interface RegionSignals {
  /** Explicit user choice at checkout ('cn' | 'other'). Highest priority. */
  explicit?: string | null;
  /** Cloudflare / proxy country header value, e.g. 'CN', 'TW', 'US'. */
  countryHeader?: string | null;
  /** Persisted SeekerProfile.market: 'us'|'cn'|'tw'|'jp'|'eu'|'other'. */
  profileMarket?: string | null;
  /** UI locale: 'zh' (mainland simplified) → cn; 'zh-TW' → other. */
  locale?: string | null;
}

function decide(market: BillingMarket, source: BillingRegion['source']): BillingRegion {
  return market === 'cn'
    ? { market: 'cn', currency: 'CNY', method: 'alipay', source }
    : { market: 'other', currency: 'USD', method: 'stripe', source };
}

export function resolveBillingRegion(signals: RegionSignals): BillingRegion {
  // 1. Explicit user choice — but only honor the two valid values.
  const explicit = (signals.explicit ?? '').trim().toLowerCase();
  if (explicit === 'cn') return decide('cn', 'explicit');
  if (explicit === 'other' || explicit === 'us' || explicit === 'usd' || explicit === 'intl') {
    return decide('other', 'explicit');
  }

  // 2. Country from a trusted edge header (cf-ipcountry etc.). Mainland only.
  const country = (signals.countryHeader ?? '').trim().toUpperCase();
  if (country) {
    return decide(country === 'CN' ? 'cn' : 'other', 'country_header');
  }

  // 3. Persisted market on the seeker profile.
  const pm = (signals.profileMarket ?? '').trim().toLowerCase();
  if (pm) {
    return decide(pm === 'cn' ? 'cn' : 'other', 'profile_market');
  }

  // 4. Locale. Only bare 'zh' (mainland simplified) implies CN; zh-TW/zh-HK ⇒ other.
  const loc = (signals.locale ?? '').trim().toLowerCase();
  if (loc) {
    return decide(loc === 'zh' || loc === 'zh-cn' ? 'cn' : 'other', 'locale');
  }

  // 5. Default: international / USD / Stripe.
  return decide('other', 'default');
}

/** Pull the best-available country header off an Express request (edge proxies). */
export function countryHeaderFromRequest(req: Request): string | null {
  const h = req.headers;
  const raw =
    (h['cf-ipcountry'] as string | undefined) ||
    (h['x-vercel-ip-country'] as string | undefined) ||
    (h['x-country'] as string | undefined) ||
    (h['x-geo-country'] as string | undefined) ||
    null;
  if (!raw) return null;
  const v = String(raw).trim().toUpperCase();
  // Cloudflare uses 'XX'/'T1' for unknown/Tor — treat as no signal.
  if (!v || v === 'XX' || v === 'T1') return null;
  return v;
}
