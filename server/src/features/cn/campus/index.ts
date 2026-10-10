// server/src/features/cn/campus/index.ts — public surface of the campus calendar (FND-5; owner WP-58).
// The Assistant's campus_deadlines tool (GoApply) calls `upcomingForUser`.

import { getBrand } from '../../../platform/brand/index.js';
import type { CampusEventView } from './contract.js';
import { defaultCampusDeps, upcomingForUser, type CampusServiceDeps } from './service.js';

export * from './contract.js';
export { createCampusAdminRouter, createCampusEventsRouter, createCampusPublicRouter } from './routes.js';
export type { CampusRouterDeps } from './routes.js';
export { produceCampusReminders, notifyFollowers } from './notify.js';

export interface CampusService {
  /**
   * The user's reminded programmes still ahead, then open programmes of their
   * 届别 (GoApply market), closing soonest first. Published, verified rows only.
   */
  upcomingForUser(userId: string, options?: { limit?: number }): Promise<CampusEventView[]>;
}

let deps: CampusServiceDeps | null = null;

export const campusService: CampusService = {
  async upcomingForUser(userId, options = {}) {
    deps ??= defaultCampusDeps();
    return upcomingForUser(deps, getBrand('goapply').market, userId, Math.min(Math.max(options.limit ?? 10, 1), 50));
  },
};
