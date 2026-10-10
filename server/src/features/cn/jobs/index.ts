// server/src/features/cn/jobs/index.ts — public surface of GoApply jobs (FND-5; owner WP-41).
//
// For other areas (import only from here):
//   - mode gate (R-14): `cnJobCapabilities`, `cnPostingVisible`,
//     `filterCnPostings`, `assertCnPostingVisible`, `cnPostingsWhere`,
//     `requireCnRecruitmentInfo` — job readers that are not flag-gated as a
//     whole (job detail, company jobs, tracker job cards, SEO job pages) use
//     these so mode `off` never returns a third-party posting on GoApply;
//   - fraud: `cnImportWarnings(job)` (WP-35, after marketHooks.afterNormalize
//     with stage 'import'), `hasCnFraudFlags(fraudFlags)`, `CN_FRAUD_RULES`;
//   - card: `buildCnCardMeta` (what marketHooks.cardMeta returns under `cn`),
//     `isDirectFromEmployer` (企业直招 rule);
//   - deep links: `buildExternalSearchLinks`.

export * from './contract.js';
export { createCnJobsAdminRouter, createCnJobsRouter } from './routes.js';
export { cnJobsHooks, createCnJobsHooks } from './hooks.js';
export { CN_JOBS_WORK_KINDS } from './workers.js';
export {
  assertCnPostingVisible,
  cnJobCapabilities,
  cnPostingVisible,
  cnPostingsWhere,
  cnRecruitmentMode,
  filterCnPostings,
  isThirdPartyPosting,
  requireCnRecruitmentInfo,
} from './mode.js';
export type { CnJobCapabilities, CnPostingLike, CnRecruitmentInfoMode } from './mode.js';
export { GOHIRE_SOURCE_NAME, buildCnCardMeta, cnSalary, formatCnSalary, isDirectFromEmployer } from './card.js';
export { buildExternalSearchLinks } from './deeplinks.js';
export { cnFlagsOf } from './fraud/flags.js';
export { detectCnFraudSignals } from './fraud/keywords.js';
export { cnImportWarnings } from './service.js';

import { cnFlagsOf } from './fraud/flags.js';

/** True when a stored `fraudFlags` value carries any GoApply fraud flag. */
export function hasCnFraudFlags(fraudFlags: unknown): boolean {
  return cnFlagsOf(fraudFlags).length > 0;
}
