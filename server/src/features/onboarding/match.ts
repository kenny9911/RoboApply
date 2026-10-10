// server/src/features/onboarding/match.ts — O6 "Finding jobs" (WP-30).
//
// Five phases, each reported only AFTER its server work has finished (no
// timed fake progress, PRODUCT O6):
//   reading    the chosen resume is loaded (skipped when there is none)
//   saving     the answers are written to the default search profile
//   searching  a targeted ingest for the profile's titles × places
//              (`jobs.ingestForProfile`, WP-16b)
//   comparing  candidate jobs (public, canonical, live, this market) are
//              pre-scored deterministically (`match.preScoreMany`, WP-18)
//   ranking    sorted; the top 20 get an AI fit analysis queued (`job.score`)
//              when AI is allowed; the result is stored for O7
//
// GoApply (INT-08): the search is the G4 intent (期望职位 × 期望城市), not the
// RoboApply basics. When the user has not turned 个性化推荐 on (`personalized`
// answers false; PIPL Art. 24, the feed's own rule) the jobs are NOT compared
// with the profile: no pre-score, no AI analysis queued, and the result says
// `ranked: false` with the number of open jobs found. While GoApply's job
// feed is off (R-14 recruitment-info mode `off`; `searchAllowed` answers
// false) no source is searched and no posting is counted: the three search
// lines are reported as skipped, never as done.
//
// Hard cap 120 s (p50 target 45 s): when a phase ends past the cap, or the
// client goes away, the rest is queued as one `onboarding.match` item that
// queue-drain finishes (Vercel offers no work after the response).
//
// Who may write the saved search: only the O6 screen itself, i.e. a live
// request while the user is at `matching` or `confirm`. A queued run finishes
// minutes later, when the user may have completed setup and edited the search
// in the product; it reads the current search and never writes it (each step
// already wrote its answers when it was saved, so nothing is lost). The same
// holds for a re-run from the tour.
//
// What the stored count means (D3): `jobCount` is the number of compared jobs
// at Good fit or better; `compared` is how many open jobs the search found
// (at most the candidate cap, `comparedCapped`). `resumeCompared` says whether
// a resume was read for the comparison: without one the screens never call a
// number a fit. They show `searchCount` instead: the size of the SAVED SEARCH
// (the feed's own count for the default search's filters, the number /jobs
// lists). `compared` cannot stand in for it: the comparison's query uses the
// titles and countries only, stops at the cap and finds nothing without a
// title, so a user who skipped every step was told "no jobs for your search"
// while their unfiltered search listed the whole index.

import type { PreScoreResult } from '../match/index.js';
import {
  ONBOARDING_MATCH_AI_TOP_N,
  ONBOARDING_MATCH_HARD_CAP_MS,
  ONBOARDING_MATCH_PHASES,
  ROBOAPPLY_STEP_BODY_SCHEMAS,
  type OnboardingAnswers,
  type OnboardingMatchEvent,
  type OnboardingMatchPhase,
  type OnboardingMatchResult,
} from './contract.js';
import type { CandidateQuery, OnboardingRepo } from './repo.js';
import type { SearchProfileRef } from './service.js';
import { effectiveStage } from './stageMachine.js';
import { validFieldsOf } from './mapping.js';
import type { z } from 'zod';
import type { BrandId } from '../../platform/brand/registry.js';

export const ONBOARDING_MATCH_KIND = 'onboarding.match';
/** Candidates compared per run. */
export const ONBOARDING_MATCH_CANDIDATES = 200;
/** Ingest gets at most this much of the request; the rest is queued by the ingest itself. */
export const ONBOARDING_INGEST_BUDGET_MS = 60_000;

export interface MatchPipelineDeps {
  repo: OnboardingRepo;
  brand: { id: BrandId; market: 'intl' | 'cn' };
  now?: () => number;
  /** Write the answers to the search profile (service.applyAnswers). */
  applyAnswers(userId: string): Promise<SearchProfileRef>;
  /**
   * The user's default search profile as it is now (read only). Used by a run
   * that may not write the saved search (queued runs, a re-run from the tour).
   * Absent = such a run has no profile to search for and only ranks the index.
   */
  currentProfile?(userId: string): Promise<SearchProfileRef>;
  ingest(searchProfileId: string, budgetMs: number): Promise<unknown>;
  preScore(userId: string, jobIds: string[]): Promise<PreScoreResult[]>;
  aiAllowed(userId: string): Promise<boolean>;
  /**
   * May this user's jobs be ordered and scored with their profile? (feed
   * `isFeedPersonalized`: always true on RoboApply; on GoApply only with the
   * 个性化推荐 consent.) Absent = true.
   */
  personalized?(userId: string): Promise<boolean>;
  /** May this brand search and list jobs right now? (jobs/ingest `ingestAllowed`; GoApply: false in mode `off`.) Absent = true. */
  searchAllowed?(): boolean | Promise<boolean>;
  /**
   * How many open jobs the user's default saved search lists now (the feed's
   * count for its filters; `count: null` = the feed cannot say). Asked only
   * when no resume was compared. Absent = not counted.
   */
  searchCount?(userId: string): Promise<{ count: number | null; capped: boolean }>;
  enqueue(kind: string, payload: unknown, options: { userId: string; dedupeKey?: string; priority?: number }): Promise<unknown>;
  log?: (msg: string, meta: Record<string, unknown>) => void;
}

export interface MatchRunOptions {
  /** Each phase / done / error event (the SSE writer). */
  emit?: (event: OnboardingMatchEvent) => void;
  signal?: AbortSignal;
  /** Resume a queued run from this phase. */
  fromPhase?: OnboardingMatchPhase;
  /** Background run: no cap, does not move the stage. */
  background?: boolean;
  hardCapMs?: number;
}

export interface OnboardingMatchPayload {
  userId: string;
  fromPhase: OnboardingMatchPhase;
}

const ANY_CITY = 'any';

/** GoApply: the G4 intent's roles and cities (`onboardingAnswers.intent`, validated by onboarding-cn). */
function cnCandidateQuery(answers: OnboardingAnswers): CandidateQuery | null {
  const intent = answers.intent as { targetRoles?: unknown; cities?: unknown } | undefined;
  const roles = Array.isArray(intent?.targetRoles)
    ? intent.targetRoles.filter((r): r is { taxonomyId?: string; label?: string } => !!r && typeof r === 'object')
    : [];
  if (!roles.length) return null;
  const cities = Array.isArray(intent?.cities) ? intent.cities.filter((c): c is string => typeof c === 'string' && c !== ANY_CITY && c.trim() !== '') : [];
  return {
    market: 'cn',
    taxonomyIds: [...new Set(roles.map((r) => r.taxonomyId).filter((x): x is string => typeof x === 'string' && x !== ''))],
    titles: [...new Set(roles.filter((r) => !r.taxonomyId && typeof r.label === 'string' && r.label.trim() !== '').map((r) => r.label as string))],
    countries: [],
    cities: [...new Set(cities)],
    includeRemote: true,
    limit: ONBOARDING_MATCH_CANDIDATES,
  };
}

/**
 * What O6 searches for. RoboApply: the O2 answers (or the valid fields a
 * skipped O2 kept). GoApply: the G4 intent. Either way the resume's suggested
 * titles stand in when the user named none.
 */
export function candidateQueryFor(answers: OnboardingAnswers, market: 'intl' | 'cn'): CandidateQuery {
  if (market === 'cn') {
    const cn = cnCandidateQuery(answers);
    if (cn) return cn;
  }
  const b = validFieldsOf(ROBOAPPLY_STEP_BODY_SCHEMAS.basics, answers.basics) as Partial<z.infer<typeof ROBOAPPLY_STEP_BODY_SCHEMAS.basics>>;
  const countriesRaw = b.countries ?? [];
  const countries = [...new Set(countriesRaw.filter((c) => c !== 'REMOTE'))];
  const includeRemote = b.remoteOk !== false || countriesRaw.includes('REMOTE');
  if (b.jobFunctions) {
    return {
      market,
      taxonomyIds: [...new Set(b.jobFunctions.map((f) => f.taxonomyId).filter((x): x is string => !!x))],
      titles: [...new Set(b.jobFunctions.filter((f) => !f.taxonomyId).map((f) => f.label))],
      countries,
      includeRemote,
      limit: ONBOARDING_MATCH_CANDIDATES,
    };
  }
  const s = answers.resumeSuggestions as { suggestedTaxonomyIds?: string[]; profileDraft?: { targetRoles?: string[] } } | undefined;
  return {
    market,
    taxonomyIds: s?.suggestedTaxonomyIds ?? [],
    titles: s?.suggestedTaxonomyIds?.length ? [] : (s?.profileDraft?.targetRoles ?? []),
    countries,
    includeRemote,
    limit: ONBOARDING_MATCH_CANDIDATES,
  };
}

/** Stages at which a live run writes the answers to the saved search. */
const WRITE_STAGES: readonly string[] = ['matching', 'confirm'];

const TIER_RANK: Record<string, number> = { great: 3, good: 2, possible: 1, unlikely: 0 };

/** Sort pre-scores best first (unknown scores last; stable on job id). */
export function rankPreScores(results: PreScoreResult[]): PreScoreResult[] {
  return [...results].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (TIER_RANK[b.tier ?? ''] ?? -1) - (TIER_RANK[a.tier ?? ''] ?? -1) || a.jobId.localeCompare(b.jobId));
}

/** Run O6. Resolves with the stored result (or the partial one when the rest was queued). */
export async function runOnboardingMatch(deps: MatchPipelineDeps, userId: string, opts: MatchRunOptions = {}): Promise<OnboardingMatchResult | null> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const cap = opts.background ? Number.POSITIVE_INFINITY : (opts.hardCapMs ?? ONBOARDING_MATCH_HARD_CAP_MS);
  const emit = opts.emit ?? (() => undefined);
  const phases = ONBOARDING_MATCH_PHASES;
  // `ranking` needs the comparison's results, so a queued run restarts at `comparing`.
  const from = opts.fromPhase === 'ranking' ? 'comparing' : (opts.fromPhase ?? 'reading');
  const startAt = phases.indexOf(from);

  const rec = await deps.repo.read(userId);
  if (!rec) throw Object.assign(new Error('seeker profile not found'), { code: 'not_found' });
  const answers = rec.answers;

  let ranked: PreScoreResult[] = [];
  let compared = 0;
  let comparedCapped = false;
  let profile: SearchProfileRef | null = null;
  // Only the O6 screen writes the saved search (see the header).
  const mayWrite = !opts.background && WRITE_STAGES.includes(effectiveStage(deps.brand.id, rec));
  const searchProfile = (): Promise<SearchProfileRef | null> =>
    mayWrite ? deps.applyAnswers(userId) : deps.currentProfile ? deps.currentProfile(userId) : Promise.resolve(null);
  // Was a resume read for this comparison? (Looked up once; a queued run starts after `reading`.)
  const variantId = (answers.resume as { resumeVariantId?: string } | undefined)?.resumeVariantId;
  let resumeFound: boolean | null = null;
  const hasResume = async (): Promise<boolean> => (resumeFound ??= variantId ? (await deps.repo.getResume(userId, variantId)) !== null : false);
  // Read once per run: may the jobs be compared with the profile at all?
  let personalized: boolean | null = null;
  const mayRank = async (): Promise<boolean> => (personalized ??= deps.personalized ? await deps.personalized(userId) : true);
  const searchOn = deps.searchAllowed ? await deps.searchAllowed() : true;

  /** The saved search's size for a result with no resume compared; {} when it was not counted (never a guess, D3). */
  async function searchSize(): Promise<Pick<OnboardingMatchResult, 'searchCount' | 'searchCountCapped'>> {
    if (!searchOn || !deps.searchCount) return {};
    try {
      const res = await deps.searchCount(userId);
      return typeof res.count === 'number' ? { searchCount: res.count, searchCountCapped: res.capped === true } : {};
    } catch (err) {
      deps.log?.('onboarding search count failed; the heading shows no number', { userId, error: err instanceof Error ? err.message : String(err) });
      return {};
    }
  }

  async function queueRest(next: OnboardingMatchPhase, reason: string): Promise<void> {
    await deps.enqueue(ONBOARDING_MATCH_KIND, { userId, fromPhase: next } satisfies OnboardingMatchPayload, {
      userId,
      dedupeKey: `${ONBOARDING_MATCH_KIND}:${userId}`,
    });
    deps.log?.('onboarding match continues in the background', { userId, next, reason, elapsedMs: now() - started });
  }

  async function store(result: OnboardingMatchResult, advance: boolean): Promise<void> {
    await deps.repo.mutate(userId, (cur) => {
      const moveOn = advance && effectiveStage(deps.brand.id, cur) === 'matching';
      return { patch: { answers: { ...cur.answers, matching: result }, ...(moveOn ? { step: 'confirm' } : {}) }, result: null };
    });
  }

  for (let i = startAt; i < phases.length; i++) {
    const phase = phases[i];
    if (i > startAt) {
      const over = now() - started > cap;
      const gone = opts.signal?.aborted === true;
      if (over || gone) {
        await queueRest(phase, over ? 'hard_cap' : 'client_gone');
        const partial: OnboardingMatchResult = { jobCount: 0, compared, topJobIds: [], continuedInBackground: true, finishedAt: new Date(now()).toISOString() };
        if (!gone) {
          await store(partial, true);
          emit({ event: 'done', data: { jobCount: 0, topJobIds: [], continuedInBackground: true } });
        }
        return partial;
      }
    }
    switch (phase) {
      case 'reading':
        // No resume, or a deleted or foreign one, was not read: say so (the search uses the answers only).
        emit({ event: 'phase', data: (await hasResume()) ? { phase } : { phase, skipped: true } });
        break;
      case 'saving':
        if (!mayWrite) {
          // Not this run's to write: the saved search stays as the user has it now.
          profile = await searchProfile().catch(() => null);
          emit({ event: 'phase', data: { phase, skipped: true } });
          break;
        }
        profile = await deps.applyAnswers(userId);
        emit({ event: 'phase', data: { phase } });
        break;
      case 'searching': {
        if (!searchOn) {
          emit({ event: 'phase', data: { phase, skipped: true } });
          break;
        }
        profile ??= await searchProfile().catch(() => null);
        const remaining = Number.isFinite(cap) ? cap - (now() - started) - 30_000 : ONBOARDING_INGEST_BUDGET_MS;
        const budget = Math.max(5_000, Math.min(ONBOARDING_INGEST_BUDGET_MS, remaining));
        if (profile) {
          try {
            await deps.ingest(profile.id, budget);
          } catch (err) {
            // A provider failure still leaves whatever is already in the index.
            deps.log?.('onboarding ingest failed; ranking the existing index', { userId, error: err instanceof Error ? err.message : String(err) });
          }
        }
        emit({ event: 'phase', data: { phase } });
        break;
      }
      case 'comparing': {
        if (!searchOn) {
          emit({ event: 'phase', data: { phase, skipped: true } });
          break;
        }
        const query = candidateQueryFor(answers, deps.brand.market);
        const ids = await deps.repo.findCandidates(query);
        compared = ids.length;
        // At the cap there may be more open jobs than were looked at: every count from this run is a floor.
        comparedCapped = ids.length >= query.limit;
        // Without the user's say-so the profile is not used: the jobs are found, not compared.
        ranked = ids.length && (await mayRank()) ? rankPreScores(await deps.preScore(userId, ids)) : [];
        emit({ event: 'phase', data: (await mayRank()) ? { phase } : { phase, skipped: true } });
        break;
      }
      case 'ranking': {
        if (!searchOn || !(await mayRank())) {
          const result: OnboardingMatchResult = {
            jobCount: compared,
            compared,
            topJobIds: [],
            continuedInBackground: false,
            finishedAt: new Date(now()).toISOString(),
            ranked: false,
            resumeCompared: false,
            comparedCapped,
            ...(await searchSize()),
          };
          await store(result, !opts.background);
          emit({ event: 'phase', data: { phase, skipped: true } });
          emit({ event: 'done', data: { jobCount: result.jobCount, topJobIds: [], continuedInBackground: false } });
          return result;
        }
        const good = ranked.filter((r) => r.tier === 'great' || r.tier === 'good');
        const top = ranked.filter((r) => r.score !== null).slice(0, ONBOARDING_MATCH_AI_TOP_N);
        if (top.length && (await deps.aiAllowed(userId))) {
          for (const r of top) {
            await deps.enqueue('job.score', { userId, jobId: r.jobId }, { userId, dedupeKey: `job.score:onboarding:${userId}:${r.jobId}`, priority: 50 });
          }
        }
        const resumeCompared = await hasResume();
        const result: OnboardingMatchResult = {
          jobCount: good.length,
          compared,
          topJobIds: top.map((r) => r.jobId),
          continuedInBackground: false,
          finishedAt: new Date(now()).toISOString(),
          ranked: true,
          resumeCompared,
          comparedCapped,
          // No resume: the heading counts the saved search, so that number is stored with the result.
          ...(resumeCompared ? {} : await searchSize()),
        };
        await store(result, !opts.background);
        emit({ event: 'phase', data: { phase } });
        emit({ event: 'done', data: { jobCount: result.jobCount, topJobIds: result.topJobIds, continuedInBackground: false } });
        return result;
      }
    }
  }
  return null;
}
