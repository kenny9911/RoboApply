// backend/src/roboapply/v2/types/onboarding.ts
//
// Wire + agent-I/O types for the conversational onboarding chat
// (/api/v1/roboapply/v2/onboarding/*). Single source of truth — the
// frontend mirror in `roboapply/lib/api/v2/types.ts` copies the wire
// section byte-identically (mirrored, not imported — workspace boundary).
//
// Spec: docs/design-spec-roboapply-onboarding-chat.md §2 (API contracts)
// and §3.2 (agent I/O schemas). Deliberately dependency-free: no imports,
// so the mirror stays a pure copy.

// ─── Closed enums ──────────────────────────────────────────────────────

export type RAOnboardingSessionState =
  | 'greeting'
  | 'elicitation'
  | 'recommend'
  | 'wrap';

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

export type OnboardingAggressiveness = 'manual' | 'balanced' | 'aggressive';

/** Elicitation topics the deterministic chip/quick-reply composers know. */
export type OnboardingTopic =
  | 'salary'
  | 'workMode'
  | 'industry'
  | 'employmentType'
  | 'location'
  | 'seniority';

/** Machine keys for the status shimmer — localized client-side via next-intl. */
export type OnboardingStatusKey =
  | 'searching_internal'
  | 'searching_external'
  | 'scoring';

// ─── Draft preferences (per-session, pre-persistence) ──────────────────

export interface OnboardingDraftSalary {
  /** Absolute amount in the stated currency (NOT the blob's K units). */
  min?: number | null;
  max?: number | null;
  /** ISO-4217, uppercase. Stated → else locale-market inferred (confirmable). */
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
 * The conversation-captured preference draft. Keys are present only once the
 * topic was actually discussed (an explicit "clear X" writes an empty value);
 * undiscussed keys stay `undefined` so the persistence mappers can build a
 * sparse PATCH that never wipes stored preferences.
 *
 * NOTE on names: `targetRoles` is the INTERNAL draft name only — at
 * persistence time it maps to the existing `roleTitles` blob key (the field
 * the /preferences page reads). See raOnboardingDraft.ts.
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
  mustHaves?: string[];
  dealbreakers?: string[];
}

// ─── Ingest rows (the "what I picked up" recap) ────────────────────────

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

// ─── Job cards ─────────────────────────────────────────────────────────

export interface OnboardingJobCard {
  // RAJobListItem fields (RAJobIndexService.ts):
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
  // onboarding additions:
  /** 0–100, scorer output, floor 60. */
  matchScore: number;
  /** 1–2 sentences, in-locale, from scorer summary+strengths. */
  whyMatched: string;
  /** 'jsearch'|'activejobs'|'linkedin' = external RapidAPI providers;
   *  'robohire'|'gohire' rows are materialized by the cross-bank search agent
   *  team (RACrossBankSearchService) and surface in the same feed. */
  source: 'internal' | 'jsearch' | 'activejobs' | 'linkedin' | 'robohire' | 'gohire';
  /** "LinkedIn", "104人力銀行", "RoboHire", "GoHire" → rendered "via X". */
  sourcePublisher?: string;
  /** External only; open _blank rel="noopener nofollow". */
  applyUrl?: string;
  isExternal: boolean;
}

// ─── NDJSON stream event union (POST /onboarding/chat/stream) ──────────

export interface OnboardingQuickReplyOption {
  /** Machine id (closed-set enum / 'no_preference') — round-trips back to the
   *  server via `OnboardingChatStreamRequest.quickReplyId`, handled
   *  deterministically without the extractor. */
  id: string;
  /** Localized via the raOnboardingMessages catalog. */
  label: string;
}

export type RAOnboardingStreamEvent =
  | { type: 'session'; sessionId: string; state: RAOnboardingSessionState }
  | { type: 'text-delta'; delta: string }
  | { type: 'status'; key: OnboardingStatusKey }
  | {
      type: 'prefs-update';
      draft: OnboardingDraftPreferences;
      /** Field names newly set this turn. */
      captured: string[];
      /** The FULL standing set of fields still below the confidence bar
       *  (cumulative across turns, not a per-turn delta) — the assistant
       *  confirms them before they count; the tray replaces its suppress
       *  list with this set on every event. */
      unconfirmed: string[];
    }
  | { type: 'chips'; chips: string[] } // ≤4, in-locale
  | { type: 'quick-replies'; options: OnboardingQuickReplyOption[] }
  | { type: 'job-cards'; jobs: OnboardingJobCard[] } // ≤5
  | { type: 'state'; state: 'elicitation' | 'recommend' | 'wrap' }
  | { type: 'done'; turnCount: number }
  | { type: 'error'; code: string; message: string; data?: unknown };

// ─── Request / response DTOs ───────────────────────────────────────────

export interface OnboardingBootstrapRequest {
  resumeVariantId: string;
}

export interface OnboardingBootstrapResponse {
  sessionId: string;
  state: RAOnboardingSessionState; // 'greeting'
  returning: boolean;
  resumeVariant: { id: string; name: string };
  ingestRows: IngestRow[];
  /** Localized assistant message #1, references the candidate headline. */
  greeting: string;
  /** LLM 1–2 sentence opener in the user's voice, in-locale. */
  openingPrompt: string;
  /** 3–4 resume-grounded chips (catalog generics on kickoff failure). */
  chips: string[];
}

export interface OnboardingChatStreamRequest {
  sessionId: string;
  message: string;
  /** Set when the turn came from tapping an `OnboardingQuickReplyOption` —
   *  the orchestrator resolves the machine id deterministically (decline
   *  topic / set enum / show jobs) and skips the extractor for that turn.
   *  `message` still carries the localized label for the transcript. */
  quickReplyId?: string;
}

export interface OnboardingTranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string; // ISO timestamp
}

export interface OnboardingSessionResponse {
  sessionId: string;
  state: RAOnboardingSessionState;
  resumeVariantId: string | null;
  transcript: OnboardingTranscriptMessage[];
  draftPreferences: OnboardingDraftPreferences;
  capturedFields: string[];
  chips: string[];
  /** Only present while turnCount === 0. */
  openingPrompt?: string;
  /** Recomputed deterministically from the variant on restore. */
  ingestRows: IngestRow[];
  /** Rehydrated from RAJob + RAJobMatchScore rows. */
  surfacedJobs: OnboardingJobCard[];
  passedJobIds: string[];
  turnCount: number;
  recommendationRounds: number;
}

export interface OnboardingCompleteRequest {
  sessionId: string;
  aggressiveness: OnboardingAggressiveness;
}

export interface OnboardingCompleteResponse {
  /** RACareerGoal view (routes/goal.ts shape). */
  goal: Record<string, unknown>;
  /** Full RAPreferences blob view (RAPreferencesService shape). */
  preferences: Record<string, unknown>;
}

export interface OnboardingSkipRequest {
  /** Optional — skip from S0 has no session yet. */
  sessionId?: string;
}

export interface OnboardingSkipResponse {
  skipped: true;
}

export interface OnboardingPassRequest {
  sessionId: string;
  jobId: string;
}

export interface OnboardingPassResponse {
  passed: true;
}

// ─── Agent I/O schemas (backend-internal, spec §3.2) ───────────────────

/** #1 Kickoff (Sonnet, once at bootstrap). */
export interface OnboardingKickoffInput {
  summary: string | null;
  /** Clipped ~2400 chars (loadResumeContext pattern). */
  resumeMarkdown: string;
  variantName: string;
  returning: boolean;
  storedPrefsDigest?: string;
}

export interface OnboardingKickoffOutput {
  /** e.g. "Senior backend engineer, 8 yrs, payments". */
  candidateHeadline: string;
  /** ≤220 chars, first person, in-locale. */
  openingPrompt: string;
  /** 3–4 items, ≤60 chars each, in-locale. */
  chips: string[];
}

/** #3 PrefExtract (Haiku, every turn before the chat agent). */
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
   *  name. Only fields present in `updates` appear. A field < 0.7 is marked
   *  unconfirmed; co-captured high-confidence fields are unaffected. */
  fieldConfidence: Record<string, number>;
  /** User explicitly asked to see jobs — recommend-round trigger signal. */
  wantsJobsNow: boolean;
  /** User pasted what looks like a resume → redirect to the S0 paste flow. */
  pastedResumeDetected: boolean;
}

/** #4 Planner (Haiku, once per recommendation round). */
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
   * currency-blind and excludes null-salary rows (every jsearch row).
   * Salary is enforced only in the deterministic post-fetch prefilter:
   * null salary passes, currency mismatch skips the comparison.
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
  /** Comma-separated JSearch enums — `employment_types`, e.g. 'FULLTIME,CONTRACTOR'. */
  employmentTypes?: string;
  /** JSearch `date_posted`. */
  datePosted?: 'all' | 'today' | '3days' | 'week' | 'month';
}

export interface OnboardingSearchPlan {
  internal: OnboardingInternalSearchPlan;
  external: OnboardingExternalSearchPlan;
}
