// server/src/features/coaching/index.ts — public surface (FND-5; owner WP-72).
// `hasActiveCoaches(brand)` drives the nav entry (flag `coaching` + non-empty roster).

import { NotImplementedError } from '../../platform/http.js';

export * from './contract.js';
export { createCoachingRouter } from './routes.js';
export { createCoachingAdminRouter } from './adminRoutes.js';

export interface CoachingService {
  hasActiveCoaches(brand: 'roboapply' | 'goapply'): Promise<boolean>;
}

export const coachingService: CoachingService = {
  async hasActiveCoaches() {
    throw new NotImplementedError('coaching.hasActiveCoaches');
  },
};
