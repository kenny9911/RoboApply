// lib/serverMarket.ts
//
// Server-side billing-market resolution for the public landing pages, the
// sibling of lib/serverLocale.ts. Vercel stamps the visitor's country on every
// request as `x-vercel-ip-country` (Cloudflare: `cf-ipcountry`); proxy.ts
// forwards request headers untouched, so a server component can read it here.
// With no header (local dev, a private relay) the UI locale decides, exactly
// as the API does for a signed-in user with no profile market.

import { headers } from 'next/headers';

import { resolveMarket, type BillingMarket } from './pricing';

const COUNTRY_HEADERS = ['x-vercel-ip-country', 'cf-ipcountry', 'x-country', 'x-geo-country'];

async function readCountryHeader(): Promise<string | null> {
  try {
    const headersList = await headers();
    for (const name of COUNTRY_HEADERS) {
      const value = headersList.get(name);
      if (value) return value;
    }
  } catch {
    /* prerender context — no request to read */
  }
  return null;
}

export async function resolveVisitorMarket(locale: string): Promise<BillingMarket> {
  return resolveMarket({ countryHeader: await readCountryHeader(), locale });
}

/**
 * The visitor's ISO-3166 alpha-2 country from the edge header, or null when
 * there is no usable signal (local dev, a relay, Cloudflare's XX/T1). Used by
 * the plan sheet to decide whether the EU/UK/TW withdrawal acknowledgement
 * applies (WP-21b); unknown stays unknown — never guessed from the locale.
 */
export async function resolveVisitorCountry(): Promise<string | null> {
  const v = ((await readCountryHeader()) ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(v) || v === 'XX' || v === 'T1') return null;
  return v;
}
