// server/src/platform/residency/writeBrand.ts
//
// Which brand owns a residency-critical write (an original resume file, a
// call to the GoHire parse API) when the caller does not say.
//
// The lenient `getCurrentBrandOrDefault()` falls back to RoboApply outside a
// request context. For these writes that would be the wrong failure: a
// GoApply upload handled by a worker or an import job without
// `runWithBrand()` would be stored under RoboApply's keys and lose its
// `goapply/` prefix (or miss GoApply's own bucket). So:
//   1. an explicit brand wins;
//   2. otherwise the brand of the current unit of work (`runWithBrand`, the
//      HTTP brand middleware);
//   3. otherwise the stored brand of the user who owns the data (`User.brand`),
//      when the caller knows the owner (`resolveOwnerWriteBrand`). Every
//      deployment serves both brands unless narrowed (D5), so this is how a
//      worker without a brand context gets the right answer;
//   4. otherwise the brand is implied by the deployment only when there is
//      no doubt: the mainland stack serves GoApply alone, and a deployment
//      locked to one brand (`BRAND_LOCK` / single `ALLOWED_BRANDS`) serves
//      that one;
//   5. otherwise null: the caller writes nothing (fail closed). RoboApply is
//      never guessed on a deployment that serves both brands.

import { getCurrentBrandId } from '../../lib/requestContext.js';
import type { EnvSource } from '../brand/brandEnv.js';
import type { BrandId } from '../brand/registry.js';
import { allowedBrands } from '../brand/runtime.js';
import { brandOfUser } from '../brand/userBrand.js';
import { isCnMainland } from './deployRegion.js';

function contextBrandId(): BrandId | undefined {
  try {
    return getCurrentBrandId();
  } catch {
    // A test that mocks requestContext without this export.
    return undefined;
  }
}

/** Step 4: the brand a deployment implies when it can serve only one. */
function deploymentBrandId(env: EnvSource): BrandId | null {
  if (isCnMainland(env)) return 'goapply';
  const served = allowedBrands(env);
  return served.length === 1 ? served[0]! : null;
}

/**
 * The brand that owns a residency-critical write, or null when it cannot be
 * known. Synchronous: explicit brand, then the unit of work, then the
 * deployment. A caller that knows the owning user uses
 * `resolveOwnerWriteBrand`, which also asks the user's stored brand.
 */
export function resolveWriteBrand(explicit?: BrandId | null, env: EnvSource = process.env): BrandId | null {
  if (explicit) return explicit;
  return contextBrandId() ?? deploymentBrandId(env);
}

/**
 * Like `resolveWriteBrand`, for a write whose owner is known: with no explicit
 * brand and no unit of work, the owner's stored brand decides (a RoboApply
 * user's file goes under RoboApply's keys, a GoApply user's under `goapply/`
 * or in GoApply's own bucket). An owner whose brand this deployment does not
 * serve gets null. A user that does not exist, or a lookup that fails, leaves
 * the deployment rule; with neither the answer is null and the caller writes
 * nothing.
 */
export async function resolveOwnerWriteBrand(
  explicit: BrandId | null | undefined,
  ownerUserId: string | null | undefined,
  env: EnvSource = process.env,
): Promise<BrandId | null> {
  if (explicit) return explicit;
  const fromContext = contextBrandId();
  if (fromContext) return fromContext;
  if (ownerUserId) {
    try {
      const stored = await brandOfUser(ownerUserId);
      // An owner of a brand this deployment does not serve: nothing is written here.
      if (stored) return allowedBrands(env).includes(stored) ? stored : null;
    } catch {
      // The lookup failed: not evidence about the brand. Fall through to the deployment rule.
    }
  }
  return deploymentBrandId(env);
}

/** Thrown when a residency-critical write has no brand (no context, no owner, multi-brand deployment). */
export class WriteBrandUnknownError extends Error {
  readonly code = 'brand_context_missing' as const;
  constructor(what: string) {
    super(`${what}: no brand for this write. Pass the brand or the owning user, or run inside runWithBrand().`);
    this.name = 'WriteBrandUnknownError';
  }
}
