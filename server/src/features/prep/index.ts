// server/src/features/prep/index.ts — public surface of PREP (FND-5; owner WP-59).
//
// Seams:
//   prepService.planForJob(userId, jobId[, locale][, { write }])   the Assistant's
//        `interview_prep` tool (WP-50): AI questions written from the job post +
//        moderated user reports about the company, each with its sourceKind. Read
//        only by default (no model call; status 'not_generated' when no set is
//        stored). Pass `{ write: true }` only when the user asked for practice
//        questions: it writes the missing set (AI and the daily limit allowing).
//        The job → set link is `RAInterviewQuestion.jobId` (SR-59-1), so a set
//        written once is found again after a cold start and on every instance.
//        Show it with a "Practice for this job" link (`/practice?job=<jobId>`,
//        hooks/shared/useLaunchPractice).
//   getPrepService()                                   the full service (routes, tests)

import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { aiAllowed } from '../../platform/consent/aiAllowed.js';
import { isEnabled } from '../../platform/flags.js';
import { DAY, consumeRateLimit, rateLimitKey } from '../../platform/ratelimit/index.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import { getTaskModel } from '../../lib/llm/llmTaskSettings.js';
import { CONTRIBUTIONS_PER_DAY, GUIDE_GENERATIONS_PER_DAY, JOB_SET_GENERATIONS_PER_DAY, REPORTS_PER_DAY, type JobQuestionSetResponse, type QuestionView } from './contract.js';
import { createPrismaJobSetIndex, type JobSetQuestionDelegate } from './jobSetIndex.js';
import { PrepService, type BudgetKind, type PrepJob, type PrepServiceDeps } from './service.js';
import { createPrismaPrepStore } from './store.js';

export * from './contract.js';
export { createInterviewBankRouter } from './routes.js';
export { createPrepAdminRouter } from './adminRoutes.js';
export { PrepService } from './service.js';
export type { BudgetKind, PrepJob, PrepServiceDeps } from './service.js';
export type { PrepStore } from './store.js';
export { assertAttribution, claimsCompanyAsked, screenContribution } from './rules.js';

const LIMITS: Record<BudgetKind, number> = {
  guide: GUIDE_GENERATIONS_PER_DAY,
  jobSet: JOB_SET_GENERATIONS_PER_DAY,
  contribution: CONTRIBUTIONS_PER_DAY,
  report: REPORTS_PER_DAY,
};

/** AI for practice questions: the user's AI consent AND the brand's text model (R-13). */
export async function prepAiAvailable(userId: string): Promise<boolean> {
  if (!(await aiAllowed(userId))) return false;
  return isEnabled('ai.text', { userId });
}

async function loadJobViaDetail(userId: string, jobId: string): Promise<PrepJob> {
  // Job detail checks the market, private imports and the GoApply recruitment-info mode (404 otherwise).
  const { jobDetailService } = await import('../jobs/detail/index.js');
  const { job, company } = await jobDetailService.get(userId, jobId);
  const text = job.sections.map((s) => s.body.trim()).filter(Boolean).join('\n\n');
  return {
    id: job.id,
    title: job.title,
    companyName: job.companyName || company.name,
    companyId: company.id,
    companySlug: company.slug,
    text: text || job.summary?.text || job.title,
  };
}

export async function defaultPrepDeps(): Promise<PrepServiceDeps> {
  const [{ normalizeCompanyName }, { cnPostingsWhere }, { default: prisma }] = await Promise.all([
    import('../jobs/normalize/index.js'),
    import('../cn/jobs/index.js'),
    import('../../lib/prisma.js'),
  ]);
  return {
    store: await createPrismaPrepStore(),
    // SR-59-1: the job → set link lives in the database, not in this process.
    jobSets: createPrismaJobSetIndex({ rAInterviewQuestion: prisma.rAInterviewQuestion as unknown as JobSetQuestionDelegate }),
    market: () => (getCurrentBrandOrDefault().market === 'cn' ? 'cn' : 'intl'),
    now: () => new Date(),
    aiAvailable: prepAiAvailable,
    budget: async (kind, userId) => {
      const result = await consumeRateLimit({ key: rateLimitKey(`prep.${kind}`, 'user', userId), windows: [{ limit: LIMITS[kind], windowSec: DAY }] });
      return { allowed: result.allowed, retryAfterSec: result.retryAfterSec };
    },
    loadJob: loadJobViaDetail,
    postingWhere: (userId) => (getCurrentBrandOrDefault().market === 'cn' ? cnPostingsWhere(userId) : undefined),
    normalizeCompany: (name) => normalizeCompanyName(name),
    generateSet: async (input) => {
      const { PrepQuestionSetAgent } = await import('./agents.js');
      return new PrepQuestionSetAgent().run(input, { requestId: getCurrentRequestId() ?? undefined });
    },
    generateGuide: async (input) => {
      const { PrepGuideAgent } = await import('./agents.js');
      return new PrepGuideAgent().run(input, { requestId: getCurrentRequestId() ?? undefined });
    },
    modelId: () => {
      try {
        return getTaskModel('writing') ?? null;
      } catch {
        return null;
      }
    },
  };
}

let singleton: Promise<PrepService> | null = null;

/** The process-wide question-bank service (Prisma store, platform limits). */
export function getPrepService(): Promise<PrepService> {
  singleton ??= defaultPrepDeps().then((deps) => new PrepService(deps));
  return singleton;
}

export interface PrepSeam {
  /** `locale` defaults to the brand's language ('zh' on GoApply, 'en' otherwise). */
  /** `write: true` only when the user asked for practice questions (it may call a model). */
  planForJob(userId: string, jobId: string, locale?: string, opts?: { write?: boolean }): Promise<{ questions: QuestionView[] } & JobQuestionSetResponse>;
}

export const prepService: PrepSeam = {
  async planForJob(userId, jobId, locale, opts) {
    const lang = locale ?? (getCurrentBrandOrDefault().market === 'cn' ? 'zh' : 'en');
    return (await getPrepService()).planForJob(userId, jobId, lang, opts);
  },
};
