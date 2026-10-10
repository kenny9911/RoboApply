// server/src/features/match/defaultService.ts — the production MatchService
// instance (Prisma repo, lazy model/consent/credit/rate-limit dependencies)
// and the competitiveness report service on top of it (WP-77).
// Separate from index.ts so cron.ts and workers.ts can use it without an
// import cycle through the area's public surface.

import { createCompetitivenessService, type CompetitivenessService } from './CompetitivenessService.js';
import { createMatchService, type MatchService } from './MatchService.js';
import { createPrismaMatchRepo, type MatchRepo } from './repo.js';

export const defaultMatchRepo: MatchRepo = createPrismaMatchRepo();
export const defaultMatchService: MatchService = createMatchService({ repo: defaultMatchRepo });
export const defaultCompetitivenessService: CompetitivenessService = createCompetitivenessService({
  userContext: async (userId) => (await defaultMatchService.userContext(userId)).user,
  getJobs: (ids) => defaultMatchRepo.getJobs(ids),
});
