// backend/src/roboapply/v2/types/onboarding.ts
//
// Wire + agent-I/O types for first-run setup (/api/v1/roboapply/v2/onboarding/*).
// Single source of truth — the frontend mirror in `roboapply/lib/api/v2/types.ts`
// copies the wire section byte-identically (mirrored, not imported — workspace
// boundary).
//
// Spec: docs/roboapply/ONBOARDING_SPEC.md §6. Deliberately dependency-free: no
// imports, so the mirror stays a pure copy.
//
// SHAPE (the whole product decision, in two sentences): setup is TWO steps —
// add a resume, then confirm what we read from it. There is no chat, no
// elicitation state machine, and no job cards inside the flow; the destination
// renders those one second later. Everything the old conversational contract
// carried — the NDJSON stream union, quick replies, transcripts, surfaced
// cards, `aggressiveness` — is deleted, not deprecated.

// ─── Closed enums ──────────────────────────────────────────────────────

export type OnboardingWorkMode = 'remote' | 'hybrid' | 'onsite';

export type OnboardingEmploymentType =
  | 'full_time'
  | 'contract'
  | 'part_time'
  | 'internship';

/** RACareerGoal.seniority vocabulary (schema.prisma RACareerGoal comment). */
export type OnboardingSeniority =
  | 'ic'
  | 'senior'
  | 'staff'
  | 'principal'
  | 'manager'
  | 'director'
  | 'vp'
  | 'cxo';

/**
 * Topics the free-text extractor can still decline against. The seven-topic
 * interrogation is gone; this survives only because
 * RAOnboardingPrefExtractAgent's output schema names them and the one
 * free-text line on step 2 goes through that agent unchanged.
 */
export type OnboardingTopic =
  | 'salary'
  | 'workMode'
  | 'industry'
  | 'employmentType'
  | 'location'
  | 'seniority';

// ─── Draft preferences (per-session, pre-persistence) ──────────────────

export interface OnboardingDraftSalary {
  /** Absolute amount in the stated currency (NOT the blob's K units). */
  min?: number | null;
  max?: number | null;
  /** ISO-4217, uppercase. */
  currency?: string | null;
  period?: 'year' | 'month' | 'hour' | null;
}

export interface OnboardingDraftLocations {
  /** ISO-3166 alpha-2, uppercase. */
  countries?: string[];
  cities?: string[];
  remoteOk?: boolean;
}

/**
 * The preference draft. On bootstrap it arrives SEEDED from the parsed resume;
 * on confirm the client submits its complete post-edit state.
 *
 * NOTE on names: `targetRoles` is the INTERNAL draft name only — at
 * persistence time it maps to the existing `roleTitles` blob key (the field
 * the /preferences page and preferencesToFilters() read). See
 * raOnboardingDraft.ts.
 */
export interface OnboardingDraftPreferences {
  targetRoles?: string[];
  seniority?: OnboardingSeniority | null;
  workModes?: OnboardingWorkMode[];
  salary?: OnboardingDraftSalary;
  employmentTypes?: OnboardingEmploymentType[];
  industriesTarget?: string[];
  industriesAvoid?: string[];
  /** RA_PREFERENCE_OPTIONS stage ids: seed|seriesA|seriesB|seriesC|late|public. */
  companyStages?: string[];
  companySizes?: string[];
  locations?: OnboardingDraftLocations;
  /** Companies the user would like to work for. BOOSTS, never filters (D12). */
  targetCompanies?: string[];
  mustHaves?: string[];
  dealbreakers?: string[];
}

// ─── Seed provenance ───────────────────────────────────────────────────

/**
 * Where a seeded value came from. The client MUST render these differently:
 * `resume` is "we read this", `inferred` is "we guessed this". A guessed city
 * presented as a fact is the exact failure mode that empties the feed for
 * someone in Bangalore looking for remote EU/US work — the seeded city is
 * therefore always a *proposal*, never a selected value.
 */
export type OnboardingSeedSource = 'resume' | 'inferred';

export interface OnboardingSeedFieldMeta {
  source: OnboardingSeedSource;
  /** 0–1. Confirm writes every submitted field at 1.0 regardless. */
  confidence: number;
}

/**
 * Deterministic, token-free evidence the confirm screen shows next to the
 * seeded chips ("3 roles · about 8 years" / "from your most recent address").
 * Never LLM-derived — this is the receipt for the prefill.
 */
export interface OnboardingSeedEvidence {
  roles?: string[];
  years?: number;
  city?: string;
  employers?: string[];
}

// ─── Ingest rows (the "what your resume says" recap) ───────────────────

export type IngestRowKind =
  | 'identity'
  | 'experience'
  | 'skills'
  | 'education'
  | 'links'
  | 'summary';

export interface IngestRow {
  id: string;
  kind: IngestRowKind;
  /** Localized via the raOnboardingMessages catalog. */
  label: string;
  /** Deterministically derived from the variant's real parse — never faked. */
  value: string;
}

// ─── Request / response DTOs ───────────────────────────────────────────

// ─── Agent I/O schemas (backend-internal) ──────────────────────────────

/** ResumeSeed (configured onboarding model, once at bootstrap, fire-and-forget). */
export interface OnboardingResumeSeedInput {
  /** `RAResumeVariant.parsedData`, JSON-stringified and clipped to 6000. */
  parsedJson: string;
  /** `resumeMarkdown`, clipped to 1200. */
  resumeMarkdown: string;
  /** Roles the deterministic pass already found — the agent contributes roles
   *  ONLY when this is empty. */
  deterministicRoles: string[];
}

export interface OnboardingResumeSeedOutput {
  updates: OnboardingDraftPreferences;
  fieldConfidence: Record<string, number>;
}

// The search-planner I/O (`OnboardingPlannerInput`,
// `OnboardingInternalSearchPlan`, `OnboardingExternalSearchPlan`,
// `OnboardingSearchPlan`), the recommend-round card (`OnboardingJobCard`) and
// its progress union (`OnboardingStatusKey`, `RAOnboardingStreamEvent`) are
// deleted with their only referents — RAOnboardingSearchPlannerAgent and
// RAOnboardingRecommendService.runRound. Setup never renders a job card (D10);
// /jobs does, one second later, off its own DTOs in types/crossBank.ts.
