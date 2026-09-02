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

export async function resolveVisitorMarket(locale: string): Promise<BillingMarket> {
  let countryHeader: string | null = null;
  try {
    const headersList = await headers();
    for (const name of COUNTRY_HEADERS) {
      const value = headersList.get(name);
      if (value) {
        countryHeader = value;
        break;
      }
    }
  } catch {
    /* prerender context — no request to read */
  }
  return resolveMarket({ countryHeader, locale });
}
