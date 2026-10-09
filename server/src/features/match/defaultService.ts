// server/src/features/match/defaultService.ts — the production MatchService
// instance (Prisma repo, lazy model/consent/credit/rate-limit dependencies).
// Separate from index.ts so cron.ts and workers.ts can use it without an
// import cycle through the area's public surface.

import { createMatchService, type MatchService } from './MatchService.js';
import { createPrismaMatchRepo, type MatchRepo } from './repo.js';

export const defaultMatchRepo: MatchRepo = createPrismaMatchRepo();
export const defaultMatchService: MatchService = createMatchService({ repo: defaultMatchRepo });
