// server/src/features/jobs/detail/defaultService.ts — the production job-detail
// service: Prisma, the brand context, and the other areas' public surfaces,
// loaded lazily so importing the router (features/index.ts mounts it at
// boot) pulls in no LLM, queue or growth module until a request needs one.

import prisma from '../../../lib/prisma.js';
import { getCurrentBrandOrDefault } from '../../../platform/brand/index.js';
import type { ProductBrand } from '../../../platform/brand/registry.js';
import { FLAG_KEYS, hiringContactsMode, isEnabled, loadUserFlagOverrides, type FlagKey } from '../../../platform/flags.js';
import { consentTypeSpellings } from '../../../roboapply/engine/lib/seekerConsentTypes.js';
import { cardMeta } from '../marketHooks.js';
import { explainMatch } from '../../compliance/index.js';
import type { MatchFitView } from '../../match/contract.js';
import { searchCompanyNews } from './newsSearch.js';
import { isByFilters } from '../../match/index.js';
import { createJobDetailService, type DetailFlag, type JobDetailServiceImpl, type SimilarSourceRow } from './service.js';
import type { JobRow } from './view.js';

/** ATS types the extension can fill. Empty until the extension registers its adapters (WP-55a/WP-70). */
const extensionAtsTypes = new Set<string>();
type ExtensionFillsJob = (market: 'intl' | 'cn', atsType: string, applyUrl: string | null) => boolean;
let extensionFillsJob: ExtensionFillsJob | null = null;

/**
 * Extension point: the extension area registers the ATS types it can fill
 * and, optionally, the check that the brand's extension runs on a job's
 * application page (market, adapter host patterns, page-by-page forms).
 */
export function registerExtensionAtsTypes(types: Iterable<string>, fillsJob?: ExtensionFillsJob): void {
  for (const t of types) if (t) extensionAtsTypes.add(t);
  if (fillsJob) extensionFillsJob = fillsJob;
}

/** A flag the resolver does not know yet (e.g. `companyNews` before INT adds it) is off. */
async function detailFlag(key: DetailFlag, userId: string): Promise<boolean> {
  if (!(FLAG_KEYS as readonly string[]).includes(key)) return false;
  return isEnabled(key as FlagKey, { userId });
}

/** The practice seam the "Practiced" step reads: job id → when the user last completed a practice for it. */
export type PracticedJobsSeam = (userId: string, jobIds: string[]) => Promise<Record<string, string>>;

/**
 * The job page's "Practiced" step (SR-34-1): true once the user completed a
 * practice for this job — a live (voice / video) session or a written
 * practice (GoApply without voice; `RAMockSession.jobId`). Both come from the
 * interview area's one seam, so the page and the practice history agree.
 */
export function practicedForJobFrom(practicedJobs: PracticedJobsSeam): (userId: string, jobId: string) => Promise<boolean> {
  return async (userId, jobId) => Boolean((await practicedJobs(userId, [jobId]))[jobId]);
}

/** Production seam: `interviewSessionService.practicedJobs` (loaded on first use; the interview engine is heavy). */
export const defaultPracticedJobs: PracticedJobsSeam = async (userId, jobIds) => {
  const { interviewSessionService } = await import('../../../interview-engine/sessions/InterviewSessionService.js');
  return interviewSessionService.practicedJobs(userId, jobIds);
};

async function personalized(userId: string, brand: ProductBrand): Promise<boolean> {
  if (brand.market !== 'cn') return true;
  const latest = await prisma.seekerConsentRecord.findFirst({
    where: { seekerProfile: { userId }, consentType: { in: consentTypeSpellings('personalized_recommendation') } },
    orderBy: { createdAt: 'desc' },
    select: { granted: true },
  });
  return latest?.granted === true;
}

function createDefault(): JobDetailServiceImpl {
  return createJobDetailService({
    db: prisma,
    brand: getCurrentBrandOrDefault,
    companyProfile: async (companyId) => (await import('../companies/index.js')).companyService.profile(companyId, { publicOnly: false }),
    // THE fit (match/fit.ts): one job with no model call, and a list. The same functions every other surface reads.
    fit: async (userId, jobId) => (await import('../../match/index.js')).getFit(userId, jobId),
    fits: async (userId, jobIds) => (await import('../../match/index.js')).getFits(userId, jobIds),
    similarSource: (row, limit) => similarFromFeed(row, limit),
    explain: ({ market, personalized: p, fit }) => explainNow({ market, personalized: p, fit }),
    personalized,
    peopleContext: async (userId) => {
      const { profileService } = await import('../../profile/index.js');
      const p = await profileService.get(userId);
      return { pastCompanies: p.experience.map((e) => e.company), schools: p.education.map((e) => e.school) };
    },
    practicedForJob: practicedForJobFrom(defaultPracticedJobs),
    markChecklistStep: async (userId, step) => (await import('../../growth/index.js')).markChecklistStep(userId, step),
    recordInteraction: async (userId, jobId, kind) => (await import('../../feed/index.js')).feedService.recordInteraction(userId, jobId, kind),
    isEnabled: detailFlag,
    hiringContacts: async (userId) => hiringContactsMode(getCurrentBrandOrDefault(), process.env, await loadUserFlagOverrides(userId)),
    marketMeta: (row: JobRow, brand) => cardMeta({ ...row, market: brand.market }, { brand: brand.id, market: brand.market, stage: 'card' }),
    searchNews: (brand, name) => searchCompanyNews(brand, name),
    extensionAts: () => extensionAtsTypes,
    extensionFillsJob: () => extensionFillsJob,
    log: (message, meta) => {
      // eslint-disable-next-line no-console
      console.warn(`[jobs.detail] ${message}`, meta);
    },
  });
}

/**
 * "Why this job" for the job page, from the same fit the page shows. A
 * logistics part that only repeats the person's own filters carries no
 * information of its own, so it is left out, as on the feed card
 * (`isByFilters`): otherwise the page would say "Not enough to compare the
 * location, pay or work setup" about a job whose place is the one they asked for.
 */
export function explainNow(input: { market: 'intl' | 'cn'; personalized: boolean; fit: MatchFitView }) {
  return explainMatch({
    market: input.market,
    personalized: input.personalized,
    score: input.fit.score,
    tier: input.fit.tier,
    kind: input.fit.kind,
    dimensions: input.fit.dimensions.filter((d) => !isByFilters(d)),
    skills: { aligned: input.fit.skills.aligned, missing: input.fit.skills.missing },
  });
}

/** The vector read as the feed area exports it: `similarJobIds(row, limit)` (MARKET_TASK_PLAN 3.3, "Feed pre-wiring"). */
type SimilarJobIds = (row: SimilarSourceRow, limit: number) => Promise<string[] | null>;

/**
 * The feed area, loaded when Similar jobs is first asked for. Typed since the
 * M2 gate (both halves are merged): if `feed/index.ts` drops `similarJobIds`
 * or changes what it takes or answers, the server type-check fails HERE.
 */
async function loadFeedArea(): Promise<{ similarJobIds: SimilarJobIds }> {
  return import('../../feed/index.js');
}

/**
 * Similar jobs by job vector, through the feed area's seam. `loadFeed` is the
 * test seam; whatever it returns is still read defensively, so a module
 * without the export (or one whose export answers null) gives null and the
 * service lists the same-role jobs.
 */
export async function similarFromFeed(
  row: SimilarSourceRow,
  limit: number,
  loadFeed: () => Promise<unknown> = loadFeedArea,
): Promise<string[] | null> {
  const feed = (await loadFeed()) as { similarJobIds?: SimilarJobIds } | null | undefined;
  const fn = feed?.similarJobIds;
  return typeof fn === 'function' ? fn(row, limit) : null;
}

let instance: JobDetailServiceImpl | null = null;
export function defaultJobDetailService(): JobDetailServiceImpl {
  return (instance ??= createDefault());
}
