// server/src/features/copilot/areas.ts — the default `CopilotAreas` (WP-50).
//
// Every method calls another area through its public `index.ts` (TASK_PLAN
// §2.1 rule 4), loaded lazily so the Assistant does not pull every area into
// memory at boot. Same-wave seams that are still stubs throw
// NotImplementedError; the tools turn that into "not available yet" for the
// model.
//
// Three reads that used to go through copilot-local readers now use the
// owning area's seam (joins J1 and J2, applied at the INT gate). Each is ONE
// entry of `CROSS_AREA_DEFAULTS` below:
//   J1  salaryStats     → feed `marketStats.salary`
//   J1  nudgeSignals    → feed `feedSignals`
//   J2  primaryResumeId → resume `primaryVariantId`
// This area reads no other area's table itself (guarded by tools.test.ts).

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { Market } from '../../platform/brand/registry.js';
import { cnRecruitmentInfoMode } from '../../platform/flags.js';
import type { FitFunctions } from '../match/index.js';
import type { CopilotAreas } from './types.js';
import type { SalaryStatsInput, SalaryStatsResult } from '../feed/index.js';
import type { NudgeSignals } from './nudges.js';
import type { CopilotStore } from './store.js';

/** The cross-area reads the joins J1/J2 moved onto their owning areas (see the file header). */
export interface CrossAreaReads {
  salaryStats(input: SalaryStatsInput): Promise<SalaryStatsResult>;
  nudgeSignals: NudgeSignals;
  primaryResumeId(userId: string): Promise<string | null>;
}

/**
 * The readers, each through its owning area's index (loaded lazily, like
 * every other call in this file). `marketStats.salary` applies the
 * public-aggregate filter and, on GoApply, the fraud and recruitment-info
 * rules, so the Assistant never repeats them.
 */
export const CROSS_AREA_DEFAULTS: {
  salaryStats: () => CrossAreaReads['salaryStats'];
  nudgeSignals: () => NudgeSignals;
  primaryResumeId: () => CrossAreaReads['primaryResumeId'];
} = {
  salaryStats: () => async (input) => (await import('../feed/index.js')).marketStats.salary(input),
  nudgeSignals: () => ({
    latestRating: async (userId, since) => (await import('../feed/index.js')).feedSignals.latestRating(userId, since),
    reportedSince: async (userId, since) => (await import('../feed/index.js')).feedSignals.reportedSince(userId, since),
  }),
  primaryResumeId: () => async (userId) => (await import('../resume/index.js')).primaryVariantId(userId),
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
  /** Test seam: the fit contract on other dependencies (default: match/fit.ts `getFit` / `getVariantFit`). */
  fits?: Pick<FitFunctions, 'getFit' | 'getVariantFit'>;
}

export function createDefaultAreas(options: DefaultAreasOptions): CopilotAreas {
  const env = (): EnvSource => options.env ?? process.env;
  const readSalaryStats = options.reads?.salaryStats ?? CROSS_AREA_DEFAULTS.salaryStats();
  const readPrimaryResumeId = options.reads?.primaryResumeId ?? CROSS_AREA_DEFAULTS.primaryResumeId();
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
    // THE fit (match/fit.ts), so the Assistant and the job page say one number. Both reads are for the person's
    // PRIMARY resume whatever resume is attached to the chat thread. `resumeVariantId` is set only by analyze_fit's
    // explicit version question ("how does my tailored resume fit"): that answer is the separately named measure
    // "With this version" (`getVariantFit`), never the fit.
    async scoreJob(userId, jobId, opts) {
      const match = await import('../match/index.js');
      const fits = options.fits ?? match;
      // Free, platform-paid score (80/day/user, then the quick estimate); never a credit.
      const call = { allowModelCall: true, mode: 'on_demand', locale: opts.locale } as const;
      const fit = opts.resumeVariantId ? await fits.getVariantFit(userId, jobId, opts.resumeVariantId, call) : await fits.getFit(userId, jobId, call);
      return match.fitToView(fit, { locale: opts.locale });
    },
    async storedFit(userId, jobId, opts) {
      const match = await import('../match/index.js');
      // The stored score the job page and the lists show, else the quick estimate. Never a model call, never a version.
      return match.fitToView(await (options.fits ?? match).getFit(userId, jobId, { locale: opts.locale }), { locale: opts.locale });
    },
    async addedJobs(userId, opts) {
      const { jobImportService } = await import('../jobs/import/index.js');
      // The user's own imports (visibility private, ownerUserId = user): never part of the public lists.
      return (await jobImportService.listAdded(userId, { limit: Math.max(1, Math.min(50, opts.limit)) })).items;
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
