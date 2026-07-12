// backend/src/roboapply/v2/services/RAOnboardingRecommendService.ts
//
// One onboarding recommendation round (spec §4.5, with the adversarial-review
// rewrites baked in): planner → internal RAJob query ∥ external JSearch fetch
// → deterministic prefilter → fingerprint dedup → capped cache-first scoring
// → pure score ranking → ≤5 cards. Owned and budgeted entirely by
// RAOnboardingService — this module never decides WHEN a round runs, only HOW.
//
// Critic fixes implemented here (numbers from /tmp/critic-*.md):
//   E6  — internal candidates come from a DIRECT prisma.rAJob query with our
//         own WHERE; RAJobIndexService.search's list-item shape lacks the
//         fields the prefilter + scorer need (titleNormalized, employmentType,
//         description, qualifications).
//   R1  — sourceBoard='seed' rows are EXCLUDED from candidates unless
//         RA_ONBOARDING_INCLUDE_SEED_JOBS === 'true' (the seed corpus is demo
//         fiction with dead applyUrls); the internal-wins dedup preference
//         applies only to non-seed internal rows.
//   E5/R3 — salary is enforced ONLY in the deterministic post-fetch prefilter:
//         null salary = PASS, currency or period mismatch = SKIP comparison.
//         The planner's salaryMin is never passed to a DB filter.
//   E7/R4 — work-mode / employment-type hard filters pass unknown values.
//         Work mode is hard-filtered only when the stated set is exactly
//         ['remote'], and jsearch rows' 'onsite' is treated as unknown (the
//         /search payload has no hybrid signal; only is_remote=true is
//         trustworthy).
//   E9b — scorer concurrency is a single wave of ≤8, and internal candidates
//         start scoring WHILE the JSearch fetch is still in flight.
//   E8/R5/R11 — RAJobMatchScore cache acceptance requires
//         explanation.responseLanguage === locale AND explanation.promptVersion
//         present; both are stamped on every new write. Mismatch = re-score
//         within budget; last resort = deterministic catalog whyMatched. The
//         whyMatched composer falls back from summary to explanation.rationale
//         (legacy cache shape) and guards against score-pattern / third-person
//         prose leaking onto cards.
//   E13 — dedup fingerprint via raOnboardingDraft.jobFingerprint (null-city
//         tolerant).
//   R15 — ranking is purely by score (floor 60, recency tie-break); no 3+2
//         source-mix quota.
//
// Failure contract: runRound NEVER throws — every stage is try/caught and the
// round degrades (external-only failure → internal-only; everything failed →
// zeroResults so the orchestrator narrates the catalog zero-results turn).

import prisma from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';
import { writeDeductionLog } from '../../../lib/matchBilling.js';
import { costPatchFromTally } from '../../../lib/deductionCost.js';
import {
  searchAllProviders,
  enabledExternalProviders,
  EXTERNAL_SOURCE_BOARDS,
  EXTERNAL_SOURCE_BOARD_SET,
  type ExternalJobNormalized,
  type ExternalSearchParams,
  type AggregateSearchResult,
} from '../lib/raJobProviders.js';
import { normalizeForSearch } from '../lib/raJobSearch.js';
import { jobFingerprint, marketDefaultsForLocale } from '../lib/raOnboardingDraft.js';
import { getMessages } from '../lib/raOnboardingMessages.js';
import { buildFallbackPlan } from '../agents/RAOnboardingSearchPlannerAgent.js';
import type { RaLocale } from '../lib/raLocale.js';
import type {
  OnboardingDraftPreferences,
  OnboardingJobCard,
  OnboardingSearchPlan,
  OnboardingWorkMode,
  RAOnboardingStreamEvent,
} from '../types/onboarding.js';

// Stamped into explanation.promptVersion on every fresh score write. Bump in
// lockstep with the RAJobMatchScorerAgent prompt header ("Prompt v2.1") —
// unversioned / older rows are card-stale (score still ranks, prose doesn't).
export const SCORER_PROMPT_VERSION = 'v2.1';

const SCORE_FLOOR = 60;
const CARDS_PER_ROUND = 5;
const INTERNAL_CANDIDATE_CAP = 12;
const EXTERNAL_CANDIDATE_CAP = 8;
const INTERNAL_QUERY_TAKE = 40;
/** Fresh-scorer slots held back for external candidates while a JSearch fetch
 *  is in flight (E9b overlap means internal scoring starts first and would
 *  otherwise starve the externals out of the budget). */
const EXTERNAL_SCORE_RESERVE = 3;
const JSEARCH_STALE_DAYS = 30;
const WHY_MATCHED_MAX_LEN = 240;

// ─── Local Postgres-safety helpers (forked, raRapidApiJobs.ts precedent) ──

function stripControl(input: string): string {
  let out = '';
  for (let k = 0; k < input.length; k += 1) {
    const c = input.charCodeAt(k);
    if (c === 9 || c === 10 || c === 13 || c > 31) out += input[k];
  }
  return out;
}

// ─── Public types ──────────────────────────────────────────────────────

export interface RecommendRoundInput {
  userId: string;
  sessionId: string;
  resumeVariantId: string | null;
  locale: RaLocale;
  requestId?: string;
  signal?: AbortSignal;
  draft: OnboardingDraftPreferences;
  candidateHeadline: string;
  /** 1-based round number (orchestrator-owned). */
  round: number;
  /** External queries already billed this session — the planner avoids repeats. */
  previousQueries?: string[];
  /** R13/budget gate — false means internal-only, JSearch is never touched. */
  allowJSearch: boolean;
  /** Fresh scorer calls available this round (≤8, session cap pre-applied). */
  scorerBudget: number;
  /** Already-surfaced + passed RAJob ids — never re-shown in-session. */
  excludeJobIds: string[];
  /** Status-event sink (searching_internal / searching_external / scoring). */
  emit?: (event: RAOnboardingStreamEvent) => void;
}

export interface RecommendRoundResult {
  cards: OnboardingJobCard[];
  /** Billed JSearch calls this round (0 or 1) — orchestrator persists. */
  jsearchCalls: number;
  scorerCallsUsed: number;
  scorerCacheHits: number;
  /** Draft stated a salary floor. */
  salaryFloorStated: boolean;
  /** ≥1 candidate was actually compared against the floor (currency+period
   *  matched). False with a stated floor ⇒ the catalog disclosure line. */
  salaryFilterApplied: boolean;
  /** The external query used (planner output) — for previousQueries. */
  externalQuery: string | null;
  zeroResults: boolean;
}

/** One scored candidate, pre-card. */
interface ScoredCandidate {
  jobId: string;
  row: any; // RAJob row (internal or freshly-upserted external)
  score: number;
  whyMatched: string;
  isExternal: boolean;
  postedAt: Date | null;
}

// ─── whyMatched guards (R11) ───────────────────────────────────────────

const SCORE_PATTERN =
  /\b\d{1,3}\s*\/\s*100\b|\bscore[sd]?\s*(?:of|:)?\s*\d{1,3}\b|\b\d{1,3}\s*分\b/i;
const THIRD_PERSON_PATTERN = /\bthe candidate\b|\bthis candidate\b/i;

function isCardSafeProse(text: string): boolean {
  if (!text.trim()) return false;
  return !SCORE_PATTERN.test(text) && !THIRD_PERSON_PATTERN.test(text);
}

/**
 * Compose the card's whyMatched line from scorer prose. Order: summary →
 * first strength → deterministic catalog fallback. On cache hits the caller
 * passes explanation.rationale as `summary` (legacy rows have no summary key).
 */
export function composeWhyMatched(
  summary: string | null | undefined,
  strengths: unknown,
  locale: RaLocale,
): string {
  const candidates: string[] = [];
  if (typeof summary === 'string') candidates.push(summary.trim());
  if (Array.isArray(strengths) && typeof strengths[0] === 'string') {
    candidates.push(strengths[0].trim());
  }
  for (const c of candidates) {
    if (isCardSafeProse(c)) return stripControl(c).slice(0, WHY_MATCHED_MAX_LEN);
  }
  return getMessages(locale).whyMatchedFallback;
}

// ─── Cache acceptance (E8/R5/R11) ──────────────────────────────────────

export interface CacheDecision {
  /** Score + prose both reusable. */
  fresh: boolean;
  /** Hash matched but locale/promptVersion didn't — score ranks, prose is
   *  stale (re-score within budget, else catalog whyMatched). */
  scoreOnly: boolean;
}

export function evaluateCachedScore(
  row: { resumeContentHashAtScore?: string | null; explanation?: unknown } | null | undefined,
  variantHash: string | null | undefined,
  locale: RaLocale,
): CacheDecision {
  if (!row || !variantHash || row.resumeContentHashAtScore !== variantHash) {
    return { fresh: false, scoreOnly: false };
  }
  const exp =
    row.explanation && typeof row.explanation === 'object' && !Array.isArray(row.explanation)
      ? (row.explanation as Record<string, unknown>)
      : null;
  const localeOk = exp?.responseLanguage === locale;
  const versionOk = typeof exp?.promptVersion === 'string' && exp.promptVersion.length > 0;
  if (localeOk && versionOk) return { fresh: true, scoreOnly: false };
  return { fresh: false, scoreOnly: true };
}

// ─── Deterministic prefilter (E5/E7/R3/R4) ─────────────────────────────

interface PrefilterCandidate {
  titleNormalized: string;
  companyName: string;
  description: string;
  /** Internal rows carry the column value; external rows 'remote' | 'unknown'. */
  workType: string;
  /** True when the workType value can be trusted (jsearch 'onsite' cannot). */
  workTypeKnown: boolean;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
}

interface PrefilterStats {
  salaryCompared: number;
}

function queryTokens(q: string | undefined): string[] {
  return (q ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * The deterministic post-fetch prefilter. Unknown values always PASS (E7/R4);
 * salary compares only on currency+period match (E5/R3). Returns pass/fail and
 * tallies how many rows were genuinely salary-compared (the disclosure flag).
 */
export function passesPrefilter(
  c: PrefilterCandidate,
  draft: OnboardingDraftPreferences,
  tokens: string[],
  stats: PrefilterStats,
): boolean {
  // Title-token overlap (≥1 query token in the normalized title). Empty query
  // (degraded plan) passes everything — ranking + scorer still gate quality.
  if (tokens.length > 0) {
    const title = c.titleNormalized;
    if (!tokens.some((t) => title.includes(t))) return false;
  }

  // Work mode — hard-filter only the exactly-['remote'] case, on KNOWN values.
  const modes = draft.workModes ?? [];
  if (modes.length === 1 && modes[0] === 'remote') {
    if (c.workTypeKnown && c.workType !== 'remote') return false;
  }

  // Employment type — drop only a KNOWN value outside the stated set.
  const types = draft.employmentTypes ?? [];
  if (types.length > 0 && c.employmentType != null) {
    if (!types.includes(c.employmentType as never)) return false;
  }

  // Salary floor — null salary passes; currency/period mismatch or an UNKNOWN
  // row period skips the comparison. A null row period must NOT be coerced to
  // 'year': external feeds (e.g. a Fantastic Jobs WEEK/DAY posting, or a JSearch
  // row with no period) carry a salary amount but no representable period, and
  // comparing a weekly figure against an annual floor would wrongly drop it.
  const floor = draft.salary?.min;
  if (floor != null && floor > 0) {
    const rowSalary = c.salaryMax ?? c.salaryMin;
    if (rowSalary != null) {
      const draftCurrency = draft.salary?.currency ?? null;
      const draftPeriod = draft.salary?.period ?? 'year';
      const rowPeriod = c.salaryPeriod; // no ?? 'year' — unknown period ⇒ skip
      if (
        draftCurrency != null &&
        c.salaryCurrency != null &&
        draftCurrency === c.salaryCurrency &&
        rowPeriod != null &&
        draftPeriod === rowPeriod
      ) {
        stats.salaryCompared += 1;
        if (rowSalary < floor) return false;
      }
    }
  }

  // Avoided industries + dealbreaker companies (cheap token containment).
  const haystack = `${c.titleNormalized} ${c.companyName.toLowerCase()} ${c.description
    .slice(0, 2000)
    .toLowerCase()}`;
  for (const avoided of draft.industriesAvoid ?? []) {
    if (avoided && haystack.includes(avoided.toLowerCase())) return false;
  }
  for (const breaker of draft.dealbreakers ?? []) {
    if (breaker && c.companyName.toLowerCase().includes(breaker.toLowerCase())) return false;
  }

  return true;
}

// ─── Service ───────────────────────────────────────────────────────────

export class RAOnboardingRecommendService {
  /**
   * Run one recommendation round. Never throws; the worst case is
   * `{ cards: [], zeroResults: true }` and the orchestrator narrates the
   * catalog zero-results turn with relaxation chips.
   */
  async runRound(input: RecommendRoundInput): Promise<RecommendRoundResult> {
    const startedAt = Date.now();
    const p = prisma as any;
    const emit = input.emit ?? (() => undefined);
    const result: RecommendRoundResult = {
      cards: [],
      jsearchCalls: 0,
      scorerCallsUsed: 0,
      scorerCacheHits: 0,
      salaryFloorStated: (input.draft.salary?.min ?? 0) > 0,
      salaryFilterApplied: false,
      externalQuery: null,
      zeroResults: true,
    };
    let planFallback = false;
    let internalCandidates = 0;
    let externalCandidates = 0;
    let dedupDropped = 0;
    let externalAgg: AggregateSearchResult | null = null;

    try {
      // Resume variant — without markdown there is nothing to score against.
      const variant = input.resumeVariantId
        ? await p.rAResumeVariant.findFirst({
            where: { id: input.resumeVariantId, userId: input.userId, deletedAt: null },
            select: { id: true, resumeMarkdown: true, resumeContentHash: true },
          })
        : null;
      if (!variant?.resumeMarkdown) return result;

      // Lazy staleness sweep — external apply links expire; archived rows drop
      // out of the internal corpus via the archivedAt filter below.
      try {
        await p.rAJob.updateMany({
          where: {
            sourceBoard: { in: [...EXTERNAL_SOURCE_BOARDS] },
            archivedAt: null,
            postedAt: { lt: new Date(Date.now() - JSEARCH_STALE_DAYS * 86_400_000) },
          },
          data: { archivedAt: new Date() },
        });
      } catch {
        /* sweep is best-effort */
      }

      // ── Plan (Haiku; deterministic fallback) ──
      const marketCountry =
        input.draft.locations?.countries?.[0]?.toLowerCase() ??
        marketDefaultsForLocale(input.locale).country;
      const plannerInput = {
        candidateHeadline: input.candidateHeadline,
        draft: input.draft,
        marketCountry,
        round: input.round,
        previousQueries: input.previousQueries ?? [],
      };
      let plan: OnboardingSearchPlan;
      try {
        const { raOnboardingSearchPlannerAgent } = await import(
          '../agents/RAOnboardingSearchPlannerAgent.js'
        );
        plan = await raOnboardingSearchPlannerAgent.run(plannerInput, {
          requestId: input.requestId,
          locale: input.locale,
          signal: input.signal,
        });
      } catch {
        planFallback = true;
        plan = buildFallbackPlan(plannerInput);
      }

      // ── External fetch kicked off first; internal scoring overlaps (E9b) ──
      // Fan out across every enabled provider (JSearch + Active Jobs DB +
      // LinkedIn) in parallel; the merged list is ordered so direct-apply
      // sources win the fingerprint dedup below. `jsearchCalls` stays 0/1 as an
      // external-ROUND marker (the per-session cap counts rounds, not provider
      // calls — see MAX_JSEARCH_PER_SESSION); each provider self-budgets.
      const externalProvidersActive = input.allowJSearch ? enabledExternalProviders() : [];
      const externalEnabled = externalProvidersActive.length > 0;
      let externalPromise: Promise<AggregateSearchResult | null> = Promise.resolve(null);
      if (externalEnabled) {
        emit({ type: 'status', key: 'searching_external' });
        result.externalQuery = plan.external.query;
        result.jsearchCalls = 1; // conservative: one external round (any providers)
        const externalParams: ExternalSearchParams = {
          query: plan.external.query,
          country: plan.external.country,
          language: plan.external.language,
          datePosted: plan.external.datePosted ?? 'month',
          workFromHome: plan.external.workFromHome,
          employmentTypes: plan.external.employmentTypes,
          // Fantastic Jobs wants a structured title + location (its title_filter
          // ANDs every word, so the market-language "role place" blob would
          // over-constrain). Feed it the English role query + location instead.
          titleQuery: plan.internal.q || plan.external.query,
          locationText: plan.internal.location || undefined,
        };
        externalPromise = searchAllProviders(externalParams, {
          requestId: input.requestId,
          signal: input.signal,
          providers: externalProvidersActive,
        });
      }

      // ── Internal candidates (direct prisma query — E6, seed exclusion — R1) ──
      emit({ type: 'status', key: 'searching_internal' });
      const includeSeed = process.env.RA_ONBOARDING_INCLUDE_SEED_JOBS === 'true';
      const tokens = queryTokens(plan.internal.q);
      // Boards to exclude from the internal corpus query. Seed fiction is always
      // out (unless explicitly opted in). When a fresh external fetch ran this
      // round, also exclude the external boards: those jobs arrive fresh from the
      // providers, so skipping their prior materializations prevents a stale
      // aggregator twin from beating a fresh direct-apply row in dedup and stops
      // external rows being re-scored as internal. On internal-only rounds we
      // KEEP them — they are the fallback inventory when no provider is queried.
      const excludedBoards: string[] = [];
      if (!includeSeed) excludedBoards.push('seed');
      if (externalEnabled) excludedBoards.push(...EXTERNAL_SOURCE_BOARDS);
      const where: any = {
        archivedAt: null,
        ...(input.excludeJobIds.length > 0
          ? { id: { notIn: input.excludeJobIds.slice(0, 200) } }
          : {}),
        ...(excludedBoards.length > 0 ? { sourceBoard: { notIn: excludedBoards } } : {}),
      };
      if (tokens.length > 0) {
        const orClauses: any[] = [];
        for (const t of tokens) {
          orClauses.push({ titleNormalized: { contains: t } });
          orClauses.push({ companyNameNormalized: { contains: t } });
          orClauses.push({ descriptionPlain: { contains: t, mode: 'insensitive' } });
        }
        where.OR = orClauses;
      }
      if (plan.internal.location) {
        const needle = plan.internal.location.toLowerCase();
        where.AND = [
          {
            OR: [
              { location: { contains: needle, mode: 'insensitive' } },
              { locationCity: { contains: needle, mode: 'insensitive' } },
            ],
          },
        ];
      }
      let internalRows: any[] = [];
      try {
        internalRows = await p.rAJob.findMany({
          where,
          orderBy: { postedAt: 'desc' },
          take: INTERNAL_QUERY_TAKE,
        });
      } catch (err) {
        logger.warn('RA_V2_ONBOARDING_RECOMMEND', 'internal job query failed', {
          requestId: input.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Fingerprints of previously-surfaced/passed rows — never repeat twins.
      const excludedFingerprints = new Set<string>();
      if (input.excludeJobIds.length > 0) {
        try {
          const prior = await p.rAJob.findMany({
            where: { id: { in: input.excludeJobIds.slice(0, 200) } },
            select: { title: true, companyName: true, locationCity: true, location: true, workType: true },
          });
          for (const r of prior) {
            excludedFingerprints.add(
              jobFingerprint({
                title: r.title,
                companyName: r.companyName,
                locationCity: r.locationCity,
                location: r.location,
                isRemote: r.workType === 'remote',
              }),
            );
          }
        } catch {
          /* best-effort */
        }
      }

      // Internal prefilter + in-pool dedup.
      const salaryStats: PrefilterStats = { salaryCompared: 0 };
      const internalPool: any[] = [];
      const internalFp = new Map<string, any>(); // fingerprint → row (recency order preserved)
      for (const row of internalRows) {
        const candidate: PrefilterCandidate = {
          titleNormalized: row.titleNormalized ?? normalizeForSearch(row.title ?? ''),
          companyName: row.companyName ?? '',
          description: row.descriptionPlain ?? row.description ?? '',
          workType: row.workType ?? 'onsite',
          // External rows store 'onsite' for unknown — never trust it (R4);
          // only workType === 'remote' is a trusted signal for any external board.
          workTypeKnown: !EXTERNAL_SOURCE_BOARD_SET.has(row.sourceBoard) || row.workType === 'remote',
          employmentType: row.employmentType ?? null,
          salaryMin: row.salaryMin ?? null,
          salaryMax: row.salaryMax ?? null,
          salaryCurrency: row.salaryCurrency ?? null,
          salaryPeriod: row.salaryPeriod ?? null,
        };
        if (!passesPrefilter(candidate, input.draft, tokens, salaryStats)) continue;
        const fp = jobFingerprint({
          title: row.title,
          companyName: row.companyName,
          locationCity: row.locationCity,
          location: row.location,
          isRemote: row.workType === 'remote',
        });
        if (excludedFingerprints.has(fp)) {
          dedupDropped += 1;
          continue;
        }
        if (internalFp.has(fp)) {
          dedupDropped += 1;
          continue;
        }
        internalFp.set(fp, row);
        internalPool.push({ row, fp });
        if (internalPool.length >= INTERNAL_CANDIDATE_CAP) break;
      }
      internalCandidates = internalPool.length;

      // ── Cache check for internal candidates ──
      const cacheRows: any[] = internalPool.length
        ? await p.rAJobMatchScore
            .findMany({
              where: {
                userId: input.userId,
                resumeVariantId: variant.id,
                jobId: { in: internalPool.map((c: any) => c.row.id) },
              },
            })
            .catch(() => [])
        : [];
      const cacheByJob = new Map<string, any>(cacheRows.map((r: any) => [r.jobId, r]));

      const scored: ScoredCandidate[] = [];
      const internalNeedingFresh: any[] = [];
      const internalScoreOnly: any[] = []; // hash-valid score, card-stale prose
      for (const { row } of internalPool) {
        const cached = cacheByJob.get(row.id);
        const decision = evaluateCachedScore(cached, variant.resumeContentHash, input.locale);
        if (decision.fresh) {
          result.scorerCacheHits += 1;
          const exp = cached.explanation as Record<string, unknown>;
          scored.push({
            jobId: row.id,
            row,
            score: cached.score,
            whyMatched: composeWhyMatched(
              (exp?.rationale as string) ?? null,
              exp?.strengths,
              input.locale,
            ),
            isExternal: EXTERNAL_SOURCE_BOARD_SET.has(row.sourceBoard),
            postedAt: row.postedAt ?? null,
          });
        } else if (decision.scoreOnly) {
          internalScoreOnly.push({ row, cached });
        } else {
          internalNeedingFresh.push(row);
        }
      }
      // Card-stale rows re-score when budget allows (queued after misses).
      internalNeedingFresh.push(...internalScoreOnly.map((s) => s.row));
      const scoreOnlyByJob = new Map<string, any>(
        internalScoreOnly.map((s) => [s.row.id, s.cached]),
      );

      // ── Score internal candidates while JSearch is in flight (E9b) ──
      const reserve = externalEnabled ? Math.min(EXTERNAL_SCORE_RESERVE, input.scorerBudget) : 0;
      const internalFreshCap = Math.max(0, input.scorerBudget - reserve);
      const internalToScore = internalNeedingFresh.slice(0, internalFreshCap);
      const internalScoringPromise = this.scoreRows(internalToScore, variant, input);

      // ── External candidates (merged across all enabled providers) ──
      externalAgg = await externalPromise;
      const externalJobs = externalAgg?.jobs ?? [];
      const externalPool: ExternalJobNormalized[] = [];
      const externalFp = new Set<string>();
      for (const e of externalJobs) {
        if (!e.applyUrl) continue; // a card without an apply path is useless
        const candidate: PrefilterCandidate = {
          titleNormalized: normalizeForSearch(e.title),
          companyName: e.company,
          description: e.description,
          workType: e.workType,
          workTypeKnown: e.workType === 'remote',
          employmentType: e.employmentType,
          salaryMin: e.salaryMin,
          salaryMax: e.salaryMax,
          salaryCurrency: e.salaryCurrency,
          salaryPeriod: e.salaryPeriod,
        };
        if (!passesPrefilter(candidate, input.draft, tokens, salaryStats)) continue;
        const fp = jobFingerprint({
          title: e.title,
          companyName: e.company,
          locationCity: e.locationCity,
          location: e.location,
          isRemote: e.workType === 'remote',
        });
        if (excludedFingerprints.has(fp) || externalFp.has(fp)) {
          dedupDropped += 1;
          continue;
        }
        // Cross-source dedup: internal wins, but only for non-seed internal
        // twins (R1 — a real posting must never lose to its seed fake).
        const internalTwin = internalFp.get(fp);
        if (internalTwin && internalTwin.sourceBoard !== 'seed') {
          dedupDropped += 1;
          continue;
        }
        externalFp.add(fp);
        externalPool.push(e);
        if (externalPool.length >= EXTERNAL_CANDIDATE_CAP) break;
      }
      externalCandidates = externalPool.length;

      // Upsert externals BEFORE scoring so RAJobMatchScore FK targets exist
      // (idempotent on @@unique(externalId, sourceBoard)).
      const externalRows: any[] = [];
      for (const e of externalPool) {
        const row = await this.upsertExternalJob(e).catch(() => null);
        if (row) externalRows.push(row);
      }

      // External cache check (re-surfaced jsearch rows may carry valid scores).
      const externalCache: any[] = externalRows.length
        ? await p.rAJobMatchScore
            .findMany({
              where: {
                userId: input.userId,
                resumeVariantId: variant.id,
                jobId: { in: externalRows.map((r) => r.id) },
              },
            })
            .catch(() => [])
        : [];
      const externalCacheByJob = new Map<string, any>(externalCache.map((r: any) => [r.jobId, r]));
      const externalNeedingFresh: any[] = [];
      for (const row of externalRows) {
        const decision = evaluateCachedScore(
          externalCacheByJob.get(row.id),
          variant.resumeContentHash,
          input.locale,
        );
        if (decision.fresh) {
          result.scorerCacheHits += 1;
          const exp = externalCacheByJob.get(row.id).explanation as Record<string, unknown>;
          scored.push({
            jobId: row.id,
            row,
            score: externalCacheByJob.get(row.id).score,
            whyMatched: composeWhyMatched(
              (exp?.rationale as string) ?? null,
              exp?.strengths,
              input.locale,
            ),
            isExternal: true,
            postedAt: row.postedAt ?? null,
          });
        } else {
          externalNeedingFresh.push(row);
        }
      }

      // ── Scoring wave completes (single wave, concurrency ≤8 total) ──
      emit({ type: 'status', key: 'scoring' });
      const internalScored = await internalScoringPromise;
      result.scorerCallsUsed += internalScored.attempted;
      scored.push(...internalScored.scored);

      const externalBudgetLeft = input.scorerBudget - result.scorerCallsUsed;
      const externalScored = await this.scoreRows(
        externalNeedingFresh.slice(0, Math.max(0, externalBudgetLeft)),
        variant,
        input,
      );
      result.scorerCallsUsed += externalScored.attempted;
      scored.push(...externalScored.scored);

      // Budget-exhausted card-stale rows: reuse the score for ranking with the
      // deterministic catalog whyMatched (R11 — stale prose never ships).
      const freshlyScoredIds = new Set(scored.map((s) => s.jobId));
      for (const [jobId, cached] of scoreOnlyByJob) {
        if (freshlyScoredIds.has(jobId)) continue;
        const row = internalPool.find((c: any) => c.row.id === jobId)?.row;
        if (!row) continue;
        scored.push({
          jobId,
          row,
          score: cached.score,
          whyMatched: getMessages(input.locale).whyMatchedFallback,
          isExternal: EXTERNAL_SOURCE_BOARD_SET.has(row.sourceBoard),
          postedAt: row.postedAt ?? null,
        });
      }

      result.salaryFilterApplied = result.salaryFloorStated && salaryStats.salaryCompared > 0;

      // ── Rank purely by score (floor 60), recency tie-break (R15) ──
      const ranked = scored
        .filter((s) => s.score >= SCORE_FLOOR)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          const ta = a.postedAt ? new Date(a.postedAt).getTime() : 0;
          const tb = b.postedAt ? new Date(b.postedAt).getTime() : 0;
          return tb - ta;
        })
        .slice(0, CARDS_PER_ROUND);

      // Bookmark state for the surfaced set only (one cheap batch query).
      const bookmarkedIds = new Set<string>();
      if (ranked.length > 0) {
        try {
          const marks = await p.rATrackerEntry.findMany({
            where: { userId: input.userId, jobId: { in: ranked.map((r) => r.jobId) } },
            select: { jobId: true },
          });
          for (const m of marks) if (m.jobId) bookmarkedIds.add(m.jobId);
        } catch {
          /* best-effort */
        }
      }

      result.cards = ranked.map((s) => this.toCard(s, bookmarkedIds.has(s.jobId)));
      result.zeroResults = result.cards.length === 0;
      return result;
    } catch (err) {
      logger.warn('RA_V2_ONBOARDING_RECOMMEND', 'round failed; returning zero results', {
        requestId: input.requestId,
        sessionId: input.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return result;
    } finally {
      logger.info('RA_V2_ONBOARDING_RECOMMEND', 'recommendation round finished', {
        requestId: input.requestId,
        sessionId: input.sessionId,
        round: input.round,
        planFallback,
        internalCandidates,
        externalCandidates,
        dedupDropped,
        scorerCalls: result.scorerCallsUsed,
        scorerCacheHits: result.scorerCacheHits,
        surfaced: result.cards.length,
        internalSurfaced: result.cards.filter((c) => !c.isExternal).length,
        externalSurfaced: result.cards.filter((c) => c.isExternal).length,
        externalRoundBilled: result.jsearchCalls,
        externalProvidersQueried: externalAgg?.providersQueried ?? [],
        externalProvidersWithResults: externalAgg?.providersWithResults ?? [],
        externalCountsByProvider: externalAgg?.countsByProvider ?? {},
        salaryFilterApplied: result.salaryFilterApplied,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  /**
   * Rehydrate previously-surfaced cards for GET /session (RAJob rows + their
   * cached scores; prose re-guarded, catalog fallback when unusable).
   */
  async rehydrateCards(
    userId: string,
    jobIds: string[],
    resumeVariantId: string | null,
    locale: RaLocale,
  ): Promise<OnboardingJobCard[]> {
    if (jobIds.length === 0) return [];
    const p = prisma as any;
    try {
      const [rows, scores, marks] = await Promise.all([
        p.rAJob.findMany({ where: { id: { in: jobIds } } }),
        resumeVariantId
          ? p.rAJobMatchScore.findMany({
              where: { userId, resumeVariantId, jobId: { in: jobIds } },
            })
          : Promise.resolve([]),
        p.rATrackerEntry.findMany({
          where: { userId, jobId: { in: jobIds } },
          select: { jobId: true },
        }),
      ]);
      const scoreByJob = new Map<string, any>(scores.map((s: any) => [s.jobId, s]));
      const bookmarked = new Set<string>(marks.map((m: any) => m.jobId).filter(Boolean));
      const rowById = new Map<string, any>(rows.map((r: any) => [r.id, r]));
      const cards: OnboardingJobCard[] = [];
      for (const jobId of jobIds) {
        const row = rowById.get(jobId);
        if (!row) continue;
        const cached = scoreByJob.get(jobId);
        const exp =
          cached?.explanation && typeof cached.explanation === 'object'
            ? (cached.explanation as Record<string, unknown>)
            : null;
        cards.push(
          this.toCard(
            {
              jobId,
              row,
              score: cached?.score ?? SCORE_FLOOR,
              whyMatched: composeWhyMatched(
                (exp?.rationale as string) ?? null,
                exp?.strengths,
                locale,
              ),
              isExternal: EXTERNAL_SOURCE_BOARD_SET.has(row.sourceBoard),
              postedAt: row.postedAt ?? null,
            },
            bookmarked.has(jobId),
          ),
        );
      }
      return cards;
    } catch (err) {
      logger.warn('RA_V2_ONBOARDING_RECOMMEND', 'card rehydration failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /** Score a batch of RAJob rows in one concurrent wave (≤8 rows by budget).
   *  Each fresh success upserts the cache row (locale + promptVersion stamped)
   *  and writes the audit-only ra_match_score deduction. Failed pairs are
   *  skipped — unscored jobs are never surfaced. */
  private async scoreRows(
    rows: any[],
    variant: { id: string; resumeMarkdown: string; resumeContentHash: string | null },
    input: RecommendRoundInput,
  ): Promise<{ scored: ScoredCandidate[]; attempted: number }> {
    if (rows.length === 0) return { scored: [], attempted: 0 };
    const p = prisma as any;
    let agent: any;
    let pickModel: () => string;
    try {
      const mod = await import('../agents/RAJobMatchScorerAgent.js');
      agent = mod.raJobMatchScorerAgent;
      pickModel = mod.pickJobMatchScorerModel;
    } catch {
      return { scored: [], attempted: rows.length };
    }

    const outcomes = await Promise.all(
      rows.map(async (row): Promise<ScoredCandidate | null> => {
        try {
          const out = await agent.run(
            {
              resumeMarkdown: variant.resumeMarkdown,
              jobTitle: row.title,
              jobDescription: row.description ?? '',
              jobQualifications: row.qualifications ?? '',
              jobBenefits: row.benefits ?? undefined,
            },
            { requestId: input.requestId, locale: input.locale, signal: input.signal },
          );
          const matched = Array.isArray(out?.keywordsMatched) ? out.keywordsMatched.length : 0;
          const missing = Array.isArray(out?.keywordsMissing) ? out.keywordsMissing.length : 0;
          const total = matched + missing || 1;
          const explanation = {
            strengths: Array.isArray(out?.strengths) ? out.strengths : [],
            gaps: Array.isArray(out?.gaps) ? out.gaps : [],
            rationale: typeof out?.summary === 'string' ? out.summary : '',
            signals: {
              skills: Math.round((matched / total) * 100),
              experience: out.score,
              location: row.workType === 'remote' ? 95 : 80,
              salary: 85,
            },
            // E8/R5/R11 — cache-acceptance stamps.
            responseLanguage: input.locale,
            promptVersion: SCORER_PROMPT_VERSION,
          };
          await p.rAJobMatchScore.upsert({
            where: {
              userId_jobId_resumeVariantId: {
                userId: input.userId,
                jobId: row.id,
                resumeVariantId: variant.id,
              },
            },
            create: {
              userId: input.userId,
              jobId: row.id,
              resumeVariantId: variant.id,
              score: out.score,
              explanation,
              resumeContentHashAtScore: variant.resumeContentHash ?? '',
              modelUsed: pickModel(),
              generatedAt: new Date(),
            },
            update: {
              score: out.score,
              explanation,
              resumeContentHashAtScore: variant.resumeContentHash ?? '',
              modelUsed: pickModel(),
              generatedAt: new Date(),
            },
          });
          const cost = costPatchFromTally(input.requestId);
          await writeDeductionLog({
            userId: input.userId,
            sku: 'ra_match_score',
            source: 'free_tier',
            platformCostUsd: cost.platformCostUsd,
            apiKeyId: null,
            units: 1,
            requestId: input.requestId ?? null,
            relatedEntityType: 'ra_job',
            relatedEntityId: row.id,
            metadata: {
              ...cost.metadata,
              source: 'roboapply_v2_onboarding',
              agent: 'RAJobMatchScorerAgent',
              sessionId: input.sessionId,
              resumeVariantId: variant.id,
            },
          });
          return {
            jobId: row.id,
            row,
            score: out.score,
            whyMatched: composeWhyMatched(out.summary, out.strengths, input.locale),
            // Derive per-row from the row's own board, not a batch-wide flag: a
            // previously-materialized external job (jsearch/activejobs/linkedin)
            // can re-enter through the internal query and be freshly scored — it
            // must still render as an external card (source + applyUrl), not
            // 'internal'. (The internal batch is filtered to non-external boards
            // when a fresh external fetch ran this round; on internal-only
            // rounds external rows legitimately arrive here.)
            isExternal: EXTERNAL_SOURCE_BOARD_SET.has(row.sourceBoard),
            postedAt: row.postedAt ?? null,
          };
        } catch (err) {
          logger.warn('RA_V2_ONBOARDING_RECOMMEND', 'scorer pair skipped', {
            requestId: input.requestId,
            jobId: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      }),
    );
    return {
      scored: outcomes.filter((o): o is ScoredCandidate => o !== null),
      attempted: rows.length,
    };
  }

  /** Idempotent ExternalJobNormalized → RAJob upsert (spec §4.4 mapping). */
  private async upsertExternalJob(e: ExternalJobNormalized): Promise<any> {
    const p = prisma as any;
    const descriptionPlain = stripControl(e.description.replace(/<[^>]+>/g, ' '));
    const data = {
      applyUrl: e.applyUrl ?? '',
      title: e.title,
      titleNormalized: normalizeForSearch(e.title),
      companyName: e.company,
      companyNameNormalized: normalizeForSearch(e.company),
      companyLogoUrl: e.companyLogoUrl,
      location: e.location,
      locationCity: e.locationCity,
      locationCountry: e.locationCountry,
      // Column is non-null; 'onsite' here means UNKNOWN for jsearch rows —
      // the prefilter treats it that way (R4), never as a real onsite signal.
      workType: e.workType === 'remote' ? 'remote' : 'onsite',
      employmentType: e.employmentType,
      salaryMin: e.salaryMin,
      salaryMax: e.salaryMax,
      salaryCurrency: e.salaryCurrency,
      salaryPeriod: e.salaryPeriod,
      description: e.description,
      descriptionPlain,
      postedAt: new Date(e.postedAt),
      seedTags: {
        sourcePublisher: e.sourcePublisher,
        applyIsDirect: e.applyIsDirect,
        ingestedVia: 'onboarding_v4',
      },
      archivedAt: null,
    };
    return p.rAJob.upsert({
      where: {
        externalId_sourceBoard: { externalId: e.externalId, sourceBoard: e.sourceBoard },
      },
      create: { externalId: e.externalId, sourceBoard: e.sourceBoard, ...data },
      update: data,
    });
  }

  private toCard(s: ScoredCandidate, isBookmarked: boolean): OnboardingJobCard {
    const row = s.row;
    const seedTags =
      row.seedTags && typeof row.seedTags === 'object' ? (row.seedTags as any) : {};
    const card: OnboardingJobCard = {
      id: row.id,
      title: row.title,
      companyName: row.companyName,
      companyLogoUrl: row.companyLogoUrl ?? null,
      location: row.location ?? null,
      workType: (row.workType ?? 'onsite') as OnboardingWorkMode,
      salaryMin: row.salaryMin ?? null,
      salaryMax: row.salaryMax ?? null,
      salaryCurrency: row.salaryCurrency ?? null,
      postedAt: row.postedAt
        ? row.postedAt instanceof Date
          ? row.postedAt.toISOString()
          : String(row.postedAt)
        : null,
      isBookmarked,
      matchScoreCached: s.score,
      matchScore: s.score,
      whyMatched: s.whyMatched,
      // isExternal ⟺ sourceBoard ∈ {jsearch, activejobs, linkedin} (all in the
      // card `source` union), so the cast is safe. Bank rows (robohire/gohire)
      // are not isExternal here and surface as 'internal' in the onboarding feed.
      source: s.isExternal ? (row.sourceBoard as OnboardingJobCard['source']) : 'internal',
      isExternal: s.isExternal,
    };
    if (s.isExternal) {
      if (typeof seedTags.sourcePublisher === 'string' && seedTags.sourcePublisher) {
        card.sourcePublisher = seedTags.sourcePublisher;
      }
      if (row.applyUrl) card.applyUrl = row.applyUrl;
    }
    return card;
  }
}

export const raOnboardingRecommendService = new RAOnboardingRecommendService();
export default raOnboardingRecommendService;
