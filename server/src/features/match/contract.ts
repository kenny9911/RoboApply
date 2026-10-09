// server/src/features/match/contract.ts
//
// Fit scoring, fit analysis and the competitiveness report (ARCHITECTURE.md
// §2.5, §3.4, §4.7; TASK_PLAN.md WP-18, WP-77; R-09). Mount:
// /api/v1/roboapply/match. `POST /jobs/:id/score` lives on the job-detail
// router and calls `matchService.scoreJob`.
//
// Tiers (R-09, config MATCH_TIERS): Great ≥80 · Good 65–79 · Possible 45–64 ·
// Unlikely <45. Weights 35/30/15/10/10 (MATCH_WEIGHTS). The server sums the
// total; the model never emits it. Every score renders with "This is not
// your chance of getting hired."

import { z } from 'zod';

export const DEFAULT_MATCH_TIERS = { great: 80, good: 65, possible: 45 } as const;
export const DEFAULT_MATCH_WEIGHTS = { title_level: 35, skills: 30, industry: 15, logistics: 10, career_path: 10 } as const;
export type MatchDimensionKey = keyof typeof DEFAULT_MATCH_WEIGHTS;
export type FitTierKey = 'great' | 'good' | 'possible' | 'unlikely';

/** Tier for a score with the default thresholds (WP-18 reads MATCH_TIERS config). */
export function tierForScore(score: number, tiers: { great: number; good: number; possible: number } = DEFAULT_MATCH_TIERS): FitTierKey {
  if (score >= tiers.great) return 'great';
  if (score >= tiers.good) return 'good';
  if (score >= tiers.possible) return 'possible';
  return 'unlikely';
}

const Id = z.string().min(1).max(64);
export const MatchJobParamsSchema = z.object({ id: Id });

// ── POST /match/jobs/:id/fit-analysis (credit `fit_analysis`, Idempotency-Key) ──

export const FitAnalysisBodySchema = z.object({ resumeVariantId: Id.optional() }).strict();
export interface FitAnalysisCard {
  jobId: string;
  score: number;
  tier: FitTierKey;
  kind: 'pre' | 'ai';
  dimensions: z.infer<typeof MatchDimensionsSchema>;
  skills: { aligned: string[]; missing: string[] };
  education: { required: string | null; yours: string | null; meets: boolean | null };
  highlights: string[];
  /** Second person, no number. */
  summary: string | null;
}

// ── Competitiveness report (flag `competitiveness`; credit `competitiveness`) ──

export const CompetitivenessBodySchema = z.object({ searchProfileId: Id }).strict();
/** D3: comparative numbers carry `{ value, source, sampleSize }`; suppressed below MIN_SAMPLE. */
export interface CompetitivenessReport {
  id: string;
  searchProfileId: string;
  /** Share of postings whose degree/years/skill requirements the user meets. */
  meetsRequirements: { value: number; source: 'index'; sampleSize: number; asOf: string } | null;
  /** "asked for in X of Y posts". */
  topSkills: Array<{ skill: string; askedIn: number; outOf: number; youHave: boolean }>;
  /** "Broaden your search" options with real extra-job counts. */
  broaden: Array<{ label: string; filterDiff: unknown; extraJobs: number }>;
  createdAt: string;
}

// ── Documented JSON columns (ra-match.prisma) ────────────────────────────

/** `RAJobMatchScore.dimensions` */
export const MatchDimensionsSchema = z.array(
  z
    .object({
      key: z.enum(['title_level', 'skills', 'industry', 'logistics', 'career_path']),
      weight: z.number(),
      score: z.number().nullable(),
      status: z.enum(['scored', 'not_stated']),
      evidence: z.array(z.object({ text: z.string(), source: z.enum(['resume', 'posting']), ref: z.string().optional() }).strict()),
    })
    .strict(),
);

/** `RAJobMatchScore.explanation` (legacy v2 scorer): `{ strengths, gaps, rationale, signals }` */
export const MatchExplanationSchema = z
  .object({
    strengths: z.array(z.string()),
    gaps: z.array(z.string()),
    rationale: z.string(),
    signals: z.object({ skills: z.unknown(), experience: z.unknown(), location: z.unknown(), salary: z.unknown() }).partial(),
  })
  .passthrough();

/** `RAKeywordExtraction.keywords`: top 30 `{ keyword, importance, frequency }` */
export const KeywordExtractionSchema = z.array(
  z.object({ keyword: z.string(), importance: z.enum(['high', 'medium', 'low']), frequency: z.number() }).strict(),
);

/** `RAFitReport.report` — the CompetitivenessReport body (without id/createdAt). */
export const FitReportBodySchema = z.record(z.string(), z.unknown());

export const MATCH_ERROR_CODES = {
  scoreCapReached: 'score_daily_cap',
  noResume: 'resume_required',
} as const;
