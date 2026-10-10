// server/src/features/resume/index.ts — public surface of RES (FND-5; owners WP-22 → WP-36a/36b → WP-65).
//
// Seams:
//   `keywordReport(userId, variantId, jobId)`       job detail (WP-34), tailoring (WP-36a) — WP-22, filled
//   `grantOnboardingResumeCheck(userId)`             onboarding (WP-30): the free first check — WP-22, filled
//   `getResumeCheckService()`                         grade / latest / fixes for other areas (Assistant)
//   `unverifiedClaimsCount(variantId)`                WP-36b export guard, WP-55a — WP-36a, filled
//   `createTailorSession(...)`                        Assistant / Ready to apply — WP-36a, filled
//   `getTailorService()`                              the tailor session service (routes, other areas)

import { creditService } from '../../platform/credits/index.js';
import { aiAllowed } from '../../platform/consent/aiAllowed.js';
import { isEnabled } from '../../platform/flags.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import { TAILOR_SECTIONS, type KeywordReportResponse, type TailorSection, type TailorSessionView } from './contract.js';
import { ResumeCheckService, type ResumeCheckDeps } from './ResumeCheckService.js';
import { createPrismaResumeCheckStore } from './store.js';
import { TailorService, type TailorServiceDeps } from './tailor/TailorService.js';
import { createPrismaTailorStore } from './tailor/store.js';

export * from './contract.js';
export { createResumeSuiteRouter } from './routes.js';
export { RESUME_WORK_KINDS } from './workers.js';
export { ResumeCheckService, ONBOARDING_GRANT_REASON, actionFor } from './ResumeCheckService.js';
export type { ResumeCheckDeps } from './ResumeCheckService.js';
export type { ResumeCheckStore } from './store.js';
export { resumeForLlm, isSensitiveLine } from './check/resumeText.js';
export { TailorService, UnverifiedClaimsError, GENERATING_STALE_MS } from './tailor/TailorService.js';
export type { TailorServiceDeps, FitScoreResult, CreateTailorBody } from './tailor/TailorService.js';
export type { TailorStore } from './tailor/store.js';
export { extractClaims, applyClaimDecision, pendingCount } from './tailor/claims.js';
export { mergeTailored, diffChanges } from './tailor/blocks.js';

/** AI for resume features: the user's AI consent AND the brand's text model (R-13). */
export async function resumeAiAvailable(userId: string): Promise<boolean> {
  if (!(await aiAllowed(userId))) return false;
  return isEnabled('ai.text', { userId });
}

/** Brand market of the current request (GoApply → 'cn'). */
const brandMarket = (): 'intl' | 'cn' => (getCurrentBrandOrDefault().market === 'cn' ? 'cn' : 'intl');

export function defaultResumeCheckDeps(): ResumeCheckDeps {
  return {
    store: createPrismaResumeCheckStore(),
    credits: creditService,
    aiAvailable: resumeAiAvailable,
    profile: brandMarket,
    market: brandMarket,
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

export function defaultTailorDeps(): TailorServiceDeps {
  return {
    store: createPrismaTailorStore(),
    credits: creditService,
    aiAvailable: resumeAiAvailable,
    assertPhoneBound: async (userId) => {
      const { assertPhoneBound } = await import('../auth-cn/index.js');
      await assertPhoneBound(userId);
    },
    market: brandMarket,
    tailor: async (input, options) => {
      const { RAResumeTailorAgent } = await import('../../roboapply/v2/agents/RAResumeTailorAgent.js');
      return new RAResumeTailorAgent().run(input, { ...options, requestId: getCurrentRequestId() ?? undefined });
    },
    profileContext: async (userId) => {
      const { profileSnapshotForLlm } = await import('../profile/index.js');
      const snap = await profileSnapshotForLlm(userId);
      return snap.text?.trim() ? snap.text : null;
    },
    score: async (userId, jobId, variantId, locale) => {
      const { matchService } = await import('../match/index.js');
      const fit = await matchService.scoreJob(userId, jobId, { resumeVariantId: variantId, mode: 'on_demand', locale });
      return { score: fit.score, kind: fit.kind, scoredAt: fit.scoredAt };
    },
    markChecklist: async (userId) => {
      const { markChecklistStep } = await import('../growth/index.js');
      await markChecklistStep(userId, 'tailor');
    },
    logAiLabel: async ({ userId, contentId, kind }) => {
      const { complianceService } = await import('../compliance/index.js');
      await complianceService.logAiContentLabel({ userId, contentId, kind, provider: 'llm' });
    },
  };
}

let tailorSingleton: TailorService | null = null;

/** The process-wide tailor session service (Prisma store, platform credits). */
export function getTailorService(): TailorService {
  tailorSingleton ??= new TailorService(defaultTailorDeps());
  return tailorSingleton;
}

export interface ResumeSuiteService {
  /** Pending "Verify details" claims on a resume version; > 0 blocks export (ruling C12). */
  unverifiedClaimsCount(variantId: string): Promise<number>;
  /**
   * Start a tailor for (resume, job): spends one `tailor` credit (Idempotency-Key).
   * Gated like the route: 503 `ai_unavailable` when AI is off; GoApply WeChat
   * accounts without a phone get auth-cn `AuthCnError('phone_binding_required')` (403).
   */
  createTailorSession(
    userId: string,
    input: { baseVariantId: string; jobId: string; idempotencyKey: string; sections?: TailorSection[]; mode?: 'fast' | 'guided'; locale?: string },
  ): Promise<TailorSessionView>;
  keywordReport(userId: string, variantId: string, jobId: string): Promise<KeywordReportResponse>;
}

export const resumeSuiteService: ResumeSuiteService = {
  async unverifiedClaimsCount(variantId) {
    return getTailorService().unverifiedClaimsCount(variantId);
  },
  async createTailorSession(userId, input) {
    return getTailorService().create(
      userId,
      {
        baseVariantId: input.baseVariantId,
        jobId: input.jobId,
        mode: input.mode ?? 'fast',
        sections: input.sections ?? [...TAILOR_SECTIONS],
        keywords: [],
        experienceDepth: 'quick',
      },
      { idempotencyKey: input.idempotencyKey, locale: input.locale },
    );
  },
  async keywordReport(userId, variantId, jobId) {
    return getResumeCheckService().keywordReport(userId, variantId, { jobId });
  },
};

export const unverifiedClaimsCount = (variantId: string) => resumeSuiteService.unverifiedClaimsCount(variantId);
