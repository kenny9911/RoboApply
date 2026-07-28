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

export type RAOnboardingSessionStatus =
  | 'active'
  | 'completed'
  | 'skipped'
  | 'abandoned';

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

/** Which step the panel is showing — reported to `POST /onboarding/seen`. */
export type OnboardingStep = 'resume' | 'confirm';

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

export interface OnboardingBootstrapRequest {
  resumeVariantId: string;
}

/**
 * Step 2's entire payload. Also the exact shape `GET /session` returns, so a
 * mid-step reload restores without a second code path.
 */
export interface OnboardingSetupState {
  sessionId: string;
  returning: boolean;
  resumeVariant: { id: string; name: string };
  /** The IngestRecap rows — the evidence that earns the prefill. */
  ingestRows: IngestRow[];
  /** Seeded from the parsed resume. Editable; submitted whole on confirm. */
  draft: OnboardingDraftPreferences;
  /** Per-field provenance, keyed by OnboardingDraftPreferences field name. */
  fieldMeta: Record<string, OnboardingSeedFieldMeta>;
  /** Seeded but NOT selected — rendered as a tappable suggestion, never as an
   *  applied value. `locations` lands here; roles never do. */
  proposedFields: string[];
  evidence: OnboardingSeedEvidence;
  /** No roles could be derived — the client shows the thin-resume variant. */
  thin: boolean;
  /** The parallel LLM seed had not landed when this response was built. The
   *  screen is already correct; re-fetching `GET /session` once picks up the
   *  extra industries/roles if they arrived. Never blocks anything. */
  enrichmentPending: boolean;
}

export type OnboardingBootstrapResponse = OnboardingSetupState;
export type OnboardingSessionResponse = OnboardingSetupState;

export interface OnboardingConfirmRequest {
  sessionId: string;
  /** COMPLETE post-edit state. Present keys REPLACE the seeded draft — an
   *  empty array clears. Absent keys are left untouched. */
  draft: OnboardingDraftPreferences;
  /** The one optional free-text line. The only LLM call in the confirm path. */
  freeText?: string;
}

export interface OnboardingConfirmResponse {
  /** RACareerGoal view (routes/goal.ts shape). */
  goal: Record<string, unknown>;
  /** Full RAPreferences blob view (RAPreferencesService shape). */
  preferences: Record<string, unknown>;
  /** Draft field names the free-text line contributed, so the client can echo
   *  what it understood. Empty when `freeText` was blank or the call failed. */
  capturedFromNotes: string[];
}

export interface OnboardingSkipRequest {
  /** Optional — a skip with no session yet still stamps skippedAt. */
  sessionId?: string;
}

export interface OnboardingSkipResponse {
  skipped: true;
}

export interface OnboardingSeenRequest {
  step: OnboardingStep;
}

export interface OnboardingSeenResponse {
  /** The stored count AFTER this open. The client stops auto-opening at 2. */
  autoOpens: number;
}

// ─── Agent I/O schemas (backend-internal) ──────────────────────────────

/** PrefExtract (Haiku) — the free-text line on step 2, and nothing else. */
export interface OnboardingExtractorInput {
  /** Clipped 2000 chars. */
  userMessage: string;
  currentDraft: OnboardingDraftPreferences;
  askedTopics: string[];
}

export interface OnboardingExtractorOutput {
  /** Enum values normalized against the raOnboardingDraft.ts taxonomy
   *  tables in parseOutput; unknown values dropped. */
  updates: OnboardingDraftPreferences;
  declinedTopics: OnboardingTopic[];
  /** Per-field confidence (0–1), keyed by OnboardingDraftPreferences field
   *  name. Only fields present in `updates` appear. */
  fieldConfidence: Record<string, number>;
  /** User explicitly asked to see jobs. Vestigial in the two-step flow —
   *  the extractor's schema still emits it; nothing reads it. */
  wantsJobsNow: boolean;
  /** User pasted what looks like a resume into the notes line. */
  pastedResumeDetected: boolean;
}

/** ResumeSeed (Haiku, once at bootstrap, fire-and-forget). */
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

// ─── Planner I/O (still used by RAOnboardingRecommendService) ──────────
//
// The recommendation round no longer runs during setup, but
// RAOnboardingRecommendService still exports `evaluateCachedScore` /
// `passesPrefilter` into RACrossBankSearchService, and it imports
// `buildFallbackPlan` from RAOnboardingSearchPlannerAgent — so these three
// types stay until that service is split (see the handoff note in
// RAOnboardingService.ts).

export interface OnboardingPlannerInput {
  candidateHeadline: string;
  draft: OnboardingDraftPreferences;
  /** ISO-3166 alpha-2, lowercase (locale market default when unstated). */
  marketCountry: string;
}

export interface OnboardingInternalSearchPlan {
  q: string;
  workType?: OnboardingWorkMode;
  employmentType?: OnboardingEmploymentType;
  location?: string;
  /**
   * Stated salary floor (absolute, draft currency). MUST NOT be passed into
   * `RAJobIndexService.search()` — its `salaryMax >= salaryMin` filter is
   * currency-blind and excludes null-salary rows. Salary is enforced only in
   * the deterministic post-fetch prefilter.
   */
  salaryMin?: number;
}

export interface OnboardingExternalSearchPlan {
  /** Free-text query, e.g. "senior backend engineer in taipei". */
  query: string;
  /** ISO-3166 alpha-2, lowercase — JSearch `country`. */
  country: string;
  /** JSearch `language`, e.g. 'zh-tw'. */
  language?: string;
  /** JSearch `work_from_home`. */
  workFromHome?: boolean;
  /** Comma-separated JSearch enums — `employment_types`. */
  employmentTypes?: string;
  /** JSearch `date_posted`. */
  datePosted?: 'all' | 'today' | '3days' | 'week' | 'month';
}

export interface OnboardingSearchPlan {
  internal: OnboardingInternalSearchPlan;
  external: OnboardingExternalSearchPlan;
}

/**
 * A scored job card. Nothing in setup renders one any more (D10 — the flow
 * never shows what /jobs shows one second later); the type survives because
 * RAOnboardingRecommendService's card mappers are still compiled for the
 * cross-bank surface.
 */
export interface OnboardingJobCard {
  id: string;
  title: string;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  workType: OnboardingWorkMode;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  postedAt: string | null;
  isBookmarked: boolean;
  matchScoreCached: number | null;
  matchScore: number;
  whyMatched: string;
  source: 'internal' | 'jsearch' | 'activejobs' | 'linkedin' | 'robohire' | 'gohire';
  sourcePublisher?: string;
  applyUrl?: string;
  isExternal: boolean;
}

/** Machine keys for the recommend-round status shimmer (cross-bank surface). */
export type OnboardingStatusKey =
  | 'searching_internal'
  | 'searching_external'
  | 'scoring';

/**
 * Progress events a recommendation round can emit to its caller. This used to
 * be the full NDJSON union for `POST /onboarding/chat/stream`; that route and
 * its text/chips/quick-reply/transcript events are deleted. What remains is
 * the three shapes RAOnboardingRecommendService still writes, kept under the
 * historical name so that service compiles untouched while it waits to be
 * split into RAJobIngestService (see the handoff note in RAOnboardingService).
 */
export type RAOnboardingStreamEvent =
  | { type: 'status'; key: OnboardingStatusKey }
  | { type: 'job-cards'; jobs: OnboardingJobCard[] }
  | { type: 'error'; code: string; message: string; data?: unknown };
