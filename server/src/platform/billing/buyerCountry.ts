// server/src/platform/billing/buyerCountry.ts
//
// The buyer's country for anything that decides a PRICE: the Taiwan (TWD)
// price on the plan sheet and at checkout (WP-79). The plan sheet and the
// charge must read it the same way, so both call this.
//
// `countryHeaderFromRequest` (lib/billingRegion.ts) prefers `cf-ipcountry`,
// which is fine for display but is a header any client can send when the
// deployment is not behind Cloudflare. Vercel always overwrites
// `x-vercel-ip-country` at its edge, so that header wins here whenever it is
// present; the older order is only the fallback for hosts that do not set it.

import type { Request } from 'express';
import { countryHeaderFromRequest } from '../../lib/billingRegion.js';

export function buyerCountryFromRequest(req: Pick<Request, 'headers'>): string | null {
  const raw = req.headers['x-vercel-ip-country'];
  const edge = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
  if (edge) return edge === 'XX' ? null : edge;
  return countryHeaderFromRequest(req);
}
