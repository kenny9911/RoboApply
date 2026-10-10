// server/src/features/coverletter/index.ts — public surface of CL (FND-5; owner WP-37).
//
// Seams:
//   coverLetterService.createLetter(...)   Assistant `write_cover_letter` (WP-50), Ready to apply `prepare` (WP-52)
//   coverLetterService.getForJob(...)      job detail checklist, extension, Ready to apply review
//   coverLetterService.attach(...)         Ready to apply kit / tracker drawer: attach a letter to an application
//   getCoverLetterService()                the full service (list, rewrite, export, …)

import { NotImplementedError } from '../../platform/http.js';
import { creditService } from '../../platform/credits/index.js';
import { aiAllowed } from '../../platform/consent/aiAllowed.js';
import { isEnabled } from '../../platform/flags.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { consumeRateLimit, rateLimitKey, DAY } from '../../platform/ratelimit/index.js';
import { LLM_PII_KINDS, redactPii } from '../../platform/pii/index.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import { getTaskModel } from '../../lib/llm/llmTaskSettings.js';
import { resumeForLlm } from '../resume/index.js';
import { explicitFooterLine, explicitLabelEnabled, implicitLabelMetadata, logAiContentLabel, newAiContentId } from '../compliance/index.js';
import { REWRITES_PER_LETTER_PER_DAY, type CoverLetterView, type LetterLength, type LetterLocale, type LetterTone } from './contract.js';
import { CoverLetterService, type CoverLetterDeps } from './service.js';
import { createPrismaCoverLetterStore } from './store.js';

export * from './contract.js';
export { createCoverLetterRouter } from './routes.js';
export { CoverLetterService } from './service.js';
export type { CoverLetterDeps, CreateLetterInput, PostingSnapshot, RewriteBudget } from './service.js';
export type { CoverLetterStore } from './store.js';

/** AI for cover letters: the user's AI consent AND the brand's text model (R-13). */
export async function coverLetterAiAvailable(userId: string): Promise<boolean> {
  if (!(await aiAllowed(userId))) return false;
  return isEnabled('ai.text', { userId });
}

/**
 * SR-37-1: `RACoverLetter.postingSnapshot Json?` (the pasted job post a letter
 * was written from) is not in the schema yet. Until SCHEMA-3 adds it, a letter
 * written from a pasted post cannot be rewritten or regenerated (409
 * posting_unavailable); letters written from a job id are unaffected.
 */
const prismaPostings: CoverLetterDeps['postings'] = {
  async read() {
    return null;
  },
  async write() {
    /* SR-37-1: nothing to write to until the column exists */
  },
};

export function defaultCoverLetterDeps(): CoverLetterDeps {
  return {
    store: createPrismaCoverLetterStore(),
    credits: creditService,
    aiAvailable: coverLetterAiAvailable,
    brandId: () => getCurrentBrandOrDefault().id,
    market: () => (getCurrentBrandOrDefault().market === 'cn' ? 'cn' : 'intl'),
    profileText: async (userId) => {
      const { profileSnapshotForLlm } = await import('../profile/index.js');
      return (await profileSnapshotForLlm(userId)).text;
    },
    // resumeForLlm drops the name/contact header and sensitive lines; redactPii removes what is left.
    resumeForPrompt: (markdown, name) => redactPii(resumeForLlm(markdown), { kinds: LLM_PII_KINDS, knownValues: [name] }).text,
    redact: (text, name) => redactPii(text, { kinds: LLM_PII_KINDS, knownValues: [name] }).text,
    unverifiedClaims: async (variantId) => {
      try {
        const { unverifiedClaimsCount } = await import('../resume/index.js');
        return await unverifiedClaimsCount(variantId);
      } catch (err) {
        if (err instanceof NotImplementedError) return 0; // WP-36a not merged yet: no claims are tracked
        throw err;
      }
    },
    write: async (input, options) => {
      const { CoverLetterWriterAgent } = await import('./CoverLetterAgent.js');
      return new CoverLetterWriterAgent().run(input, { ...options, requestId: getCurrentRequestId() ?? undefined });
    },
    factCheck: async (input, options) => {
      const { CoverLetterFactCheckAgent } = await import('./CoverLetterAgent.js');
      return new CoverLetterFactCheckAgent().run(input, { ...options, requestId: getCurrentRequestId() ?? undefined });
    },
    rewriteBudget: async (letterId, cost) => {
      const result = await consumeRateLimit({
        key: rateLimitKey('coverLetterRewrite', 'id', letterId),
        windows: [{ limit: REWRITES_PER_LETTER_PER_DAY, windowSec: DAY }],
        cost,
      });
      const remaining = Number.isFinite(result.remaining) ? result.remaining : REWRITES_PER_LETTER_PER_DAY;
      // A read-only check (cost 0) at the limit is still "allowed": give it the window's reset time too.
      const resetAt = result.windows[0]?.resetAt;
      const untilReset = resetAt ? Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)) : 0;
      return { allowed: result.allowed, remaining, retryAfterSec: result.retryAfterSec || (remaining <= 0 ? untilReset : 0) };
    },
    modelId: () => {
      try {
        return getTaskModel('writing') ?? null;
      } catch {
        return null;
      }
    },
    label: {
      implicit: (input) => implicitLabelMetadata({ contentId: input.contentId, provider: input.provider, userEdited: input.userEdited, brand: input.brand }),
      newContentId: (brand) => newAiContentId(brand),
      footerLine: (locale) => explicitFooterLine(locale),
      footerEnabled: (brand) => explicitLabelEnabled(brand),
      log: async (input) => {
        await logAiContentLabel({
          userId: input.userId,
          contentId: input.contentId,
          kind: input.kind,
          provider: input.provider,
          artifactId: input.artifactId,
          brand: input.brand,
        });
      },
    },
    postings: prismaPostings,
  };
}

let singleton: CoverLetterService | null = null;

/** The process-wide cover-letter service (Prisma store, platform credits). */
export async function getCoverLetterService(): Promise<CoverLetterService> {
  singleton ??= new CoverLetterService(defaultCoverLetterDeps());
  return singleton;
}

export interface CoverLetterSeam {
  createLetter(
    userId: string,
    input: { jobId: string; resumeVariantId: string; tone?: LetterTone; length?: LetterLength; locale?: LetterLocale; trackerEntryId?: string },
    idempotencyKey: string,
  ): Promise<CoverLetterView>;
  getForJob(userId: string, jobId: string): Promise<CoverLetterView | null>;
  attach(userId: string, letterId: string, trackerEntryId: string | null): Promise<CoverLetterView>;
}

export const coverLetterService: CoverLetterSeam = {
  async createLetter(userId, input, idempotencyKey) {
    return (await getCoverLetterService()).create(userId, input, { idempotencyKey });
  },
  async getForJob(userId, jobId) {
    return (await getCoverLetterService()).getForJob(userId, jobId);
  },
  async attach(userId, letterId, trackerEntryId) {
    return (await getCoverLetterService()).attach(userId, letterId, trackerEntryId);
  },
};
