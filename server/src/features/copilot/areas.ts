// server/src/features/copilot/areas.ts — the default `CopilotAreas` (WP-50).
//
// Every method calls another area through its public `index.ts` (TASK_PLAN
// §2.1 rule 4), loaded lazily so the Assistant does not pull every area into
// memory at boot. Same-wave seams that are still stubs (network, prep,
// campus) throw NotImplementedError; the tools turn that into "not available
// yet" for the model.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { Market } from '../../platform/brand/registry.js';
import { cnRecruitmentInfoMode } from '../../platform/flags.js';
import type { CopilotAreas } from './types.js';
import { salaryStats } from './salaryStats.js';
import type { CopilotStore } from './store.js';

export function createDefaultAreas(options: { store: CopilotStore; env?: EnvSource }): CopilotAreas {
  const env = (): EnvSource => options.env ?? process.env;
  return {
    async feedPreview(userId, input) {
      const { feedService } = await import('../feed/index.js');
      return feedService.preview(userId, input);
    },
    async feedPublicList(input) {
      const { feedService } = await import('../feed/index.js');
      return feedService.publicList(input);
    },
    async countForFilters(userId, filters) {
      const { countForFilters } = await import('../feed/index.js');
      return countForFilters(userId, filters);
    },
    async activeSearchProfile(userId) {
      const { searchProfileService } = await import('../search/index.js');
      return searchProfileService.getActive(userId);
    },
    async searchProfile(userId, id) {
      const { searchProfileService } = await import('../search/index.js');
      return searchProfileService.get(userId, id);
    },
    async patchFilters(userId, searchProfileId, version, patch) {
      const { searchProfileService } = await import('../search/index.js');
      return searchProfileService.patchFilters(userId, searchProfileId, version, patch);
    },
    async getJob(userId, jobId) {
      const { jobDetailService } = await import('../jobs/detail/index.js');
      return jobDetailService.get(userId, jobId);
    },
    async scoreJob(userId, jobId, opts) {
      const { matchService } = await import('../match/index.js');
      // Free, platform-paid score (80/day/user, then the quick estimate); never a credit.
      return matchService.scoreJob(userId, jobId, { resumeVariantId: opts.resumeVariantId ?? undefined, locale: opts.locale, mode: 'on_demand' });
    },
    async companyProfile(idOrSlug) {
      const [{ companyService }, { getCurrentBrandOrDefault }] = await Promise.all([import('../jobs/companies/index.js'), import('../../platform/brand/index.js')]);
      // A signed-in viewer (WP-16b): not the anonymous count. GoApply mode `off` hides third-party postings from the count.
      if (getCurrentBrandOrDefault().market === 'cn') {
        const { cnPostingsWhere } = await import('../cn/jobs/index.js');
        const { getCurrentUserId } = await import('../../lib/requestContext.js');
        return companyService.profile(idOrSlug, { publicOnly: false, restrict: cnPostingsWhere(getCurrentUserId() ?? null, env()) });
      }
      return companyService.profile(idOrSlug, { publicOnly: false });
    },
    async connectionsForJob(userId, jobId) {
      const { networkService } = await import('../network/index.js');
      return networkService.connectionsForJob(userId, jobId);
    },
    async planForJob(userId, jobId) {
      const { prepService } = await import('../prep/index.js');
      return prepService.planForJob(userId, jobId);
    },
    async trackerSummary(userId) {
      const { trackerService } = await import('../tracker/index.js');
      return trackerService.summary(userId);
    },
    async profileCompleteness(userId) {
      const { profileService } = await import('../profile/index.js');
      return profileService.completeness(userId);
    },
    async profileSnapshot(userId) {
      const { profileSnapshotForLlm } = await import('../profile/index.js');
      const snap = await profileSnapshotForLlm(userId);
      return snap.text?.trim() ? snap.text : null;
    },
    primaryResumeId: (userId) => options.store.primaryResumeId(userId),
    async resumeLatestGrade(userId, resumeId) {
      const { getResumeCheckService } = await import('../resume/index.js');
      return getResumeCheckService().latest(userId, resumeId);
    },
    async campusUpcoming(userId, opts) {
      const { campusService } = await import('../cn/campus/index.js');
      return campusService.upcomingForUser(userId, opts);
    },
    async salaryStats(input) {
      const { default: prisma } = await import('../../lib/prisma.js');
      return salaryStats(prisma, input);
    },
    postingsAllowed(market: Market) {
      // R-14: GoApply lists third-party postings only when the mode is not `off`
      // (the same reader cn/jobs `cnJobCapabilities().postings` uses).
      return market !== 'cn' || cnRecruitmentInfoMode(env()) !== 'off';
    },
    async createTailorSession(userId, input) {
      const { resumeSuiteService } = await import('../resume/index.js');
      return resumeSuiteService.createTailorSession(userId, { baseVariantId: input.baseVariantId, jobId: input.jobId, idempotencyKey: input.idempotencyKey, mode: 'fast', locale: input.locale });
    },
    async createCoverLetter(userId, input, idempotencyKey) {
      const { coverLetterService } = await import('../coverletter/index.js');
      return coverLetterService.createLetter(userId, input, idempotencyKey);
    },
    async importJob(userId, body, idempotencyKey) {
      const { jobImportService } = await import('../jobs/import/index.js');
      return jobImportService.importJob(userId, body, idempotencyKey);
    },
    async saveImportedJob(userId, fields, opts) {
      const { jobImportService } = await import('../jobs/import/index.js');
      return jobImportService.saveJob(userId, fields, { source: 'assistant', importId: opts.importId, idempotencyKey: opts.idempotencyKey });
    },
    async fixResumeIssue(userId, resumeId, issueId, input) {
      const { getResumeCheckService } = await import('../resume/index.js');
      return getResumeCheckService().fixIssue(userId, resumeId, issueId, {
        variant: input.variant,
        instruction: input.instruction,
        idempotencyKey: input.idempotencyKey,
        locale: input.locale,
      });
    },
  };
}
