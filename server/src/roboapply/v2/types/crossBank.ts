// backend/src/roboapply/v2/types/crossBank.ts
//
// Shared contracts for the cross-bank job-search agent team. See
// docs/CROSSBANK_JOBSEARCH_SPEC.md for the authoritative design.
//
// The team searches TWO recruiter job banks (RoboHire + GoHire — same Prisma
// schema, two physical DBs), materializes matched recruiter `Job` rows into the
// candidate-side `RAJob` index, LLM-scores them, and returns a coverage/accuracy
// ranked result. These types are the seams between the five components:
// Explorer (Haiku) → Bank retrieval → Pre-Matcher (pure) → Precise Matcher
// (Sonnet, reused RAJobMatchScorerAgent) → Insight (Sonnet) → Orchestrator.

import type { OnboardingDraftPreferences } from './onboarding.js';
import type { RaLocale } from '../lib/raLocale.js';

export type BankId = 'robohire' | 'gohire';

export type SeniorityBand = 'entry' | 'mid' | 'senior' | 'lead' | 'exec' | 'unknown';

export type AcceptanceBand = 'strong' | 'on_the_bar' | 'reach' | 'bar_unset';

export type MatchTier = 'recommended' | 'adjacent' | 'stretch';

/** Candidate context derived deterministically from the resume variant. */
export interface CandidateSignals {
  currentTitles: string[];
  topSkills: string[];
  /** Canonical capability tags evidenced in the resume (bare + namespaced ok). */
  candidateTagSet: string[];
  /** Normalized keyword tokens from the resume. */
  candidateKeywords: string[];
  seniority: SeniorityBand;
  years: number | null;
}

// ─── Opportunity Explorer (Haiku) ────────────────────────────────────────

export interface CrossBankExplorerInput {
  candidateHeadline: string;
  currentTitles: string[];
  topSkills: string[];
  seniority: SeniorityBand;
  yearsExperience: number | null;
  draft: OnboardingDraftPreferences;
  /** ISO-3166 alpha-2, lowercase. */
  marketCountry: string;
  banks: BankId[];
}

export interface CrossBankExplorerPlan {
  /** Always includes the candidate's stated/target role. */
  primaryTitles: string[];
  adjacentTitles: string[];
  stretchTitles: string[];
  /** Skill/domain tags that justify adjacency; both bare + namespaced forms. */
  transferableSkillTags: string[];
  mustKeywords: string[];
  niceKeywords: string[];
  seniorityBands: string[];
  rationale: string;
}

// ─── Bank retrieval seam (deterministic) ─────────────────────────────────

/** A recruiter Job row + its Company projection, tagged with its origin bank. */
export interface BankJobRow {
  bank: BankId;
  /** How this row was recalled (for observability). */
  retrievedVia: 'title' | 'keyword' | 'tag';
  job: {
    id: string;
    title: string;
    description: string | null;
    qualifications: string | null;
    hardRequirements: string | null;
    niceToHave: string | null;
    benefits: string | null;
    location: string | null;
    locationCity: string | null;
    locationCountry: string | null;
    workType: string | null;
    employmentType: string | null;
    experienceLevel: string | null;
    salaryMin: number | null;
    salaryMax: number | null;
    salaryCurrency: string | null;
    salaryPeriod: string | null;
    requiredTagSet: string[];
    preferredTagSet: string[];
    requiredKeywordSet: string[];
    preferredKeywordSet: string[];
    matchInviteScore: number | null;
    publishedAt: Date | null;
  };
  company: {
    companyName: string;
    companyLogoUrl: string | null;
  };
}

export interface BankSearchIntent {
  titles: string[];
  mustKeywords: string[];
  tags: string[];
  freshnessCutoff: Date;
  take: number;
}

// ─── Pre-Matcher (pure) ──────────────────────────────────────────────────

export interface PreMatchInput {
  rows: BankJobRow[];
  plan: CrossBankExplorerPlan;
  signals: CandidateSignals;
  draft: OnboardingDraftPreferences;
  /** Normalized token set of the whole resume (belt-and-suspenders coverage). */
  resumeTokens: Set<string>;
  scorerBudget: number;
  aggressiveness: 'balanced' | 'coverage' | 'precision';
}

export interface PreMatchedCandidate {
  bank: BankId;
  job: BankJobRow['job'];
  company: BankJobRow['company'];
  retrievedVia: BankJobRow['retrievedVia'];
  preScore: number;
  tier: 'core' | 'adjacent' | 'stretch';
  requiredCoverage: number;
  keywordCoverage: number;
  preferredOverlap: number;
  /** LLM-free projected 0-100 stand-in used before Sonnet scores. */
  projectedScore: number;
  inviteBar: number;
  barIsDefault: boolean;
  fingerprint: string;
  /** The other bank this same job was cross-posted on, if deduped. */
  alsoOnBank: BankId | null;
  recency01: number;
  /** The exact unsatisfied recruiter predicates — the only citable levers. */
  missingRequiredTags: string[];
  missingRequiredKeywords: string[];
}

export interface PreMatchResult {
  /** Everything above PRE_FLOOR — all materialized into RAJob. */
  coverageSet: PreMatchedCandidate[];
  /** The budget-limited subset that gets a Sonnet score. */
  toScore: PreMatchedCandidate[];
  droppedTwins: number;
}

// ─── Insight Analyst (Sonnet) ────────────────────────────────────────────

export interface CrossBankInsightShortlistItem {
  jobId: string;
  title: string;
  companyName: string;
  bank: BankId;
  matchScore: number;
  inviteBar: number;
  barIsDefault: boolean;
  acceptanceOdds: number;
  acceptanceBand: AcceptanceBand;
  tier: MatchTier;
  strengths: string[];
  gaps: string[];
  /** The deterministic raise-odds levers this note may cite (and nothing else). */
  raiseOddsLevers: string[];
}

export interface CrossBankInsightInput {
  candidateHeadline: string;
  locale: RaLocale;
  coverage: CrossBankCoverageStats;
  shortlist: CrossBankInsightShortlistItem[];
}

export interface CrossBankInsight {
  portfolioSummary: string;
  perJob: Array<{
    jobId: string;
    acceptanceNote: string;
    raiseOddsNote: string | null;
  }>;
}

// ─── Orchestrator I/O + wire DTO ─────────────────────────────────────────

export interface CrossBankCoverageStats {
  banksSwept: BankId[];
  banksDegraded: BankId[];
  totalRetrieved: number;
  materialized: number;
  recommendedCount: number;
  exploreCount: number;
  droppedTwins: number;
  metSolidTarget: boolean;
  perBank: Record<string, { retrieved: number; recommended: number }>;
}

export interface DiscoverJobCard {
  id: string;
  title: string;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  workType: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: 'month' | 'year' | 'week' | 'hour' | null;
  postedAt: string | null;
  isBookmarked: boolean;
  matchScoreCached: number | null;
  /** llmScore 0-100 (0 when unscored → Explore bucket). */
  matchScore: number;
  acceptanceOdds: number;
  acceptanceBand: AcceptanceBand;
  inviteBar: number;
  barIsDefault: boolean;
  aboveBar: boolean;
  requiredCoverage: number;
  matchTier: MatchTier;
  whyMatched: string;
  raiseOdds: string | null;
  source: BankId;
  sourcePublisher: string;
  alsoOnBank: BankId | null;
  applyUrl: string;
  isExternal: true;
}

export interface CrossBankDiscoverInput {
  userId: string;
  resumeVariantId: string | null;
  locale: RaLocale;
  requestId?: string;
  signal?: AbortSignal;
  /** Recommended-bucket cap, default 12. */
  limit?: number;
  aggressiveness?: 'balanced' | 'coverage' | 'precision';
}

export interface CrossBankDiscoverResult {
  recommended: DiscoverJobCard[];
  explore: DiscoverJobCard[];
  coverage: CrossBankCoverageStats;
  insight: { portfolioSummary: string } | null;
  banksSwept: BankId[];
  banksDegraded: BankId[];
  scorerCallsUsed: number;
  scorerCacheHits: number;
  zeroResults: boolean;
}
