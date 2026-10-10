// server/src/features/onboarding/defaults.ts — production wiring of the onboarding service (WP-30).
//
// Every cross-area call goes through the other area's index.ts (TASK_PLAN.md
// §2.1 rule 4). Heavy modules (LLM agent, ingest) load lazily so importing
// the router stays cheap.

import { DAY, consumeRateLimit, rateLimitKey } from '../../platform/ratelimit/index.js';
import { aiAllowed } from '../../platform/consent/index.js';
import { enqueue } from '../../platform/queue/index.js';
import { LLM_PII_KINDS, redactPii } from '../../platform/pii/index.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { logger } from '../../services/LoggerService.js';
import { seedDraftFromParsedResume } from '../../roboapply/v2/lib/raResumeSeed.js';
import { searchTaxonomy, taxonomyAncestors, taxonomyChildren, taxonomyLabel } from '../jobs/taxonomy/index.js';
import { searchProfileService } from '../search/index.js';
import { createProfileService, type ProfileServiceImpl } from '../profile/index.js';
import { cnFirstValueContext, onboardingCnService, validateCnStep } from '../onboarding-cn/index.js';
import { ONBOARDING_RESUME_UPLOADS_PER_DAY, type TitleSuggestionView } from './contract.js';
import { createPrismaOnboardingRepo, type OnboardingRepo, type ResumeVariantRow } from './repo.js';
import { createSnapshotLoader, type SnapshotDb } from './snapshot.js';
import { createOnboardingService, type OnboardingDeps, type OnboardingServiceImpl } from './service.js';
import type { MatchPipelineDeps } from './match.js';
import { foldToSimplified } from './zhFold.js';

/** O5 AI role suggestion: only waits this long (the deterministic seed already answered). */
export const AI_SEED_TIMEOUT_MS = 8_000;

/** How many titles the typeahead offers. */
const TITLE_SUGGEST_LIMIT = 10;

/**
 * O2 typeahead. Labels come from the taxonomy in the asked locale (it has
 * English and Simplified Chinese; other locales get English there, and the
 * web localizes categories and role groups from its own bundle through
 * `contextIds` / the node id). The taxonomy's Chinese phrases are Simplified,
 * so a query in Traditional characters is also searched in its Simplified
 * reading (zhFold.ts): "後端" finds the backend roles.
 */
export function suggestTitles(q: string, locale: string): TitleSuggestionView[] {
  const direct = searchTaxonomy(q, { locale, limit: TITLE_SUGGEST_LIMIT });
  const folded = foldToSimplified(q);
  const hits = folded === q ? direct : mergeSuggestions(direct, searchTaxonomy(folded, { locale, limit: TITLE_SUGGEST_LIMIT }));
  return hits.slice(0, TITLE_SUGGEST_LIMIT).map((s) => ({
    taxonomyId: s.id,
    label: s.label,
    level: s.level,
    tooGeneral: s.level === 1,
    context: s.context,
    // Nearest first (role group, then category), like `context`.
    contextIds: taxonomyAncestors(s.id)
      .slice(1)
      .map((a) => a.id),
    children:
      s.level === 1
        ? taxonomyChildren(s.id)
            .slice(0, 8)
            .map((c) => ({ taxonomyId: c.id, label: taxonomyLabel(c.id, locale) ?? c.en, level: c.level }))
        : [],
  }));
}

/** The typed query's matches first, then what only its Simplified reading found. */
function mergeSuggestions<T extends { id: string }>(first: T[], second: T[]): T[] {
  const seen = new Set(first.map((s) => s.id));
  return [...first, ...second.filter((s) => !seen.has(s.id))];
}

export function seedResume(row: ResumeVariantRow): { roles: string[]; seniority: string | null; years: number | null } {
  const seed = seedDraftFromParsedResume(row.parsedData, row.resumeMarkdown);
  return {
    roles: seed.draft.targetRoles ?? [],
    seniority: seed.draft.seniority ?? null,
    years: typeof seed.evidence.years === 'number' ? seed.evidence.years : null,
  };
}

async function aiSeedRoles(row: ResumeVariantRow, locale: string): Promise<string[] | null> {
  const [{ raOnboardingResumeSeedAgent }, { resumeForLlm }] = await Promise.all([
    import('../../roboapply/v2/agents/RAOnboardingResumeSeedAgent.js'),
    import('../resume/index.js'),
  ]);
  // Contact block dropped and PII redacted before anything reaches a model.
  const text = redactPii(resumeForLlm(row.resumeMarkdown ?? ''), { kinds: LLM_PII_KINDS }).text;
  if (!text.trim()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_SEED_TIMEOUT_MS);
  try {
    const out = await raOnboardingResumeSeedAgent.run({ parsedJson: '', resumeMarkdown: text, deterministicRoles: [] }, { locale, signal: controller.signal });
    const roles = out.updates.targetRoles;
    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string' && r.trim().length > 0) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let profileImpl: ProfileServiceImpl | null = null;
const profiles = () => (profileImpl ??= createProfileService());

const profileEffects: OnboardingDeps['profile'] = {
  async setLinkedin(userId: string, url: string, brand: ProductBrand) {
    const view = await profiles().get(userId, { brand });
    await profiles().patch(userId, { links: { ...view.links, linkedin: url } }, { brand });
  },
  async setSponsorship(userId, needs, brand) {
    const { sponsorshipToWorkAuth } = await import('./mapping.js');
    const view = await profiles().get(userId, { brand });
    const rows = sponsorshipToWorkAuth(needs, view.workAuth);
    if (rows) await profiles().patch(userId, { workAuth: rows as typeof view.workAuth }, { brand });
  },
  prefillFromResume: (userId, resumeVariantId, brand) => profiles().prefillFromResume(userId, resumeVariantId, { brand }),
};

/** The user's default saved search (id and version); reads, never writes. */
async function defaultSearchProfile(userId: string): Promise<{ id: string; version: number }> {
  const list = await searchProfileService.list(userId);
  const row = list.profiles.find((p) => p.isDefault) ?? list.profiles[0];
  return { id: row.id, version: row.version };
}

export function createDefaultOnboardingDeps(repo: OnboardingRepo = createPrismaOnboardingRepo()): OnboardingDeps {
  return {
    repo,
    searchProfiles: {
      getDefault: defaultSearchProfile,
      async update(userId, id, input) {
        const row = await searchProfileService.update(userId, id, input);
        return { id: row.id, version: row.version };
      },
    },
    profile: profileEffects,
    validateCnStep,
    applyCnStep: (userId, brand, result, opts) => onboardingCnService.applyCnStep(userId, brand, result, opts),
    snapshot: createSnapshotLoader(async () => (await import('../../lib/prisma.js')).default as unknown as SnapshotDb),
    cnSnapshot: (q) => onboardingCnService.marketSnapshotForOnboarding(q),
    cnFirstValueContext: (answers, caps) => cnFirstValueContext(answers, caps),
    async onSetupDone(userId) {
      // Invite programme: grant what is due now instead of waiting for the worker's next poll (growth never throws here).
      const { checkReferralFor } = await import('../growth/index.js');
      await checkReferralFor(userId);
    },
    titleSuggest: suggestTitles,
    seedResume,
    aiSeedRoles,
    aiAllowed: (userId) => aiAllowed(userId),
    async consumeResumeQuota(userId) {
      const res = await consumeRateLimit({
        key: rateLimitKey('onboardingResume', 'user', userId),
        windows: [{ limit: ONBOARDING_RESUME_UPLOADS_PER_DAY, windowSec: DAY }],
      });
      return { allowed: res.allowed, retryAfterSec: res.retryAfterSec };
    },
    async grantFreeResumeCheck(userId) {
      const { grantOnboardingResumeCheck } = await import('../resume/index.js');
      return grantOnboardingResumeCheck(userId);
    },
    async queueResumeCheck(userId, variantId, targetTitle) {
      const { RESUME_WORK_KINDS } = await import('../resume/index.js');
      // Per-user dedupe: the one free check is queued at most once, whichever resume was picked first.
      await enqueue(
        RESUME_WORK_KINDS.resumeGrade,
        { variantId, ...(targetTitle ? { targetTitle } : {}), idempotencyKey: `onboarding:${userId}` },
        { userId, dedupeKey: `resume.grade:onboarding:${userId}` },
      );
    },
    warn: (message, meta) => logger.warn('ONBOARDING', message, meta),
  };
}

let defaultService: OnboardingServiceImpl | null = null;
export function defaultOnboardingService(): OnboardingServiceImpl {
  return (defaultService ??= createOnboardingService(createDefaultOnboardingDeps()));
}

/** O6 pipeline wiring for a brand (request or queue item). */
export function createDefaultMatchDeps(
  brand: ProductBrand,
  service: OnboardingServiceImpl = defaultOnboardingService(),
  repo: OnboardingRepo = createPrismaOnboardingRepo(),
): MatchPipelineDeps {
  return {
    repo,
    brand: { id: brand.id, market: brand.market },
    applyAnswers: (userId) => service.applyAnswers(userId, { brand }),
    // Read only: a queued run uses the search as the user has it now and never writes it.
    currentProfile: (userId) => defaultSearchProfile(userId),
    // The saved search's own size: the feed's count for the default search's filters (what /jobs lists for it).
    async searchCount(userId) {
      const list = await searchProfileService.list(userId);
      const row = list.profiles.find((p) => p.isDefault) ?? list.profiles[0];
      if (!row) return { count: null, capped: false };
      const { countForFilters } = await import('../feed/index.js');
      return countForFilters(userId, row.filters);
    },
    async ingest(searchProfileId, budgetMs) {
      const { ingestForProfile } = await import('../jobs/ingest/index.js');
      return ingestForProfile(searchProfileId, budgetMs);
    },
    async preScore(userId, jobIds) {
      const { matchService } = await import('../match/index.js');
      return matchService.preScoreMany(userId, jobIds);
    },
    aiAllowed: (userId) => aiAllowed(userId),
    // GoApply with the job feed off (R-14) searches nothing and counts nothing.
    async searchAllowed() {
      const { ingestAllowed } = await import('../jobs/ingest/index.js');
      return ingestAllowed(brand);
    },
    async personalized(userId) {
      // The feed's rule is the only one (PIPL Art. 24): RoboApply always; GoApply with the 个性化推荐 consent.
      const { isFeedPersonalized } = await import('../feed/index.js');
      return isFeedPersonalized(userId, brand.market);
    },
    enqueue: (kind, payload, options) => enqueue(kind, payload, { ...options, brand: brand.id }),
    log: (msg, meta) => logger.info('ONBOARDING_MATCH', msg, meta),
  };
}
