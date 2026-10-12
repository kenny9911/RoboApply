// lib/brand/tokens.ts
//
// Brand-name tokens in message bundles (ARCHITECTURE.md §1.7). next-intl has
// no global default interpolation values, so bundles carry the literal tokens
// `%BRAND%` (this brand's product name) and `%OTHER_BRAND%` (the other
// brand's, for nudges). ICU treats `%` as a literal, so messages stay valid
// ICU. lib/i18n.ts `loadMessages(locale, brandId)` substitutes them; tests
// that read a raw bundle use `substituteBrandTokens` the same way.
//
// Client-safe: no bundle imports, no env.

import { getBrand, type BrandId } from './registry.generated';

export const BRAND_TOKEN = '%BRAND%';
export const OTHER_BRAND_TOKEN = '%OTHER_BRAND%';

const BRAND_RE = /%BRAND%/g;
const OTHER_BRAND_RE = /%OTHER_BRAND%/g;

/** Replace the tokens in one string. */
export function substituteBrandString(text: string, brandId: BrandId): string {
  if (!text.includes('%')) return text;
  const brand = getBrand(brandId);
  return text
    .replace(OTHER_BRAND_RE, getBrand(brand.otherBrand).name)
    .replace(BRAND_RE, brand.name);
}

/**
 * Deep-replace the tokens in every string of a JSON-like value (objects,
 * arrays, strings). Returns a new value; the input is not mutated. Keys are
 * left alone.
 */
export function substituteBrandTokens<T>(value: T, brandId: BrandId): T {
  return walk(value, brandId) as T;
}

function walk(value: unknown, brandId: BrandId): unknown {
  if (typeof value === 'string') return substituteBrandString(value, brandId);
  if (Array.isArray(value)) return value.map((v) => walk(v, brandId));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, brandId);
    return out;
  }
  return value;
}
