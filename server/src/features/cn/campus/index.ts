// server/src/features/cn/campus/index.ts — public surface of the campus calendar (FND-5; owner WP-58).
// The Assistant's campus_deadlines tool (GoApply) calls `upcomingForUser`.

import { NotImplementedError } from '../../../platform/http.js';
import type { CampusEventView } from './contract.js';

export * from './contract.js';
export { createCampusAdminRouter, createCampusEventsRouter, createCampusPublicRouter } from './routes.js';

export interface CampusService {
  upcomingForUser(userId: string, options?: { limit?: number }): Promise<CampusEventView[]>;
}

export const campusService: CampusService = {
  async upcomingForUser() {
    throw new NotImplementedError('campus.upcomingForUser');
  },
};
