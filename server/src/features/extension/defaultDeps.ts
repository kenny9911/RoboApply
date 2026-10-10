// server/src/features/extension/defaultDeps.ts — the production wiring of the
// extension service: every other area is reached through its public
// `index.ts` (TASK_PLAN.md §2.1 rule 4), loaded lazily so this area's router
// stays cheap to import.

import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { aiAllowed, hasLiveConsent } from '../../platform/consent/aiAllowed.js';
import { creditService, summarizeEntitlementsForMe } from '../../platform/credits/index.js';
import { isEnabled, resolveFlagsForUser } from '../../platform/flags.js';
import { NotImplementedError } from '../../platform/http.js';
import { logger } from '../../services/LoggerService.js';
import { cnPostingVisible, cnPostingsWhere } from '../cn/jobs/index.js';
import { draftAnswer } from './answers.js';
import { createPrismaExtensionRepo } from './repository.js';
import type { ExtProfileView, ExtensionDeps, FitChip } from './service.js';

function chip(fit: { score: number | null; tier: string | null; kind: 'pre' | 'ai'; topOverlap: string | null; topGap: string | null } | null | undefined): FitChip | null {
  if (!fit) return null;
  return { score: fit.score, tier: fit.tier, kind: fit.kind, topOverlap: fit.topOverlap, topGap: fit.topGap };
}

/**
 * The legacy resume service (export + RAApplicationArtifact record, WP-36b).
 * Loaded by a computed path: it pulls the résumé parsers, whose untyped
 * packages the web typecheck (which reaches this file through
 * features/index.ts) cannot see. The shape below is the slice used here.
 */
export const RESUME_SERVICE_MODULE = '../../roboapply/v2/services/RAResumeService.js';
interface ResumeServiceModule {
  raResumeService: {
    exportVariant(
      userId: string,
      id: string,
      req: { format: 'pdf' | 'docx'; trackerEntryId?: string | null; channel?: 'download' | 'agent' | 'extension'; locale?: string | null; brand: 'roboapply' | 'goapply'; market: 'intl' | 'cn' },
    ): Promise<{ buffer: Buffer; fileName: string; contentType: string; artifactId: string | null }>;
  };
  registerResumeArtifactDeleters(): Promise<void>;
}

function notImplemented(err: unknown): boolean {
  return err instanceof NotImplementedError || (err as { code?: unknown } | null)?.code === 'not_implemented';
}

export function defaultExtensionDeps(): ExtensionDeps {
  return {
    repo: createPrismaExtensionRepo(),
    now: () => new Date(),
    env: process.env,
    brand: () => getCurrentBrandOrDefault(),
    credits: creditService,
    profile: {
      async get(userId) {
        const { profileService } = await import('../profile/index.js');
        return (await profileService.get(userId)) as unknown as ExtProfileView;
      },
      async snapshotText(userId) {
        const { profileSnapshotForLlm } = await import('../profile/index.js');
        return (await profileSnapshotForLlm(userId)).text ?? '';
      },
      async sensitiveForAutofill(userId) {
        const { sensitiveAnswersForAutofill } = await import('../profile/index.js');
        return ((await sensitiveAnswersForAutofill(userId)) as Record<string, unknown> | null) ?? null;
      },
      sensitiveConsent: (userId) => hasLiveConsent(userId, 'autofill_sensitive'),
    },
    async answerBank(userId) {
      const { agentService } = await import('../agent/index.js');
      try {
        return await agentService.answerBank(userId);
      } catch (err) {
        // Same-wave seam (WP-52): until it is filled the bank is empty, never an error.
        if (notImplemented(err)) return [];
        throw err;
      }
    },
    async markAgentSubmitted(userId, jobId) {
      const { agentService } = await import('../agent/index.js');
      try {
        await agentService.markUserSubmitted(userId, jobId);
      } catch (err) {
        if (!notImplemented(err)) throw err;
      }
    },
    entitlements: (userId) => summarizeEntitlementsForMe(userId, { brand: getCurrentBrandOrDefault().id }),
    flags: async (userId) => (await resolveFlagsForUser(userId, { brand: getCurrentBrandOrDefault() })) as unknown as Record<string, unknown>,
    match: {
      async cached(userId, jobId) {
        const { matchService } = await import('../match/index.js');
        return chip(await matchService.scoreJob(userId, jobId, { mode: 'cache_only' }));
      },
      async page(userId, page) {
        const { matchService } = await import('../match/index.js');
        const brand = getCurrentBrandOrDefault();
        const [fit] = await matchService.preScoreJobs(userId, [
          {
            id: 'ext-page',
            market: brand.market,
            visibility: 'private',
            ownerUserId: userId,
            title: page.title,
            companyName: page.company,
            description: page.descriptionText,
            descriptionPlain: page.descriptionText,
            qualifications: null,
            responsibilities: null,
            benefits: null,
            taxonomyIds: [],
            primaryTaxonomyId: null,
            seniority: null,
            minYears: null,
            maxYears: null,
            educationLevel: null,
            skills: [],
            skillsDetail: null,
            workModel: null,
            remoteScope: null,
            location: page.location,
            locationCity: null,
            locationCountry: null,
            geoLat: null,
            geoLng: null,
            salaryAnnualMin: null,
            salaryAnnualMax: null,
            salaryCurrency: null,
            sponsorship: null,
            sponsorshipEvidence: null,
            marketTags: null,
            archivedAt: null,
            companyIndustries: [],
          },
        ]);
        return chip(fit);
      },
    },
    async saveImportedJob(userId, fields, options) {
      const { jobImportService } = await import('../jobs/import/index.js');
      const out = await jobImportService.saveJob(userId, fields, { source: 'extension', idempotencyKey: options.idempotencyKey });
      return { jobId: out.jobId, matched: out.matched };
    },
    tracker: {
      async saveForJob(userId, jobId) {
        const { trackerCore } = await import('../tracker/index.js');
        return (await trackerCore.upsertForJob(userId, jobId, { status: 'bookmarked', source: 'extension' })).id;
      },
      async markApplied(userId, jobId) {
        const { trackerService } = await import('../tracker/index.js');
        const mark = await trackerService.markApplied(userId, jobId, 'extension');
        return { entryId: mark.entryId, changed: mark.changed };
      },
    },
    async recordInteraction(userId, jobId, kind) {
      const { feedService } = await import('../feed/index.js');
      await feedService.recordInteraction(userId, jobId, kind);
    },
    async aiAvailability(userId) {
      if (!(await aiAllowed(userId))) return 'ai_off';
      if (!(await isEnabled('ai.text', { userId }))) return 'ai_unavailable';
      return 'ok';
    },
    async assertPhoneBound(userId) {
      const { assertPhoneBound } = await import('../auth-cn/index.js');
      await assertPhoneBound(userId);
    },
    draftAnswer: (input) => draftAnswer(input),
    async logAiLabel(userId, runId) {
      const { logAiContentLabel, newAiContentId } = await import('../compliance/index.js');
      const brand = getCurrentBrandOrDefault();
      await logAiContentLabel({ userId, contentId: newAiContentId(brand.id), kind: 'extension_answer', provider: 'llm', artifactId: runId, brand: brand.id });
    },
    async unverifiedClaims(variantId) {
      const { unverifiedClaimsCount } = await import('../resume/index.js');
      try {
        return await unverifiedClaimsCount(variantId);
      } catch (err) {
        if (notImplemented(err)) return 0;
        throw err;
      }
    },
    async exportResume(userId, variantId, { trackerEntryId, brand }) {
      const { raResumeService, registerResumeArtifactDeleters } = (await import(RESUME_SERVICE_MODULE)) as ResumeServiceModule;
      // The stored bytes are purged with the account and by the 180-day retention (WP-10 / WP-13 deleters).
      await registerResumeArtifactDeleters().catch((err: unknown) => logger.warn('EXTENSION', 'artifact deleters not registered', { error: String(err) }));
      const out = await raResumeService.exportVariant(userId, variantId, {
        format: 'pdf',
        trackerEntryId,
        channel: 'extension',
        brand: brand.id,
        market: brand.market,
        locale: null,
      });
      return { buffer: out.buffer, fileName: out.fileName, contentType: out.contentType, artifactId: out.artifactId };
    },
    cnPostingVisible: (job, userId) => cnPostingVisible(job, userId),
    cnWhere: (userId) => cnPostingsWhere(userId),
  };
}

