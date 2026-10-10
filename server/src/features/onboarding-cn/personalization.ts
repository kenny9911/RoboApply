// server/src/features/onboarding-cn/personalization.ts — the 个性化推荐 answer (PIPL Art. 24).
//
// GoApply users choose 开启 or 关闭 on G1 (no default). Until they choose, or
// when they choose 关闭, jobs are ordered by recency and filters only, with no
// fit scores. The choice is the latest `personalized_recommendation` consent
// record (changeable any time in Settings → consents), so this reads the
// ledger, not the onboarding answers. RoboApply always ranks with the profile.
//
// The feed does not call this module. Its own `isFeedPersonalized`
// (features/feed/index.ts) is the single rule for non-personalised order:
// it decides the order and nulls every fit, and onboarding's "Finding jobs"
// step asks it too. The feed-level test is
// server/src/features/feed/personalization.cn.test.ts. What stays here is the
// pure mode logic and the ledger read behind `onboardingCnService.rankingMode`.

import prisma from '../../lib/prisma.js';
import type { BrandId } from '../../platform/brand/registry.js';
import type { CnRankingMode } from './contract.js';

export type PersonalizationDb = Pick<typeof prisma, 'seekerProfile' | 'seekerConsentRecord'>;

/** Pure: the ranking mode for a brand and the user's latest choice (null = never answered). */
export function rankingModeFor(brand: BrandId, choice: boolean | null | undefined): CnRankingMode {
  if (brand === 'roboapply') return 'personalized';
  return choice === true ? 'personalized' : 'non_personalized';
}

/** Sorts that use the profile (fit) fall back to newest when personalisation is off. */
export function feedSortFor<S extends string>(requested: S, mode: CnRankingMode): S | 'newest' {
  if (mode === 'personalized') return requested;
  return requested === 'recommended' || requested === 'best_fit' ? 'newest' : requested;
}

/** The latest 个性化推荐 answer in the consent ledger, or null when never answered. */
export async function personalizedChoice(userId: string, db: PersonalizationDb = prisma): Promise<boolean | null> {
  const profile = await db.seekerProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!profile) return null;
  const latest = await db.seekerConsentRecord.findFirst({
    where: { seekerProfileId: profile.id, consentType: 'personalized_recommendation' },
    orderBy: { createdAt: 'desc' },
    select: { granted: true },
  });
  return latest ? latest.granted : null;
}

/** The feed seam: may this user's feed be ranked with their profile? */
export async function rankingModeForUser(userId: string, brand: BrandId, db: PersonalizationDb = prisma): Promise<CnRankingMode> {
  if (brand === 'roboapply') return 'personalized';
  return rankingModeFor(brand, await personalizedChoice(userId, db));
}
