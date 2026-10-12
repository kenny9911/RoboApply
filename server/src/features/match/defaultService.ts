// server/src/features/match/defaultService.ts — the production MatchService
// instance (Prisma repo, lazy model/consent/credit/rate-limit dependencies)
// and the competitiveness report service on top of it (WP-77).
// Separate from index.ts so cron.ts and workers.ts can use it without an
// import cycle through the area's public surface.
//
// The skill vocabulary is registered here as a match preparer (prepare.ts):
// the estimate is synchronous and compares canonical skill ids, so the table
// behind them (RASkill over the committed seed) is read once before the first
// estimate of the process. `ready()` never rejects: when the table cannot be
// read the estimate runs on the committed seed and the read is tried again
// later, in the background (features/skills/vocabulary.ts).

import { ready as skillVocabularyReady } from '../skills/index.js';
import { createCompetitivenessService, type CompetitivenessService } from './CompetitivenessService.js';
import { createMatchService, type MatchService } from './MatchService.js';
import { registerMatchPreparer, type MatchPreparer } from './prepare.js';
import { createPrismaMatchRepo, type MatchRepo } from './repo.js';

/** The loader `MatchService.userContext` awaits before the first estimate. One function, so it is registered once. */
export const loadSkillVocabulary: MatchPreparer = () => skillVocabularyReady();
registerMatchPreparer(loadSkillVocabulary);

export const defaultMatchRepo: MatchRepo = createPrismaMatchRepo();

/**
 * The keyword check says which vocabulary answered (`vocabularyAsOf`, set by
 * `MatchService.keywordCheck` itself since the M4 gate), so a support question
 * can tell a check made on the committed seed from one made on the reviewed table.
 */
export const defaultMatchService: MatchService = createMatchService({ repo: defaultMatchRepo });

export const defaultCompetitivenessService: CompetitivenessService = createCompetitivenessService({
  userContext: async (userId) => (await defaultMatchService.userContext(userId)).user,
  getJobs: (ids) => defaultMatchRepo.getJobs(ids),
});
