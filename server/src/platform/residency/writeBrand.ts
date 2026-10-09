// server/src/platform/residency/writeBrand.ts
//
// Which brand owns a residency-critical write (an original resume file, a
// call to the GoHire parse API) when the caller does not say.
//
// The lenient `getCurrentBrandOrDefault()` falls back to RoboApply outside a
// request context. For these writes that would be the wrong failure: a
// GoApply upload handled by a worker or a future import job without
// `runWithBrand()` would land in the international bucket. So:
//   1. an explicit brand wins;
//   2. otherwise the brand of the current unit of work (`runWithBrand`, the
//      HTTP brand middleware);
//   3. otherwise the brand is implied by the deployment only when there is
//      no doubt: the mainland stack serves GoApply alone, and a deployment
//      locked to one brand (`BRAND_LOCK` / single `ALLOWED_BRANDS`) serves
//      that one;
//   4. otherwise null — the caller writes nothing (fail closed).

import { getCurrentBrandId } from '../../lib/requestContext.js';
import type { EnvSource } from '../brand/brandEnv.js';
import type { BrandId } from '../brand/registry.js';
import { allowedBrands } from '../brand/runtime.js';
import { isCnMainland } from './deployRegion.js';

function contextBrandId(): BrandId | undefined {
  try {
    return getCurrentBrandId();
  } catch {
    // A test that mocks requestContext without this export.
    return undefined;
  }
}

/** The brand that owns a residency-critical write, or null when it cannot be known. */
export function resolveWriteBrand(explicit?: BrandId | null, env: EnvSource = process.env): BrandId | null {
  if (explicit) return explicit;
  const fromContext = contextBrandId();
  if (fromContext) return fromContext;
  if (isCnMainland(env)) return 'goapply';
  const served = allowedBrands(env);
  return served.length === 1 ? served[0]! : null;
}

/** Thrown when a residency-critical write has no brand (no context, multi-brand deployment). */
export class WriteBrandUnknownError extends Error {
  readonly code = 'brand_context_missing' as const;
  constructor(what: string) {
    super(`${what}: no brand for this write. Pass the brand, or run inside runWithBrand().`);
    this.name = 'WriteBrandUnknownError';
  }
}
