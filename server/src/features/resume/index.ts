// server/src/features/resume/index.ts — public surface of RES (FND-5; owners WP-22 → WP-36a/36b → WP-65).
//
// Seams:
//   `keywordReport(userId, variantId, jobId)`       job detail (WP-34), tailoring (WP-36a) — WP-22, filled
//   `grantOnboardingResumeCheck(userId)`             onboarding (WP-30): the free first check — WP-22, filled
//   `getResumeCheckService()`                         grade / latest / fixes for other areas (Assistant)
//   `unverifiedClaimsCount(variantId)`                WP-36b export guard, WP-55a — WP-36a, filled
//   `createTailorSession(...)`                        Assistant / Ready to apply — WP-36a, filled
//   `getTailorService()`                              the tailor session service (routes, other areas)
//   `getBuilderService()`                             guided builder (WP-65)
//   `getLayoutService()`                              layout save + fit to one page (WP-65; also the legacy PATCH /:id/layout)

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
import { BuilderService, type BuilderServiceDeps } from './builder/BuilderService.js';
import { LayoutService, type LayoutServiceDeps } from './layout/LayoutService.js';
import { createPrismaLayoutStore } from './layout/store.js';
import { HttpError } from '../../platform/http.js';

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
// WP-65: guided builder, layout, fit to page.
export { BuilderService } from './builder/BuilderService.js';
export type { BuilderServiceDeps } from './builder/BuilderService.js';
export { builderConfigFor, builderVariantFor, SECTION_HEADINGS, FIELD_LABELS } from './builder/sections.js';
export { composeBuilderResume } from './builder/compose.js';
export { builderPromptInput, draftContextLines, formatBuilderPrompt, isPromptSensitive, sanitizePromptText } from './builder/prompt.js';
export { LayoutService } from './layout/LayoutService.js';
export type { LayoutServiceDeps } from './layout/LayoutService.js';
export { LAYOUT_KEYS, mergeLayout } from './layout/merge.js';
export { fitToPage, compressAt, FIT_FLOORS } from './layout/fitToPage.js';
export type { LayoutStore } from './layout/store.js';

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

// ── WP-65: layout + guided builder ───────────────────────────────────────

export function defaultLayoutDeps(): LayoutServiceDeps {
  return {
    store: createPrismaLayoutStore(),
    countPages: async (markdown, options) => {
      const { countResumePages } = await import('../../roboapply/v2/lib/resumeExport.js');
      return countResumePages(markdown, options);
    },
    market: brandMarket,
  };
}

let layoutSingleton: LayoutService | null = null;

/** The process-wide layout service (Prisma store, the PDF renderer's page count). */
export function getLayoutService(): LayoutService {
  layoutSingleton ??= new LayoutService(defaultLayoutDeps());
  return layoutSingleton;
}

export function defaultBuilderDeps(): BuilderServiceDeps {
  const resumeService = async () => (await import('./legacyResumeService.js')).loadLegacyResumeModule();
  return {
    credits: creditService,
    aiAvailable: resumeAiAvailable,
    market: brandMarket,
    suggest: async (input) => {
      const { BuilderSuggestAgent } = await import('./builder/BuilderSuggestAgent.js');
      return new BuilderSuggestAgent().run(input, { requestId: getCurrentRequestId() ?? undefined });
    },
    logAiLabel: async ({ userId, contentId, kind }) => {
      const { complianceService } = await import('../compliance/index.js');
      await complianceService.logAiContentLabel({ userId, contentId, kind, provider: 'llm' });
    },
    createResume: async (userId, input, locale) => {
      const { raResumeService, ResumeLimitError, BASE_RESUME_LIMIT } = await resumeService();
      try {
        const view = await raResumeService.create(userId, { kind: 'base', name: input.name, resumeMarkdown: input.markdown }, locale);
        return { id: view.id };
      } catch (err) {
        if (err instanceof ResumeLimitError) {
          throw new HttpError('conflict', 'Every resume slot is in use. Delete one to add another.', { reason: 'resume_limit_reached', limit: BASE_RESUME_LIMIT });
        }
        throw err;
      }
    },
    saveLayout: async (userId, id, layout) => {
      await getLayoutService().patch(userId, id, layout);
    },
    patchMeta: async (userId, id, meta) => {
      const { raResumeService } = await resumeService();
      await raResumeService.patch(userId, id, meta);
    },
    deleteResume: async (userId, id) => {
      const { raResumeService } = await resumeService();
      await raResumeService.delete(userId, id);
    },
    builderAiUsedSince: async (userId, since) => {
      // Read only: the rows BuilderService.suggest logs on GoApply (kind → artifactType).
      const { default: prisma } = await import('../../lib/prisma.js');
      const n = await prisma.rAAiContentLabelLog.count({ where: { userId, artifactType: 'resume_builder', createdAt: { gte: since } } });
      return n > 0;
    },
  };
}

let builderSingleton: BuilderService | null = null;

/** The process-wide guided builder service. */
export function getBuilderService(): BuilderService {
  builderSingleton ??= new BuilderService(defaultBuilderDeps());
  return builderSingleton;
}
