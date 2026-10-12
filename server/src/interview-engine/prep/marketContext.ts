// server/src/interview-engine/prep/marketContext.ts
//
// Which job market a practice is for: where to search postings, which
// interview norms apply, and which formats the brand offers. The job's own
// country wins (a posting in Tokyo is a Japanese interview whatever the
// interface language); then the candidate's active job search, their profile
// country, the interface language, and finally the brand's default country.
// GoApply is always mainland China.

import { parseLocation, resolveCountry } from '../../features/jobs/geo/index.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import type { FormatMarket } from '../catalog/interviewFormats.js';
import { MARKET_NORMS, marketForCountry, resolveMarketNorms, type InterviewMarketKey } from '../skills/index.js';

export interface PrepMarketContext {
  brand: ProductBrand;
  /** The format list the brand offers ('cn' adds GoApply's AI-interview format). */
  formatMarket: FormatMarket;
  /** ISO 3166-1 alpha-2 of the job market, when known. */
  country: string | null;
  marketKey: InterviewMarketKey;
  marketLabel: string;
}

const LOCALE_COUNTRY: Record<string, string> = { 'zh-TW': 'TW', ja: 'JP', ko: 'KR', de: 'DE', fr: 'FR' };

/**
 * The country named in a posting's location ("Tokyo, Japan", "Remote - Germany", "上海"), or null.
 * Read like the job normalizers read it, so a US "<city>, <state>" is the United States
 * ("Denver, CO" is not Colombia, "Wilmington, DE" is not Germany).
 */
export function countryFromLocation(location: string | null | undefined): string | null {
  const text = (location ?? '').trim();
  return text ? parseLocation(text).country : null;
}

export interface MarketContextDeps {
  /** The country of the user's active job search, else their profile country. */
  userCountry?: (userId: string) => Promise<string | null>;
}

async function defaultUserCountry(userId: string): Promise<string | null> {
  const prisma = (await import('../../lib/prisma.js')).default;
  const [search, profile] = await Promise.all([
    prisma.rASearchProfile
      .findFirst({ where: { userId, isActive: true }, select: { filters: true } })
      .catch(() => null),
    prisma.rAProfile.findUnique({ where: { userId }, select: { country: true } }).catch(() => null),
  ]);
  const filters = (search?.filters && typeof search.filters === 'object' ? search.filters : {}) as Record<string, unknown>;
  const fromSearch = typeof filters.country === 'string' ? filters.country : null;
  const firstLocation = Array.isArray(filters.locations) ? (filters.locations[0] as Record<string, unknown> | undefined) : undefined;
  const fromLocation = firstLocation && typeof firstLocation.country === 'string' ? firstLocation.country : null;
  for (const candidate of [fromSearch, fromLocation, profile?.country ?? null]) {
    const hit = candidate ? resolveCountry(candidate) : null;
    if (hit) return hit.code;
  }
  return null;
}

export async function resolvePrepMarket(
  input: { userId: string; brand: ProductBrand; locale: string; countryHint?: string | null },
  deps: MarketContextDeps = {},
): Promise<PrepMarketContext> {
  const formatMarket: FormatMarket = input.brand.market === 'cn' ? 'cn' : 'intl';
  if (formatMarket === 'cn') {
    return { brand: input.brand, formatMarket, country: 'CN', marketKey: 'cn', marketLabel: MARKET_NORMS.cn.labelEn };
  }
  const hinted = input.countryHint ? resolveCountry(input.countryHint)?.code ?? null : null;
  const userCountry = hinted ? null : await (deps.userCountry ?? defaultUserCountry)(input.userId).catch(() => null);
  const country =
    hinted ??
    userCountry ??
    LOCALE_COUNTRY[input.locale] ??
    (input.brand.defaultCountry ? input.brand.defaultCountry.toUpperCase() : null);
  const norms = resolveMarketNorms({ country, brandMarket: input.brand.market, language: input.locale });
  return {
    brand: input.brand,
    formatMarket,
    country,
    marketKey: norms.key,
    marketLabel: country && !marketForCountry(country) ? `${country} (${norms.labelEn} norms)` : norms.labelEn,
  };
}
