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
//
// Fits (MKT-4H): `fits` is the list read, ONE batch call of the fit contract
// behind the feed's own personalisation rule (GoApply: no fit is read or shown
// without a live 个性化推荐 grant), so a job list in the Assistant shows the
// number the feed card and the job page show. `similarJobs` is the job page's
// Similar jobs list; see the note on it below.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { Market } from '../../platform/brand/registry.js';
import { cnRecruitmentInfoMode } from '../../platform/flags.js';
import type { FitFunctions, MatchFitView } from '../match/index.js';
import type { JobDetailService, SimilarJobsResponse } from '../jobs/detail/index.js';
import type { CopilotAreas } from './types.js';
import type { FeedItem, FeedPreviewInput, SalaryStatsInput, SalaryStatsResult } from '../feed/index.js';
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
  /** Test seam: the fit contract on other dependencies (default: match/fit.ts `getFit` / `getFits` / `getVariantFit`). */
  fits?: Pick<FitFunctions, 'getFit' | 'getVariantFit'> & Partial<Pick<FitFunctions, 'getFits'>>;
  /** Test seam: may this person's fit be read for a list? (default: feed `isFeedPersonalized`.) */
  personalized?: (userId: string, market: Market) => Promise<boolean>;
  /** Test seam: the job page's service (default: jobs/detail `jobDetailService`). */
  jobDetail?: JobDetailSeam;
  /** Test seam: the feed's list read (default: feed `feedService.preview`). */
  feedPreview?: (userId: string, input: FeedPreviewInput) => Promise<FeedItem[]>;
}

/**
 * What the Assistant reads of job detail's public surface. `similar` is the
 * job page's Similar jobs list (`GET /jobs/:id/similar`). The surface
 * (`jobDetailService` in jobs/detail/index.ts) does not offer it yet, so it is
 * read when present; see `similarJobs` below.
 */
export type JobDetailSeam = Pick<JobDetailService, 'get'> & { similar?: (userId: string, jobId: string) => Promise<SimilarJobsResponse> };

/** Rows asked of the feed for the title search that stands in for Similar jobs (one more than a list shows: the job itself may be among them). */
const SIMILAR_BY_TITLE_ROWS = 9;

export function createDefaultAreas(options: DefaultAreasOptions): CopilotAreas {
  const env = (): EnvSource => options.env ?? process.env;
  const readSalaryStats = options.reads?.salaryStats ?? CROSS_AREA_DEFAULTS.salaryStats();
  const readPrimaryResumeId = options.reads?.primaryResumeId ?? CROSS_AREA_DEFAULTS.primaryResumeId();
  const preview = async (userId: string, input: FeedPreviewInput): Promise<FeedItem[]> => {
    if (options.feedPreview) return options.feedPreview(userId, input);
    const { feedService } = await import('../feed/index.js');
    return feedService.preview(userId, input);
  };
  const jobDetail = async (): Promise<JobDetailSeam> => options.jobDetail ?? (await import('../jobs/detail/index.js')).jobDetailService;
  return {
    feedPreview: (userId, input) => preview(userId, input),
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
      return (await jobDetail()).get(userId, jobId);
    },
    // THE fit (match/fit.ts), so the Assistant and the job page say one number. `fit` and `storedFit` are for the
    // person's PRIMARY resume whatever resume is attached to the chat thread. `variantFit` is called only by
    // analyze_fit's explicit version question ("how does my tailored resume fit"): that answer is the separately
    // named measure "With this version" (`getVariantFit`), never the fit.
    async fit(userId, jobId, opts) {
      const match = await import('../match/index.js');
      // Free, platform-paid score (80/day/user, then the quick estimate); never a credit.
      const call = { allowModelCall: true, mode: 'on_demand', locale: opts.locale } as const;
      return match.fitToView(await (options.fits ?? match).getFit(userId, jobId, call), { locale: opts.locale });
    },
    async variantFit(userId, jobId, variantId, opts) {
      const match = await import('../match/index.js');
      const call = { allowModelCall: true, mode: 'on_demand', locale: opts.locale } as const;
      return match.fitToView(await (options.fits ?? match).getVariantFit(userId, jobId, variantId, call), { locale: opts.locale });
    },
    async storedFit(userId, jobId, opts) {
      const match = await import('../match/index.js');
      // The stored score the job page and the lists show, else the quick estimate. Never a model call, never a version.
      return match.fitToView(await (options.fits ?? match).getFit(userId, jobId, { locale: opts.locale }), { locale: opts.locale });
    },
    // The fits of a list: one batch read, never a model call, and under the same rule as the feed card's fit.
    async fits(userId, jobIds, opts) {
      const out = new Map<string, MatchFitView>();
      const ids = [...new Set(jobIds)];
      if (!ids.length) return out;
      const [match, { getCurrentBrandOrDefault }] = await Promise.all([import('../match/index.js'), import('../../platform/brand/index.js')]);
      // GoApply: no fit is read or shown without a live 个性化推荐 grant (MARKET_STRATEGY 2.5; the feed's own rule).
      const personalized = options.personalized ?? (await import('../feed/index.js')).isFeedPersonalized;
      if (!(await personalized(userId, getCurrentBrandOrDefault().market))) return out;
      const read = options.fits?.getFits ?? match.getFits;
      for (const [jobId, fit] of await read(userId, ids)) out.set(jobId, match.fitToView(fit, { locale: opts.locale }));
      return out;
    },
    // The job page's Similar jobs list (by job vector since MKT-2F / MKT-2H, best fit first). Job detail's public
    // surface offers `get` only today, so `similar` is read when the surface has it (the Request in
    // docs/jobright-clone/orch/handoffs-mkt/MKT-4H.md adds it there). Until then the answer is what the Similar
    // jobs quick action did before: a search by the job's title through the feed, said as such (`by: 'title'`).
    async similarJobs(userId, jobId) {
      const detail = await jobDetail();
      if (typeof detail.similar === 'function') return { items: (await detail.similar(userId, jobId)).items, by: 'similar' };
      const { job } = await detail.get(userId, jobId);
      const items = await preview(userId, { q: job.title, limit: SIMILAR_BY_TITLE_ROWS });
      return { items: items.filter((item) => item.jobId !== jobId), by: 'title' };
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
