// backend/src/roboapply/v2/services/RACrossBankSearchService.ts
//
// Orchestrator for the cross-bank job-search agent team. Owns ONE never-throwing
// discovery round: sequence the team, enforce budgets/concurrency, dedup across
// banks, materialize matched recruiter jobs into RAJob, cache-first Sonnet
// scoring, acceptance-odds, insight, rank/bucket, persist, return the DTO.
//
// Reads candidate context + writes ALL rows via the active-brand `prisma`
// singleton; reads recruiter Job/Company via the two read-only bank clients.
// See docs/CROSSBANK_JOBSEARCH_SPEC.md §3.1 / §4.

import { prisma } from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';
import { writeDeductionLog } from '../../../lib/matchBilling.js';
import { costPatchFromTally } from '../../../lib/deductionCost.js';
import { raJobMatchScorerAgent, pickJobMatchScorerModel } from '../agents/RAJobMatchScorerAgent.js';
import { raCrossBankExplorerAgent } from '../agents/RACrossBankExplorerAgent.js';
import { raCrossBankInsightAgent } from '../agents/RACrossBankInsightAgent.js';
import { evaluateCachedScore } from './RAOnboardingRecommendService.js';
import { listEnabledBanks } from '../lib/raBankClients.js';
import { searchBank } from '../lib/raBankProviders.js';
import { RA_DEFAULT_LOCALE } from '../lib/raLocale.js';
import {
  deriveCandidateSignals,
  preMatchCandidates,
  mapRecruiterJobToRAJobUpsert,
  mapWithConcurrency,
  computeAcceptanceOdds,
  computeRaiseOddsLevers,
  buildCoverageStats,
  normalizeTokens,
  freshnessCutoff,
  normalizeSalaryPeriod,
  bankDisplayName,
  synthesizeApplyUrl,
  DEFAULT_SCORER_BUDGET,
  SCORER_CONCURRENCY,
  SCORE_FLOOR,
  RECOMMENDED_LIMIT,
  EXPLORE_CAP,
  FRESHNESS_DAYS,
} from '../lib/raCrossBankMatch.js';
import type {
  BankId,
  CrossBankDiscoverInput,
  CrossBankDiscoverResult,
  DiscoverJobCard,
  PreMatchedCandidate,
  CrossBankInsightShortlistItem,
} from '../types/crossBank.js';

const TAG = 'RA_V2_CROSSBANK';
const SCORER_PROMPT_VERSION = 'crossbank_v1';

interface ScoredRow {
  cand: PreMatchedCandidate;
  raJobId: string;
  llmScore: number | null; // null = unscored (budget-exhausted / failed)
  summary: string;
  strengths: string[];
  gaps: string[];
  acceptanceOdds: number;
  acceptanceBand: DiscoverJobCard['acceptanceBand'];
  aboveBar: boolean;
  raiseOddsLevers: string[];
}

function zeroResult(banksSwept: BankId[], banksDegraded: BankId[]): CrossBankDiscoverResult {
  return {
    recommended: [],
    explore: [],
    coverage: {
      banksSwept,
      banksDegraded,
      totalRetrieved: 0,
      materialized: 0,
      recommendedCount: 0,
      exploreCount: 0,
      droppedTwins: 0,
      metSolidTarget: false,
      perBank: {},
    },
    insight: null,
    banksSwept,
    banksDegraded,
    scorerCallsUsed: 0,
    scorerCacheHits: 0,
    zeroResults: true,
  };
}

export class RACrossBankSearchService {
  async run(input: CrossBankDiscoverInput): Promise<CrossBankDiscoverResult> {
    const started = Date.now();
    const locale = input.locale ?? RA_DEFAULT_LOCALE;
    const limit = input.limit ?? RECOMMENDED_LIMIT;
    const aggressiveness = input.aggressiveness ?? 'balanced';
    const scorerBudget = Number.parseInt(process.env.RA_CROSSBANK_SCORER_BUDGET ?? '', 10) || DEFAULT_SCORER_BUDGET;
    const p = prisma as any;

    let banksSwept: BankId[] = [];
    const banksDegraded: BankId[] = [];
    let scorerCallsUsed = 0;
    let scorerCacheHits = 0;

    try {
      // STEP 0 — gate + lazy archival sweep of expired crossbank mirrors.
      if (process.env.RA_CROSSBANK_DISABLED?.trim().toLowerCase() === 'true') {
        return zeroResult([], []);
      }
      const banks = listEnabledBanks();
      if (banks.length === 0) return zeroResult([], []);
      banksSwept = banks;
      await this.archiveStaleMirrors(p).catch(() => undefined);

      // STEP 1 — candidate context.
      const variant = await p.rAResumeVariant.findFirst({
        where: {
          userId: input.userId,
          deletedAt: null,
          ...(input.resumeVariantId ? { id: input.resumeVariantId } : { isPrimary: true }),
        },
        select: { id: true, resumeMarkdown: true, resumeContentHash: true, parsedData: true, summary: true },
      });
      if (!variant?.resumeMarkdown) return zeroResult(banksSwept, banksDegraded);

      const signals = deriveCandidateSignals(variant);
      const resumeTokens = new Set(normalizeTokens(variant.resumeMarkdown));
      const candidateHeadline = variant.summary?.slice(0, 400) || signals.currentTitles[0] || 'job seeker';

      // STEP 3 — explorer (Haiku). Draft prefs are best-effort (empty is fine).
      const draft = await this.loadDraft(p, input.userId);
      const marketCountry = (draft.locations?.countries?.[0] ?? localeCountry(locale)).toLowerCase();
      const plan = await raCrossBankExplorerAgent.run(
        {
          candidateHeadline,
          currentTitles: signals.currentTitles,
          topSkills: signals.topSkills,
          seniority: signals.seniority,
          yearsExperience: signals.years,
          draft,
          marketCountry,
          banks,
        },
        { requestId: input.requestId, signal: input.signal },
      );

      // STEP 4 — retrieval sweep, both banks in parallel, each degrades.
      const cutoff = freshnessCutoff();
      const intent = {
        titles: [...plan.primaryTitles, ...plan.adjacentTitles, ...plan.stretchTitles],
        mustKeywords: plan.mustKeywords,
        tags: plan.transferableSkillTags,
        freshnessCutoff: cutoff,
        take: 60,
      };
      const pools = await Promise.all(
        banks.map((b) =>
          searchBank(b, intent, { requestId: input.requestId, signal: input.signal }).then(
            (rows) => ({ b, rows }),
            () => ({ b, rows: null as null }),
          ),
        ),
      );
      const perBankRetrieved: Record<string, number> = {};
      const rows = pools.flatMap((pool) => {
        if (pool.rows == null) {
          banksDegraded.push(pool.b);
          perBankRetrieved[pool.b] = 0;
          return [];
        }
        perBankRetrieved[pool.b] = pool.rows.length;
        return pool.rows;
      });
      if (rows.length === 0) return zeroResult(banksSwept, banksDegraded);

      // STEP 5 — pre-match (deterministic).
      const preMatch = preMatchCandidates({
        rows,
        plan,
        signals,
        draft,
        resumeTokens,
        scorerBudget,
        aggressiveness,
      });
      if (preMatch.coverageSet.length === 0) return zeroResult(banksSwept, banksDegraded);

      // STEP 6 — materialize coverageSet into RAJob (the P0 inventory fix).
      const raJobIdByKey = new Map<string, string>();
      await mapWithConcurrency(preMatch.coverageSet, 8, async (cand) => {
        try {
          const args = mapRecruiterJobToRAJobUpsert(cand);
          const row = await p.rAJob.upsert(args);
          raJobIdByKey.set(`${cand.bank}:${cand.job.id}`, row.id);
        } catch (err) {
          logger.error(TAG, 'materialize upsert failed', {
            bank: cand.bank,
            jobId: cand.job.id,
            error: err instanceof Error ? err.message : String(err),
          }, input.requestId);
        }
      });

      // STEP 7 — scoring (cache-first, waves ≤8, budget-bounded).
      const toScore = preMatch.toScore.filter((c) => raJobIdByKey.has(`${c.bank}:${c.job.id}`));
      const cacheRows: Record<string, { score: number; explanation: unknown } | null> = {};
      const raJobIds = toScore.map((c) => raJobIdByKey.get(`${c.bank}:${c.job.id}`)!);
      if (raJobIds.length > 0) {
        const cached = await p.rAJobMatchScore.findMany({
          where: { userId: input.userId, resumeVariantId: variant.id, jobId: { in: raJobIds } },
          select: { jobId: true, score: true, explanation: true, resumeContentHashAtScore: true },
        });
        for (const row of cached) {
          const decision = evaluateCachedScore(row, variant.resumeContentHash, locale);
          if (decision.fresh) cacheRows[row.jobId] = { score: row.score, explanation: row.explanation };
        }
      }

      const scoredMap = new Map<string, ScoredRow>();
      await mapWithConcurrency(toScore, SCORER_CONCURRENCY, async (cand) => {
        const raJobId = raJobIdByKey.get(`${cand.bank}:${cand.job.id}`)!;
        const cachedHit = cacheRows[raJobId];
        if (cachedHit) {
          scorerCacheHits++;
          const exp = (cachedHit.explanation ?? {}) as Record<string, unknown>;
          scoredMap.set(raJobId, this.buildScoredRow(cand, raJobId, cachedHit.score, {
            summary: typeof exp.rationale === 'string' ? exp.rationale : '',
            strengths: Array.isArray(exp.strengths) ? (exp.strengths as string[]) : [],
            gaps: Array.isArray(exp.gaps) ? (exp.gaps as string[]) : [],
          }));
          return;
        }
        try {
          const res = await raJobMatchScorerAgent.run(
            {
              resumeMarkdown: variant.resumeMarkdown,
              jobTitle: cand.job.title,
              jobDescription: cand.job.description ?? '',
              jobQualifications: [cand.job.qualifications, cand.job.hardRequirements].filter(Boolean).join('\n\n'),
              jobBenefits: cand.job.benefits ?? undefined,
            },
            { requestId: input.requestId, locale, signal: input.signal },
          );
          scorerCallsUsed++;
          await this.persistScore(p, input, variant, raJobId, cand, res, locale);
          await this.bill('ra_crossbank_score', input, raJobId, cand.bank);
          scoredMap.set(raJobId, this.buildScoredRow(cand, raJobId, res.score, res));
        } catch (err) {
          // Malformed / failed pair — skip, debit zero (parseOutput threw).
          logger.warn(TAG, 'score pair skipped', {
            bank: cand.bank,
            jobId: cand.job.id,
            error: err instanceof Error ? err.message : String(err),
          }, input.requestId);
        }
      });

      // STEP 10 — rank + bucket. Recommended = scored & llm≥SCORE_FLOOR by
      // acceptanceOdds desc; Explore = everything else by preScore desc.
      const scoredCands = preMatch.coverageSet
        .map((c) => scoredMap.get(raJobIdByKey.get(`${c.bank}:${c.job.id}`) ?? ''))
        .filter((x): x is ScoredRow => !!x && x.llmScore != null);

      const recommendedRows = scoredCands
        .filter((s) => (s.llmScore ?? 0) >= SCORE_FLOOR)
        .sort((a, b) => b.acceptanceOdds - a.acceptanceOdds || b.cand.recency01 - a.cand.recency01)
        .slice(0, limit);

      const recommendedIds = new Set(recommendedRows.map((s) => s.raJobId));
      const exploreCands = preMatch.coverageSet
        .filter((c) => {
          const id = raJobIdByKey.get(`${c.bank}:${c.job.id}`);
          return id && !recommendedIds.has(id);
        })
        .sort((a, b) => b.preScore - a.preScore)
        .slice(0, EXPLORE_CAP);

      // Bookmark state for everything we'll render.
      const allRaJobIds = [
        ...recommendedRows.map((s) => s.raJobId),
        ...exploreCands.map((c) => raJobIdByKey.get(`${c.bank}:${c.job.id}`)!).filter(Boolean),
      ];
      const bookmarked = await this.loadBookmarks(p, input.userId, allRaJobIds);

      // STEP 9 — insight (Sonnet, 1 call over the recommended shortlist).
      const coverageStatsPre = {
        banksSwept,
        recommendedCount: recommendedRows.length,
        exploreCount: exploreCands.length,
      };
      let portfolioSummary = '';
      const insightNotes = new Map<string, { acceptanceNote: string; raiseOddsNote: string | null }>();
      if (recommendedRows.length > 0) {
        const shortlist: CrossBankInsightShortlistItem[] = recommendedRows.map((s) => ({
          jobId: s.raJobId,
          title: s.cand.job.title,
          companyName: s.cand.company.companyName,
          bank: s.cand.bank,
          matchScore: s.llmScore ?? 0,
          inviteBar: s.cand.inviteBar,
          barIsDefault: s.cand.barIsDefault,
          acceptanceOdds: s.acceptanceOdds,
          acceptanceBand: s.acceptanceBand,
          tier: 'recommended',
          strengths: s.strengths,
          gaps: s.gaps,
          raiseOddsLevers: s.raiseOddsLevers,
        }));
        const insight = await raCrossBankInsightAgent
          .run(
            {
              candidateHeadline,
              locale,
              coverage: {
                banksSwept,
                banksDegraded,
                totalRetrieved: rows.length,
                materialized: raJobIdByKey.size,
                recommendedCount: coverageStatsPre.recommendedCount,
                exploreCount: coverageStatsPre.exploreCount,
                droppedTwins: preMatch.droppedTwins,
                metSolidTarget: recommendedRows.length >= Math.min(5, limit),
                perBank: {},
              },
              shortlist,
            },
            { requestId: input.requestId, locale, signal: input.signal },
          )
          .catch(() => null);
        if (insight) {
          await this.bill('ra_crossbank_insight', input, null, null);
          portfolioSummary = insight.portfolioSummary;
          for (const n of insight.perJob) insightNotes.set(n.jobId, {
            acceptanceNote: n.acceptanceNote,
            raiseOddsNote: n.raiseOddsNote,
          });
        }
      }

      // Build cards.
      const recommended = recommendedRows.map((s) =>
        this.toCard(s.cand, s.raJobId, s.llmScore, s, 'recommended', bookmarked, insightNotes),
      );
      const explore = exploreCands.map((c) => {
        const raJobId = raJobIdByKey.get(`${c.bank}:${c.job.id}`)!;
        const scored = scoredMap.get(raJobId);
        return this.toCard(
          c,
          raJobId,
          scored?.llmScore ?? null,
          scored ?? null,
          c.tier === 'core' ? 'adjacent' : c.tier,
          bookmarked,
          insightNotes,
        );
      });

      const coverage = buildCoverageStats({
        banksSwept,
        banksDegraded,
        totalRetrieved: rows.length,
        materialized: raJobIdByKey.size,
        droppedTwins: preMatch.droppedTwins,
        recommended,
        explore,
        perBankRetrieved,
        minSolidTarget: Math.min(5, limit),
      });

      return {
        recommended,
        explore,
        coverage,
        insight: portfolioSummary ? { portfolioSummary } : null,
        banksSwept,
        banksDegraded,
        scorerCallsUsed,
        scorerCacheHits,
        zeroResults: recommended.length + explore.length === 0,
      };
    } catch (err) {
      logger.error(TAG, 'cross-bank round failed', {
        error: err instanceof Error ? err.message : String(err),
      }, input.requestId);
      return zeroResult(banksSwept, banksDegraded);
    } finally {
      logger.info(TAG, 'cross-bank round complete', {
        userId: input.userId,
        banksSwept,
        banksDegraded,
        scorerCalls: scorerCallsUsed,
        cacheHits: scorerCacheHits,
        durationMs: Date.now() - started,
      }, input.requestId);
    }
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private buildScoredRow(
    cand: PreMatchedCandidate,
    raJobId: string,
    llmScore: number,
    res: { summary: string; strengths: string[]; gaps: string[] },
  ): ScoredRow {
    const odds = computeAcceptanceOdds({
      llmScore,
      inviteBar: cand.inviteBar,
      barIsDefault: cand.barIsDefault,
      requiredCoverage: cand.requiredCoverage,
      keywordCoverage: cand.keywordCoverage,
      preferredOverlap: cand.preferredOverlap,
      inviteScaleOffset: Number.parseInt(process.env.RA_CROSSBANK_INVITE_OFFSET ?? '', 10) || 0,
    });
    return {
      cand,
      raJobId,
      llmScore,
      summary: res.summary,
      strengths: res.strengths,
      gaps: res.gaps,
      acceptanceOdds: odds.acceptanceOdds,
      acceptanceBand: odds.acceptanceBand,
      aboveBar: odds.aboveBar,
      raiseOddsLevers: computeRaiseOddsLevers(cand, res.gaps),
    };
  }

  private toCard(
    cand: PreMatchedCandidate,
    raJobId: string,
    llmScore: number | null,
    scored: ScoredRow | null,
    matchTier: DiscoverJobCard['matchTier'],
    bookmarked: Set<string>,
    insightNotes: Map<string, { acceptanceNote: string; raiseOddsNote: string | null }>,
  ): DiscoverJobCard {
    const note = insightNotes.get(raJobId);
    const whyMatched =
      note?.acceptanceNote ||
      scored?.summary ||
      (cand.tier === 'stretch' ? 'Worth a look — a transferable-skill stretch.' : 'A fit for your background.');
    return {
      id: raJobId,
      title: cand.job.title,
      companyName: cand.company.companyName,
      companyLogoUrl: cand.company.companyLogoUrl,
      location: cand.job.location,
      workType: cand.job.workType ?? 'onsite',
      salaryMin: cand.job.salaryMin,
      salaryMax: cand.job.salaryMax,
      salaryCurrency: cand.job.salaryCurrency ?? 'USD',
      salaryPeriod: normalizeSalaryPeriod(cand.job.salaryPeriod),
      postedAt: cand.job.publishedAt ? cand.job.publishedAt.toISOString() : null,
      isBookmarked: bookmarked.has(raJobId),
      matchScoreCached: llmScore,
      matchScore: llmScore ?? 0,
      acceptanceOdds: scored?.acceptanceOdds ?? 0,
      acceptanceBand: scored?.acceptanceBand ?? (cand.barIsDefault ? 'bar_unset' : 'reach'),
      inviteBar: cand.inviteBar,
      barIsDefault: cand.barIsDefault,
      aboveBar: scored?.aboveBar ?? false,
      requiredCoverage: cand.requiredCoverage,
      matchTier,
      whyMatched,
      raiseOdds: note?.raiseOddsNote ?? null,
      source: cand.bank,
      sourcePublisher: bankDisplayName(cand.bank),
      alsoOnBank: cand.alsoOnBank,
      applyUrl: synthesizeApplyUrl(cand.bank, cand.job.id),
      isExternal: true,
    };
  }

  private async persistScore(
    p: any,
    input: CrossBankDiscoverInput,
    variant: { id: string; resumeContentHash: string },
    raJobId: string,
    cand: PreMatchedCandidate,
    res: { score: number; summary: string; strengths: string[]; gaps: string[]; keywordsMatched: string[]; keywordsMissing: string[] },
    locale: string,
  ): Promise<void> {
    const odds = computeAcceptanceOdds({
      llmScore: res.score,
      inviteBar: cand.inviteBar,
      barIsDefault: cand.barIsDefault,
      requiredCoverage: cand.requiredCoverage,
      keywordCoverage: cand.keywordCoverage,
      preferredOverlap: cand.preferredOverlap,
    });
    const explanation = {
      strengths: res.strengths,
      gaps: res.gaps,
      rationale: res.summary,
      signals: { skills: res.keywordsMatched, experience: [], location: [], salary: [] },
      responseLanguage: locale,
      promptVersion: SCORER_PROMPT_VERSION,
      crossBank: {
        bank: cand.bank,
        inviteBar: cand.inviteBar,
        barIsDefault: cand.barIsDefault,
        requiredCoverage: cand.requiredCoverage,
        keywordCoverage: cand.keywordCoverage,
        acceptanceOdds: odds.acceptanceOdds,
        acceptanceBand: odds.acceptanceBand,
        aboveBar: odds.aboveBar,
      },
    };
    const data = {
      score: res.score,
      explanation,
      resumeContentHashAtScore: variant.resumeContentHash,
      modelUsed: pickJobMatchScorerModel(),
    };
    await p.rAJobMatchScore.upsert({
      where: {
        userId_jobId_resumeVariantId: {
          userId: input.userId,
          jobId: raJobId,
          resumeVariantId: variant.id,
        },
      },
      create: { userId: input.userId, jobId: raJobId, resumeVariantId: variant.id, ...data },
      update: data,
    });
  }

  private async bill(
    sku: 'ra_crossbank_score' | 'ra_crossbank_insight',
    input: CrossBankDiscoverInput,
    raJobId: string | null,
    bank: BankId | null,
  ): Promise<void> {
    const patch = costPatchFromTally(input.requestId);
    await writeDeductionLog({
      userId: input.userId,
      sku,
      source: 'free_tier',
      units: 1,
      requestId: input.requestId ?? null,
      ...(raJobId ? { relatedEntityType: 'ra_job', relatedEntityId: raJobId } : {}),
      platformCostUsd: patch.platformCostUsd,
      metadata: { ...(patch.metadata ?? {}), source: 'roboapply_v2_crossbank', ...(bank ? { bank } : {}) },
    }).catch(() => undefined);
  }

  private async archiveStaleMirrors(p: any): Promise<void> {
    const cutoff = new Date(Date.now() - FRESHNESS_DAYS * 86_400_000);
    await p.rAJob.updateMany({
      where: { sourceBoard: { in: ['robohire', 'gohire'] }, archivedAt: null, postedAt: { lt: cutoff } },
      data: { archivedAt: new Date() },
    });
  }

  private async loadBookmarks(p: any, userId: string, raJobIds: string[]): Promise<Set<string>> {
    if (raJobIds.length === 0) return new Set();
    const rows = await p.rATrackerEntry.findMany({
      where: { userId, jobId: { in: raJobIds } },
      select: { jobId: true },
    });
    return new Set(rows.map((r: { jobId: string | null }) => r.jobId).filter(Boolean) as string[]);
  }

  private async loadDraft(p: any, userId: string): Promise<import('../types/onboarding.js').OnboardingDraftPreferences> {
    try {
      const row = await p.rAOnboardingState?.findUnique?.({ where: { userId }, select: { draftPreferences: true } });
      const dp = row?.draftPreferences;
      if (dp && typeof dp === 'object') return dp as any;
    } catch {
      /* best-effort */
    }
    return {};
  }
}

function localeCountry(locale: string): string {
  const map: Record<string, string> = {
    en: 'us', zh: 'cn', 'zh-TW': 'tw', ja: 'jp', ko: 'kr', es: 'es', fr: 'fr', pt: 'br', de: 'de',
  };
  return map[locale] ?? 'us';
}

export const raCrossBankSearchService = new RACrossBankSearchService();
export default raCrossBankSearchService;
