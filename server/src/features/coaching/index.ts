// server/src/features/coaching/index.ts — public surface (FND-5; owner WP-72).
// `hasActiveCoaches(brand)` drives the nav entry and every coaching upsell
// (flag `coaching` + a non-empty roster).

import { getCoachingService } from './service.js';

export * from './contract.js';

export interface CoachingService {
  hasActiveCoaches(brand: 'roboapply' | 'goapply'): Promise<boolean>;
}

/** Cross-area surface: true when the brand's roster lists at least one reachable coach. */
export const coachingService: CoachingService = {
  async hasActiveCoaches(brand) {
    return getCoachingService().hasActiveCoaches(brand);
  },
};
