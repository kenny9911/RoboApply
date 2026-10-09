// server/src/features/resume/index.ts — public surface of RES (FND-5; owners WP-22 → WP-36a/36b → WP-65).
//
// Seams:
//   `keywordReport(userId, variantId, jobId)`       job detail (WP-34), tailoring (WP-36a) — WP-22, filled
//   `grantOnboardingResumeCheck(userId)`             onboarding (WP-30): the free first check — WP-22, filled
//   `getResumeCheckService()`                         grade / latest / fixes for other areas (Assistant)
//   `unverifiedClaimsCount(variantId)`                WP-36b export guard, WP-55a — stub until WP-36a
//   `createTailorSession(...)`                        Assistant / Ready to apply — stub until WP-36a

import { NotImplementedError } from '../../platform/http.js';
import { creditService } from '../../platform/credits/index.js';
import { aiAllowed } from '../../platform/consent/aiAllowed.js';
import { isEnabled } from '../../platform/flags.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import type { KeywordReportResponse, TailorSessionView } from './contract.js';
import { ResumeCheckService, type ResumeCheckDeps } from './ResumeCheckService.js';
import { createPrismaResumeCheckStore } from './store.js';

export * from './contract.js';
export { createResumeSuiteRouter } from './routes.js';
export { RESUME_WORK_KINDS } from './workers.js';
export { ResumeCheckService, ONBOARDING_GRANT_REASON, actionFor } from './ResumeCheckService.js';
export type { ResumeCheckDeps } from './ResumeCheckService.js';
export type { ResumeCheckStore } from './store.js';
export { resumeForLlm, isSensitiveLine } from './check/resumeText.js';

/** AI for resume features: the user's AI consent AND the brand's text model (R-13). */
export async function resumeAiAvailable(userId: string): Promise<boolean> {
  if (!(await aiAllowed(userId))) return false;
  return isEnabled('ai.text', { userId });
}

export function defaultResumeCheckDeps(): ResumeCheckDeps {
  return {
    store: createPrismaResumeCheckStore(),
    credits: creditService,
    aiAvailable: resumeAiAvailable,
    profile: () => (getCurrentBrandOrDefault().market === 'cn' ? 'cn' : 'intl'),
    market: () => (getCurrentBrandOrDefault().market === 'cn' ? 'cn' : 'intl'),
    runAiPass: async (input, options) => {
      const { ResumeCheckAgent } = await import('./check/ResumeCheckAgent.js');
      return new ResumeCheckAgent().run(input, { ...options, requestId: getCurrentRequestId() ?? undefined });
    },
    rewrite: async (input, options) => {
      const { RAResumeRewriteAgent } = await import('../../roboapply/v2/agents/RAResumeRewriteAgent.js');
      return new RAResumeRewriteAgent().run(input, { ...options, requestId: getCurrentRequestId() ?? undefined });
    },
    logAiLabel: async ({ userId, contentId, kind }) => {
      const { complianceService } = await import('../compliance/index.js');
      await complianceService.logAiContentLabel({ userId, contentId, kind, provider: 'llm' });
    },
  };
}

let singleton: ResumeCheckService | null = null;

/** The process-wide resume check service (Prisma store, platform credits). */
export function getResumeCheckService(): ResumeCheckService {
  singleton ??= new ResumeCheckService(defaultResumeCheckDeps());
  return singleton;
}

/** Onboarding (WP-30): grant the free first check once per user (reason `onboarding_check`). */
export function grantOnboardingResumeCheck(userId: string): Promise<'granted' | 'already_granted'> {
  return getResumeCheckService().grantOnboardingCheck(userId);
}

export interface ResumeSuiteService {
  unverifiedClaimsCount(variantId: string): Promise<number>;
  createTailorSession(userId: string, input: { baseVariantId: string; jobId: string; idempotencyKey: string }): Promise<TailorSessionView>;
  keywordReport(userId: string, variantId: string, jobId: string): Promise<KeywordReportResponse>;
}

export const resumeSuiteService: ResumeSuiteService = {
  async unverifiedClaimsCount() {
    throw new NotImplementedError('resume.unverifiedClaimsCount');
  },
  async createTailorSession() {
    throw new NotImplementedError('resume.createTailorSession');
  },
  async keywordReport(userId, variantId, jobId) {
    return getResumeCheckService().keywordReport(userId, variantId, { jobId });
  },
};

export const unverifiedClaimsCount = (variantId: string) => resumeSuiteService.unverifiedClaimsCount(variantId);
