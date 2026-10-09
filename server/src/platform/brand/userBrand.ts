// server/src/platform/brand/userBrand.ts
//
// The stored brand of a user (`User.brand`), for code that has a user id but
// no trustworthy brand: a bare-id `aiAllowed(userId)`, a queue item enqueued
// outside any brand context. The ambient context is NOT a substitute there —
// `getCurrentBrandOrDefault()` silently answers RoboApply when no context is
// set, and a drained item without a brand runs as the default brand.
//
// `User.brand` is immutable once written, so a hit is cached for the life of
// the process (bounded). Not-found is not cached.

import { parseBrandId, type BrandId } from './registry.js';

/** Returns the stored brand string for the user, or null when there is no such user. */
export type UserBrandLookup = (userId: string) => Promise<string | null>;

const prismaLookup: UserBrandLookup = async (userId) => {
  const { default: prisma } = await import('../../lib/prisma.js');
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { brand: true } });
  return row?.brand ?? null;
};

let lookup: UserBrandLookup = prismaLookup;
const MAX_CACHED = 10_000;
const cache = new Map<string, BrandId>();

/** Test seam: replace the lookup (null restores the Prisma one); clears the cache. */
export function setUserBrandLookup(next: UserBrandLookup | null): void {
  lookup = next ?? prismaLookup;
  cache.clear();
}

/**
 * The user's brand, or null when the user does not exist or the stored value
 * is not a known brand. Lookup errors propagate: callers decide whether to
 * fail closed.
 */
export async function brandOfUser(userId: string): Promise<BrandId | null> {
  const hit = cache.get(userId);
  if (hit) return hit;
  const brand = parseBrandId(await lookup(userId));
  if (brand) {
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
    cache.set(userId, brand);
  }
  return brand;
}
