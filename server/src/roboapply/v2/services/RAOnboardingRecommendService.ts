// backend/src/roboapply/v2/services/RAOnboardingRecommendService.ts
//
// WHAT IS LEFT OF THIS FILE, AND WHY IT STILL HAS THIS NAME
//
// It used to own one onboarding recommendation round: planner → internal RAJob
// query ∥ external provider fetch → deterministic prefilter → fingerprint dedup
// → capped cache-first scoring → pure score ranking → ≤5 cards. The two-step
// setup panel does not run a recommendation round — the destination (/jobs)
// renders real matches one second later — so `runRound`, `rehydrateCards`,
// `scoreRows`, `toCard`, `upsertExternalJob`, `composeWhyMatched` and the class
// that held them had no caller and are deleted. They are in git history at
// 127da1d if the ingest service that was meant to inherit them (spec §6.5,
// `RAJobIngestService`) ever gets written.
//
// What survives are the two pure decision functions that were never about
// onboarding in the first place, and that other surfaces import BY THIS PATH:
//
//   evaluateCachedScore — RAJobMatchScore cache acceptance. Imported by
//     RACrossBankSearchService; its fresh/scoreOnly contract is load-bearing
//     there (docs/CROSSBANK_JOBSEARCH_SPEC.md §6).
//   passesPrefilter — the deterministic post-fetch job prefilter, with its own
//     unit tests pinning the salary-period rule.
//
// The file keeps its name so those imports keep resolving; renaming it is a
// separate move that belongs with the RAJobIngestService split.
//
// Rules preserved from the original, because they are still what these two
// functions do:
//   E5/R3 — salary is enforced ONLY in the deterministic post-fetch prefilter:
//         null salary = PASS, currency or period mismatch = SKIP comparison.
//   E7/R4 — work-mode / employment-type hard filters pass unknown values.
//         Work mode is hard-filtered only when the stated set is exactly
//         ['remote'], and an external row's 'onsite' is treated as unknown
//         (only is_remote=true is trustworthy).
//   E8/R5/R11 — RAJobMatchScore cache acceptance requires the current scorer
//         model plus explanation.responseLanguage === locale and a present
//         explanation.promptVersion. A model mismatch invalidates the score;
//         a locale/version mismatch keeps only the numeric score reusable.

import type { RaLocale } from '../lib/raLocale.js';
import type { OnboardingDraftPreferences } from '../types/onboarding.js';

// ─── Cache acceptance (E8/R5/R11) ──────────────────────────────────────

export interface CacheDecision {
  /** Score + prose both reusable. */
  fresh: boolean;
  /** Hash matched but locale/promptVersion didn't — score ranks, prose is
   *  stale (re-score within budget, else a deterministic catalog line). */
  scoreOnly: boolean;
}

export function evaluateCachedScore(
  row: {
    resumeContentHashAtScore?: string | null;
    modelUsed?: string | null;
    explanation?: unknown;
  } | null | undefined,
  variantHash: string | null | undefined,
  locale: RaLocale,
  currentModel: string,
): CacheDecision {
  if (
    !row ||
    !variantHash ||
    row.resumeContentHashAtScore !== variantHash ||
    row.modelUsed !== currentModel
  ) {
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
  /** True when the workType value can be trusted (an aggregator's 'onsite'
   *  cannot). */
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
