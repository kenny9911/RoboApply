// server/src/features/copilot/areas.ts — the default `CopilotAreas` (WP-50).
//
// Every method calls another area through its public `index.ts` (TASK_PLAN
// §2.1 rule 4), loaded lazily so the Assistant does not pull every area into
// memory at boot. Same-wave seams that are still stubs throw
// NotImplementedError; the tools turn that into "not available yet" for the
// model.
//
// Three reads still go through copilot-local readers instead of the owning
// area's seam. Each is ONE entry of `CROSS_AREA_DEFAULTS` below, so the
// post-merge joins only swap that entry and delete the @deprecated reader:
//   J1  salaryStats   → feed `marketStats.salary`        (then delete ./salaryStats.ts)
//   J1  nudgeSignals  → feed `feedSignals`               (then delete createPrismaNudgeSignals)
//   J2  primaryResumeId → resume `primaryVariantId`      (then delete store.primaryResumeId)
// Nothing else in this area reads those tables.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { Market } from '../../platform/brand/registry.js';
import { cnRecruitmentInfoMode } from '../../platform/flags.js';
import type { CopilotAreas } from './types.js';
import { createPrismaNudgeSignals, type NudgeSignals } from './nudges.js';
import { salaryStats, type SalaryStatsInput, type SalaryStatsResult } from './salaryStats.js';
import type { CopilotStore } from './store.js';

/** The cross-area reads the joins J1/J2 replace (see the file header). */
export interface CrossAreaReads {
  salaryStats(input: SalaryStatsInput): Promise<SalaryStatsResult>;
  nudgeSignals: NudgeSignals;
  primaryResumeId(userId: string): Promise<string | null>;
}

/**
 * Today's readers. J1 and J2 change only this object:
 *   salaryStats:     async (input) => (await import('../feed/index.js')).marketStats.salary(input)
 *   nudgeSignals:    () => lazy feedSignals from '../feed/index.js'
 *   primaryResumeId: () => async (userId) => (await import('../resume/index.js')).primaryVariantId(userId)
 */
export const CROSS_AREA_DEFAULTS: {
  salaryStats: () => CrossAreaReads['salaryStats'];
  nudgeSignals: () => NudgeSignals;
  primaryResumeId: (store: Pick<CopilotStore, 'primaryResumeId'>) => CrossAreaReads['primaryResumeId'];
} = {
  salaryStats: () => async (input) => {
    const { default: prisma } = await import('../../lib/prisma.js');
    return salaryStats(prisma, input);
  },
  nudgeSignals: () => createPrismaNudgeSignals(),
  primaryResumeId: (store) => (userId) => store.primaryResumeId(userId),
};

/** The nudge signals the service uses by default (one place for J1). */
export function defaultNudgeSignals(): NudgeSignals {
  return CROSS_AREA_DEFAULTS.nudgeSignals();
}

export interface DefaultAreasOptions {
  store: CopilotStore;
  env?: EnvSource;
  /** Test and join seam: replace a cross-area read (default: `CROSS_AREA_DEFAULTS`). */
  reads?: Partial<Pick<CrossAreaReads, 'salaryStats' | 'primaryResumeId'>>;
}

export function createDefaultAreas(options: DefaultAreasOptions): CopilotAreas {
  const env = (): EnvSource => options.env ?? process.env;
  const readSalaryStats = options.reads?.salaryStats ?? CROSS_AREA_DEFAULTS.salaryStats();
  const readPrimaryResumeId = options.reads?.primaryResumeId ?? CROSS_AREA_DEFAULTS.primaryResumeId(options.store);
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
    async planForJob(userId, jobId, opts = {}) {
      const { prepService } = await import('../prep/index.js');
      // `write: true` only when the user asked for questions: a missing set is then written
      // (one model call inside prep, its own limits); otherwise the read costs nothing.
      return prepService.planForJob(userId, jobId, opts.locale, opts.write ? { write: true } : undefined);
    },
    async createOutreachDraft(userId, body, idempotencyKey) {
      const { networkService } = await import('../network/index.js');
      return networkService.createOutreachDraft(userId, body, idempotencyKey);
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
    primaryResumeId: (userId) => readPrimaryResumeId(userId),
    async resumeLatestGrade(userId, resumeId) {
      const { getResumeCheckService } = await import('../resume/index.js');
      return getResumeCheckService().latest(userId, resumeId);
    },
    async campusUpcoming(userId, opts) {
      const { campusService } = await import('../cn/campus/index.js');
      return campusService.upcomingForUser(userId, opts);
    },
    salaryStats: (input) => readSalaryStats(input),
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
