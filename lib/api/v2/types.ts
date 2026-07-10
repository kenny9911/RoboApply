// lib/api/v2/types.ts
//
// RoboApply V2 — the typed API surface (RaV2Api) and every entity / request /
// response shape behind it. This file is the SINGLE source of truth for the
// frontend ↔ backend wire format.
//
// Mirrors `docs/roboapply/v2/03-frontend-architecture.md §4` and
// `docs/roboapply/v2/04-backend-spec.md §5`. When the real backend ships in
// Wave 4, the JSON it returns must round-trip against these types without
// changes here — discrepancy => fix the backend (or the stub), never these
// types. Same goes for the stub (`lib/stub/*`) which also implements
// `RaV2Api` and is the executable contract spec until Wave 4 lands.
//
// F2-F5 (Home / Resumes / Tracker / Search / Insights / Jobs page engineers)
// ONLY import from this file for V2 types.

// ─────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────

export type RATrackerStatus =
  | 'bookmarked'
  | 'applying'
  | 'applied'
  | 'interviewing'
  | 'negotiating'
  | 'accepted'
  | 'rejected'
  | 'withdrawn';

export type RAWorkType = 'remote' | 'hybrid' | 'onsite';

export type RAEmploymentType =
  | 'full_time'
  | 'contract'
  | 'part_time'
  | 'internship';

export type RAResumeKind = 'base' | 'tailored_for_jd' | 'from_template';

export type RASortBy = 'relevance' | 'recent' | 'salary_desc' | 'match_desc';

export type RAAppliedVia = 'ra_autoapply' | 'manual' | 'extension';

export type RASeniority =
  | 'ic'
  | 'senior'
  | 'staff'
  | 'principal'
  | 'manager'
  | 'director'
  | 'vp'
  | 'cxo';

export type RAKeywordImportance = 'high' | 'medium' | 'low';

export type RAJobTier = 'strong' | 'good' | 'stretch' | 'long_shot';

export type RADatePosted = 'today' | '7d' | '30d' | 'any';

export type RASourceBoard = 'greenhouse' | 'lever' | 'seed' | 'manual';

export type RASalaryPeriod = 'year' | 'hour' | 'month';

// ── V3 enums ──────────────────────────────────────────────────────────
// Added for the V3 redesign surfaces (queue / activity / mock / integrations
// / preferences + resume inline-AI). The existing `RASeniority` is reused for
// preferences seniority and `RAWorkType` for work-mode — do not duplicate.

export type RAQueueItemStatus = 'pending' | 'sending' | 'sent' | 'skipped';

/** Activity feed entry kind — drives the timeline dot color. */
export type RAActivityKind = 'success' | 'action' | 'note' | 'violet';

/** Resume inline-AI action (the 6 bullet buttons). */
export type RAResumeRewriteAction =
  | 'improve'
  | 'metrics'
  | 'shorten'
  | 'expand'
  | 'confident'
  | 'junior';

/** Which resume surface the rewrite targets. */
export type RAResumeRewriteMode = 'bullet' | 'summary' | 'skills';

/** A single tailor-diff change kind. */
export type RATailorChangeKind = 'rewrite' | 'add' | 'reorder' | 'trim';

/** Mock interview delivery format. */
export type RAMockFormat = 'video' | 'voice';

/** Live interview turn author. */
export type RAMockSpeaker = 'them' | 'you';

/** Integration providers. */
export type RAIntegrationProvider =
  | 'linkedin'
  | 'gmail'
  | 'gcal'
  | 'slack'
  | 'notion'
  | 'github';

/** Agent aggressiveness (preferences + onboarding). */
export type RAAggressiveness = 'manual' | 'balanced' | 'aggressive';

// ─────────────────────────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────────────────────────

export interface RACareerGoal {
  id: string;
  userId: string;
  targetTitle: string;
  /** ISO YYYY-MM-DD */
  targetDate: string | null;
  targetSalaryMin: number | null;
  targetSalaryMax: number | null;
  /** ISO 4217 currency code, defaults 'USD' */
  targetSalaryCurrency: string;
  /** 1..50, default 5 */
  weeklyApplicationGoal: number;
  preferredLocations: {
    countries: string[];
    cities: string[];
    remoteOk: boolean;
    hybridOk: boolean;
  } | null;
  preferredWorkType: RAWorkType | null;
  seniority: RASeniority | null;
  notesMarkdown: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RAJob {
  id: string;
  externalId: string;
  sourceBoard: RASourceBoard;
  applyUrl: string;
  title: string;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  workType: RAWorkType;
  employmentType: RAEmploymentType | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: RASalaryPeriod | null;
  /** markdown */
  description: string;
  qualifications: string | null;
  responsibilities: string | null;
  benefits: string | null;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Compact projection of `RAJob` used by `/search` results and `/home` recent
 *  jobs. Stays small so we can render fast lists. */
export interface RAJobListItem {
  id: string;
  title: string;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  workType: RAWorkType;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  postedAt: string | null;
  isBookmarked: boolean;
  matchScoreCached: number | null;
}

export interface RATrackerEntryView {
  id: string;
  userId: string;
  jobId: string | null;
  status: RATrackerStatus;
  /** 0..5 */
  excitementStars: number;
  maxSalary: number | null;
  maxSalaryCurrency: string | null;
  notesMarkdown: string | null;
  dateSaved: string;
  dateApplied: string | null;
  /** ISO YYYY-MM-DD */
  deadline: string | null;
  followUpAt: string | null;
  appliedVia: RAAppliedVia | null;
  linkedRunId: string | null;
  /** Hydrated job snapshot when `jobId` resolves to an `RAJob`. */
  job: {
    title: string;
    companyName: string;
    companyLogoUrl: string | null;
    location: string | null;
    workType: RAWorkType;
    applyUrl: string;
  } | null;
  /** Set when the entry was created from a pasted URL (no `RAJob` row). */
  externalSnapshot: {
    title: string;
    companyName: string;
    location?: string;
    applyUrl: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface RAJobMatchScoreView {
  /** 0..100 */
  score: number;
  explanation: {
    strengths: string[];
    gaps: string[];
    rationale: string;
    signals: {
      skills: number;
      experience: number;
      location: number;
      salary: number;
    };
  };
  generatedAt: string;
  resumeVariantId: string;
  stale: boolean;
}

export interface RAResumeVariant {
  id: string;
  userId: string;
  name: string;
  kind: RAResumeKind;
  targetJobId: string | null;
  basedOnVariantId: string | null;
  templateKey: string | null;
  resumeMarkdown: string;
  resumeContentHash: string;
  matchScoreCached: number | null;
  /** Exactly one variant per user is the primary résumé. */
  isPrimary?: boolean;
  /** 'upload' | 'scratch' | 'template' | 'linkedin' | 'tailored' */
  sourceKind?: string | null;
  /** Upload-parse lifecycle for uploads: 'parsed' | 'parsing' | 'failed'. */
  parseStatus?: string | null;
  /** AI-generated pitch summary (uploaded résumés only). */
  summary?: string | null;
  highlight?: string | null;
  /** Original uploaded file name, when an original was retained. */
  originalFileName?: string | null;
  /** True when an original file is downloadable via /resumes/:id/original-file. */
  hasOriginalFile?: boolean;
  lastEditedAt: string;
  createdAt: string;
  deletedAt: string | null;
}

/** Smaller list-projection used by `/resumes`. */
export interface RAResumeVariantSummary {
  id: string;
  name: string;
  kind: RAResumeKind;
  targetJobId: string | null;
  targetJobTitle: string | null;
  targetJobCompany: string | null;
  matchScoreCached: number | null;
  /** Exactly one variant per user is the primary résumé. */
  isPrimary?: boolean;
  /** 'upload' | 'scratch' | 'template' | 'linkedin' | 'tailored' */
  sourceKind?: string | null;
  lastEditedAt: string;
  createdAt: string;
}

export interface RASavedSearch {
  id: string;
  userId: string;
  name: string;
  query: SearchQuery;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RACareerInsight {
  id: string;
  userId: string;
  /** ISO date — Sunday-anchored UTC */
  weekStartUtc: string;
  summaryMarkdown: string;
  citedTrackerIds: string[];
  metrics: {
    applicationsCount: number;
    interviewsCount: number;
    offerCount: number;
    weeksToOfferEstimate: number | null;
    recruiterViewsCount: number | null;
    topSkillsObserved: string[];
  } | null;
  modelUsed: string;
  citationGuardPassed: boolean;
  generatedAt: string;
  createdAt: string;
}

export interface RAKeyword {
  keyword: string;
  importance: RAKeywordImportance;
  frequency: number;
}

// ─────────────────────────────────────────────────────────────────────
// V3 entities — queue / activity / mock / integrations / preferences
// ─────────────────────────────────────────────────────────────────────

/** One screening check chip on a queue card. */
export interface RAQueueCheck {
  /** e.g. "Resume", "Cover", "Questions", "Portfolio" */
  key: string;
  /** e.g. "Tailored — emphasized healthtech work" */
  value: string;
}

/** A queued auto-apply, shaped for the review-queue card. */
export interface RAQueueItem {
  id: string;
  jobId: string | null;
  title: string;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  /** 0..100 */
  matchScore: number;
  /** ISO — when the agent will auto-submit if untouched. Client renders the
   *  live "Auto-applies in 18m" countdown from this. */
  plannedSubmitAt: string;
  status: RAQueueItemStatus;
  /** The draft cover letter, MARKDOWN. Rendered sanitized. */
  coverLetterMarkdown: string;
  checks: RAQueueCheck[];
  createdAt: string;
  updatedAt: string;
}

/** One row in the activity timeline. */
export interface RAActivityEntry {
  id: string;
  /** ISO timestamp */
  at: string;
  kind: RAActivityKind;
  /** MARKDOWN — may include **bold**, company links. Rendered sanitized. */
  bodyMarkdown: string;
  /** Right-aligned meta, e.g. "8m saved", "Step 3 of 4", "Auto-declined".
   *  When it contains "saved" the UI renders the green pill. */
  meta: string | null;
  /** Optional deep-link target (jobId / runId) for click-through. */
  relatedJobId: string | null;
}

/** Activity entries grouped under a day header. */
export interface RAActivityDay {
  /** Display label, e.g. "Today · Thu, May 26" */
  label: string;
  /** ISO date (YYYY-MM-DD) for sorting */
  dateUtc: string;
  entries: RAActivityEntry[];
}

/** The agent aggregate — sidebar orb 3-up + Today hero strip + Activity strip
 *  + Plan-usage extras. One cheap call feeds all three surfaces. */
export interface RAAgentStats {
  /** Sidebar orb 3-up */
  sent: number;
  replies: number;
  /** hours saved (e.g. 11.5) */
  hoursSaved: number;
  /** Today hero strip */
  autoAppliedToday: number;
  scannedOvernight: number;
  matchedAboveThreshold: number;
  inQueue: number;
  /** Activity strip / Plan usage extras */
  draftsWritten: number;
  /** 0..1 reply rate for the Plan usage bar */
  replyRate: number;
  hoursSavedLifetime: number;
  /** The live status line cycled in the orb is CLIENT-side (STATUS_LINES);
   *  this optional field lets the server pin a "current action" if it wants. */
  currentAction: string | null;
}

export type RAMockArchetype =
  | 'warmup'
  | 'behavioral'
  | 'breadth'
  | 'potential'
  | 'depth'
  | 'communication'
  | 'pressure';

/** An interviewer persona (proto INTERVIEWERS). */
export interface RAMockInterviewer {
  id: string;
  name: string;
  /** e.g. "The Skeptical VP" */
  role: string;
  blurb: string;
  /** 1..3 */
  difficulty: number;
  /** two-stop gradient for the orb */
  palette: [string, string];
  /** e.g. "ex-Stripe" */
  company: string;
  /** e.g. "Pointed · Adversarial · Numbers-first" */
  style: string;
  /** The interviewing philosophy this persona embodies (drives prompt + grading). */
  archetype: RAMockArchetype;
}

/** An interview type (proto INTERVIEW_TYPES). */
export interface RAMockType {
  id: string;
  label: string;
  sub: string;
  minutes: number;
  /** Role-category names this format suits, or ['All'] (drives per-role recommendations). */
  suitedRoleCategories?: string[];
}

/** A role category (proto ROLE_CATEGORIES). */
export interface RAMockRoleCategory {
  name: string;
  accent: string;
  roles: string[];
}

/** The mock-interview setup catalog. */
export interface RAMockCatalog {
  roleCategories: RAMockRoleCategory[];
  interviewers: RAMockInterviewer[];
  types: RAMockType[];
  /** exact summed count of all listed roles (e.g. 57) */
  totalRoles: number;
}

/** A recent session card (proto RECENT_SESSIONS). */
export interface RAMockSessionSummary {
  id: string;
  role: string;
  interviewerName: string;
  typeLabel: string;
  /** 0..100 */
  score: number;
  /** "2 days ago" */
  when: string;
  note: string;
}

/** One live transcript line. */
export interface RAMockTurn {
  who: RAMockSpeaker;
  /** MARKDOWN, rendered sanitized */
  text: string;
}

/** A coach nudge surfaced during the live session. */
export interface RAMockCoachTip {
  /** 'good' | 'careful' — drives nudge color */
  kind: 'good' | 'careful';
  text: string;
}

/** A connected service tile (Route 10 § Integrations). */
export interface RAIntegration {
  provider: RAIntegrationProvider;
  /** display name, e.g. "Google Calendar" */
  name: string;
  /** what it does, e.g. "Auto-detect responses + classify replies" */
  description: string;
  connected: boolean;
  /** connected account label, e.g. "maya@chen.io" — null when disconnected */
  account: string | null;
  /** brand color for the tile icon */
  brandColor: string;
}

/** The extended preferences blob — everything the proto's `PREFS_DEFAULTS`
 *  holds that `goal` / `RoboSettings` / the auth profile do NOT own. */
export interface RAPreferences {
  // Identity extras (name/email live on the auth profile)
  phone: string | null;
  location: string | null;
  pronouns: string | null;
  yearsExp: number;
  defaultResumeId: string | null;
  links: { linkedin: string; github: string; portfolio: string; x: string };

  // Hunt (the parts goal doesn't own)
  huntActive: boolean;
  /** free-text intent / tiebreaker */
  intentMarkdown: string;
  roleTitles: string[];
  /** remote / hybrid / onsite toggles (work mode) */
  workModes: { remote: boolean; hybrid: boolean; onsite: boolean };
  cities: string[];
  /** in thousands, e.g. 180 = $180k */
  salaryMinK: number;
  salaryMaxK: number;
  /** keyed by stage id: seed/seriesA/seriesB/seriesC/late/public */
  companyStages: Record<string, boolean>;
  /** headcount buckets, e.g. ["11–50","51–200"] */
  companySizes: string[];
  industriesTarget: string[];
  industriesAvoid: string[];
  mustHaves: string[];
  dealbreakers: string[];
  workAuth: string;

  // Agent behavior
  aggressiveness: RAAggressiveness;
  /** 60..95 */
  matchThreshold: number;
  /** 1..30 */
  dailyCap: number;
  /** 0..23 */
  quietStart: number;
  quietEnd: number;
  autoDecline: boolean;
  autoSchedule: boolean;
  pauseDuringInterviews: boolean;
  reScoreWeekly: boolean;
  /** 'silent' | 'nudges' | 'loud' */
  coachLoudness: string;

  // Notifications
  channels: { email: boolean; push: boolean; sms: boolean };
  /** 'off' | 'daily' | 'weekly' */
  digest: string;
  /** per-event × per-channel matrix; keys: newMatch90, queueReview, appSent,
   *  response, interview */
  notif: Record<string, { email: boolean; push: boolean; sms: boolean }>;

  // Privacy
  /** 'private' | 'matched' | 'public' */
  profileVisibility: string;
  blockedCompanies: string[];
  blockedRecruiters: number;
  /** '30' | '90' | '365' | 'forever' */
  dataRetention: string;

  // Plan (read-mostly; tier mirrors auth profile)
  plan: string;

  updatedAt: string;
}

/** Static option lists the preferences form needs (so the UI doesn't hardcode
 *  them). */
export interface RAPreferenceOptions {
  industries: string[];
  companyStages: Array<{ id: string; label: string; sub: string }>;
  companySizes: string[];
  seniorityLabels: string[];
}

/** A single proposed change in a resume tailor diff. */
export interface RATailorChange {
  id: string;
  /** e.g. "Summary", "Experience · Mavn", "Skills" */
  section: string;
  kind: RATailorChangeKind;
  /** one-line description of the change */
  label: string;
  /** present when kind === 'rewrite' */
  before?: string;
  after?: string;
  /** present when kind === 'add' (skills/keywords to add) */
  added?: string[];
  /** present when kind === 'reorder' | 'trim' */
  detail?: string;
}

/** The full tailor diff for a (resume, job) pair. */
export interface RATailorDiff {
  jobId: string | null;
  companyName: string;
  roleTitle: string;
  /** 0..100 */
  matchBefore: number;
  matchAfter: number;
  /** True when matchAfter is a heuristic estimate rather than a real re-score
   *  of the tailored resume. Optional for back-compat with older payloads. */
  estimated?: boolean;
  changes: RATailorChange[];
}

/** A coach tip in the resume editor. */
export interface RAResumeCoachTip {
  /** 'good' | 'careful' */
  kind: 'good' | 'careful';
  /** Stable i18n code — the editor renders `coach.tips.<code>` so the tip
   *  shows in the user's language. `text` is the English fallback for an
   *  unmapped code (or an older backend that doesn't send a code). */
  code?: string;
  /** Interpolation values for the i18n message (e.g. `{ count }`). */
  params?: Record<string, string | number>;
  text: string;
}

// ─────────────────────────────────────────────────────────────────────
// Request shapes
// ─────────────────────────────────────────────────────────────────────

export interface SearchQuery {
  q?: string;
  location?: string;
  workType?: RAWorkType;
  salaryMin?: number;
  salaryCurrency?: string;
  datePosted?: RADatePosted;
  sortBy?: RASortBy;
  employmentType?: RAEmploymentType;
}

export interface SearchRunParams extends SearchQuery {
  /** default 20, max 50 */
  limit?: number;
  /** keyset pagination */
  cursor?: string;
}

export interface GoalUpsertBody {
  /** required on first save */
  targetTitle: string;
  /** ISO YYYY-MM-DD */
  targetDate?: string;
  targetSalaryMin?: number;
  targetSalaryMax?: number;
  /** ISO 4217 currency code */
  targetSalaryCurrency?: string;
  /** 1..50 */
  weeklyApplicationGoal?: number;
  preferredLocations?: {
    countries: string[];
    cities: string[];
    remoteOk: boolean;
    hybridOk: boolean;
  };
  preferredWorkType?: RAWorkType | null;
  seniority?: RASeniority | null;
  /** ≤ 4000 chars */
  notesMarkdown?: string;
}

export interface TrackerListParams {
  /** repeatable; query-string `?status=a&status=b` */
  status?: RATrackerStatus | RATrackerStatus[];
  /** default 50, max 200 */
  limit?: number;
  offset?: number;
  sortBy?: 'updated' | 'dateApplied' | 'deadline' | 'excitement';
  sortDir?: 'asc' | 'desc';
}

export interface TrackerCreateBody {
  /** from search/job-detail */
  jobId?: string;
  /** required when `jobId` absent */
  externalSnapshot?: {
    title: string;
    companyName: string;
    location?: string;
    applyUrl: string;
  };
  /** default 'bookmarked' */
  status?: RATrackerStatus;
  /** 0..5 */
  excitementStars?: number;
  maxSalary?: number;
  maxSalaryCurrency?: string;
  notesMarkdown?: string;
  /** ISO YYYY-MM-DD */
  deadline?: string;
  followUpAt?: string;
  dateApplied?: string;
}

export type TrackerPatchBody = Partial<TrackerCreateBody>;

export interface TrackerBulkBody {
  ids: string[];
  patch: {
    status?: RATrackerStatus;
    excitementStars?: number;
    deadline?: string;
  };
}

export interface JobGetParams {
  /** request a match score against this variant */
  resumeVariantId?: string;
  /** gated to Premium+; Free returns top-3 only */
  includeKeywords?: boolean;
}

export interface JobApplyBody {
  resumeVariantId?: string;
  coverLetter?: string;
  /** default 'manual' */
  appliedVia?: 'manual' | 'extension';
}

export interface JobScoreBody {
  resumeVariantId: string;
  force?: boolean;
}

export type ResumeCreateBody =
  | { kind: 'base'; name: string; resumeMarkdown: string }
  | {
      kind: 'tailored_for_jd';
      name: string;
      basedOnVariantId: string;
      targetJobId: string;
    }
  | { kind: 'from_template'; name: string; templateKey: string };

export interface ResumePatchBody {
  name?: string;
  resumeMarkdown?: string;
}

export interface InsightsWeeklyParams {
  /** ISO date — Sunday-anchored UTC; defaults to current week. */
  weekStartUtc?: string;
}

// ── V3 request shapes ─────────────────────────────────────────────────

export interface QueueUpdateCoverBody {
  /** markdown; ≤ 6000 chars */
  coverLetterMarkdown: string;
}

export interface ActivityFeedParams {
  /** default 7 — how many days back */
  days?: number;
}

/** Start a live mock-interview session. */
export interface MockStartBody {
  role: string;
  interviewerId: string;
  typeId: string;
  format: RAMockFormat;
  /** BCP-47 interview language. Defaults server-side to the UI locale. */
  language?: string;
  /** Planned interview length in minutes. Defaults to the type's minutes. */
  durationMinutes?: number;
}

/** Advance the live session (submit an answer, get the next question). */
export interface MockNextTurnBody {
  sessionId: string;
  /** the candidate's answer to the current question (may be empty on skip) */
  answer: string;
  /** current question index */
  questionIndex: number;
}

/** Run an inline resume rewrite. */
export interface ResumeRewriteBody {
  mode: RAResumeRewriteMode; // 'bullet' | 'summary' | 'skills'
  /** the text to rewrite (bullet text, or current summary). Omitted for 'skills'. */
  text?: string;
  /** required when mode === 'bullet' */
  action?: RAResumeRewriteAction;
  /** optional job context to bias the rewrite (the resume being edited) */
  targetJobId?: string;
}

/** Request a tailor diff for a (resume, job) pair. */
export interface ResumeTailorDiffBody {
  /** pick from matches… */
  targetJobId?: string;
  /** …or paste a raw JD… */
  jdText?: string;
  /** …or name a manual target: company (drives the tailor even without a JD)
   *  plus an optional title. One of targetJobId / jdText / targetCompany is
   *  required. */
  targetCompany?: string;
  targetTitle?: string;
}

/** Partial preferences update; only changed fields are sent (mirror the SaveBar). */
export type PreferencesUpdateBody = Partial<Omit<RAPreferences, 'updatedAt'>>;

// ─────────────────────────────────────────────────────────────────────
// Onboarding Chat v4 — /api/v1/roboapply/v2/onboarding/*
// ─────────────────────────────────────────────────────────────────────
//
// Byte-identical MIRROR of `backend/src/roboapply/v2/types/onboarding.ts`
// (mirrored, not imported — workspace boundary). Drift between the two files
// is the bug; the design spec (docs/design-spec-roboapply-onboarding-chat.md
// §2/§3.2) is the arbiter. The NDJSON chat stream is consumed by
// `hooks/useOnboardingChat.ts` via raw fetch — NOT through `RaV2Api`.

/** Server-authoritative conversation state (S1–S4). */
export type RAOnboardingState =
  | 'greeting'
  | 'elicitation'
  | 'recommend'
  | 'wrap';

/** Status shimmer keys — machine keys, localized client-side via next-intl. */
export type RAOnboardingStatusKey =
  | 'searching_internal'
  | 'searching_external'
  | 'scoring';

/** One "what I picked up" row, built deterministically server-side from the
 *  parsed resume variant. `label` arrives localized (server catalog);
 *  `value` is real extracted content — there is no fake-data state. */
export interface IngestRow {
  id: string;
  kind:
    | 'identity'
    | 'experience'
    | 'skills'
    | 'education'
    | 'links'
    | 'summary'
    | 'imported';
  label: string;
  value: string;
}

/** Salary slice of the elicitation draft. */
export interface OnboardingDraftSalary {
  min?: number;
  max?: number;
  /** ISO 4217 — confirmed in conversation, never silently assumed. */
  currency?: string;
  period?: RASalaryPeriod;
}

/** Locations slice of the elicitation draft. */
export interface OnboardingDraftLocations {
  countries?: string[];
  cities?: string[];
  remoteOk?: boolean;
}

/** The conversation's working preference draft. Field names double as the
 *  `captured` / `unconfirmed` identifiers on `prefs-update` events and as
 *  the preference-tray chip keys. */
export interface OnboardingDraftPreferences {
  targetRoles?: string[];
  seniority?: string;
  workModes?: RAWorkType[];
  salary?: OnboardingDraftSalary;
  employmentTypes?: RAEmploymentType[];
  industriesTarget?: string[];
  industriesAvoid?: string[];
  companyStages?: string[];
  companySizes?: string[];
  locations?: OnboardingDraftLocations;
  mustHaves?: string[];
  dealbreakers?: string[];
}

/** A recommended job card surfaced inside the onboarding chat (≤5/round). */
export interface OnboardingJobCard {
  // RAJobListItem fields:
  id: string;
  title: string;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  workType: RAWorkType;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  postedAt: string | null;
  isBookmarked: boolean;
  matchScoreCached: number | null;
  // onboarding additions:
  /** 0–100, scorer output, floor 60. */
  matchScore: number;
  /** 1–2 sentences, in-locale, markdown-inline. Render sanitized. */
  whyMatched: string;
  source: 'internal' | 'jsearch';
  /** e.g. "LinkedIn", "104人力銀行" → rendered "via {publisher}". */
  sourcePublisher?: string;
  /** External only; open `_blank` with `rel="noopener nofollow"`. */
  applyUrl?: string;
  isExternal: boolean;
}

/** A quick-reply pill — `id` is the machine enum the server handles
 *  deterministically; `label` is the localized text shown (and echoed into
 *  the transcript as the user message). */
export interface RAOnboardingQuickReply {
  id: string;
  label: string;
}

/** The NDJSON stream union for `POST /onboarding/chat/stream` — one JSON
 *  object per line. */
export type RAOnboardingStreamEvent =
  | { type: 'session'; sessionId: string; state: RAOnboardingState }
  | { type: 'text-delta'; delta: string }
  | { type: 'status'; key: RAOnboardingStatusKey }
  | {
      type: 'prefs-update';
      draft: OnboardingDraftPreferences;
      /** Field names newly set this turn. */
      captured: string[];
      /** Fields below the confidence bar — the tray suppresses these until
       *  the assistant confirms them (a later prefs-update drops them). */
      unconfirmed: string[];
      /** Optional per-field extractor confidence (0..1). */
      fieldConfidence?: Record<string, number>;
    }
  | { type: 'chips'; chips: string[] }
  | { type: 'quick-replies'; options: RAOnboardingQuickReply[] }
  | { type: 'job-cards'; jobs: OnboardingJobCard[] }
  | { type: 'state'; state: 'elicitation' | 'recommend' | 'wrap' }
  | { type: 'done'; turnCount: number }
  | { type: 'error'; code: string; message: string; data?: unknown };

// ── Onboarding request/response DTOs ─────────────────────────────────

export interface OnboardingBootstrapBody {
  resumeVariantId: string;
}

export interface OnboardingBootstrapResponse {
  sessionId: string;
  state: RAOnboardingState;
  returning: boolean;
  resumeVariant: { id: string; name: string };
  ingestRows: IngestRow[];
  /** Localized assistant message #1 (references the resume headline). */
  greeting: string;
  /** LLM 1–2 sentence opener in the user's voice — pre-fills the composer,
   *  fully editable. */
  openingPrompt: string;
  /** 3–4 resume-grounded suggestion chips, send-on-tap. */
  chips: string[];
}

/** Body for the raw-fetch NDJSON stream (not part of `RaV2Api`). */
export interface OnboardingChatStreamBody {
  sessionId: string;
  /** The transcript text (for quick-replies: the localized label). */
  message: string;
  /** Machine id when the turn came from a quick-reply pill — the server
   *  handles it deterministically and skips the extractor. */
  quickReplyId?: string;
}

export interface OnboardingTranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface OnboardingSessionResponse {
  sessionId: string;
  state: RAOnboardingState;
  resumeVariantId: string | null;
  transcript: OnboardingTranscriptMessage[];
  draftPreferences: OnboardingDraftPreferences;
  capturedFields: string[];
  chips: string[];
  /** Present only when turnCount === 0. */
  openingPrompt?: string;
  ingestRows: IngestRow[];
  surfacedJobs: OnboardingJobCard[];
  passedJobIds: string[];
  turnCount: number;
  recommendationRounds: number;
}

export interface OnboardingCompleteBody {
  sessionId: string;
  aggressiveness: RAAggressiveness;
}

export interface OnboardingCompleteResponse {
  goal: RACareerGoal;
  preferences: RAPreferences;
}

export interface OnboardingSkipBody {
  /** Optional — skip from S0 has no session yet. */
  sessionId?: string;
}

export interface OnboardingSkipResponse {
  skipped: boolean;
}

export interface OnboardingPassBody {
  sessionId: string;
  jobId: string;
}

export interface OnboardingPassResponse {
  passed: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────────────────────────────

export interface GoalGetResponse {
  goal: RACareerGoal | null;
}

export interface GoalUpsertResponse {
  goal: RACareerGoal;
}

export interface TrackerListResponse {
  entries: RATrackerEntryView[];
  /** Every status key present even when count is 0. Drives `StatusFunnel`. */
  statusCounts: Record<RATrackerStatus, number>;
  total: number;
}

export interface TrackerGetResponse {
  entry: RATrackerEntryView;
}

export interface TrackerCreateResponse {
  entry: RATrackerEntryView;
}

export interface TrackerPatchResponse {
  entry: RATrackerEntryView;
}

export interface TrackerBulkResponse {
  updated: number;
  entries: RATrackerEntryView[];
}

export interface SearchRunResponse {
  jobs: RAJobListItem[];
  nextCursor: string | null;
  /** Returned on cold-load only (no cursor). Drives filter-chip counts. */
  facets?: {
    workType: Record<string, number>;
    locationCountry: Record<string, number>;
  };
}

export interface SearchSaveQueryResponse {
  savedSearch: RASavedSearch;
}

export interface SearchListSavedResponse {
  savedSearches: RASavedSearch[];
}

export interface JobGetResponse {
  job: RAJob;
  trackerEntry: RATrackerEntryView | null;
  matchScore: RAJobMatchScoreView | null;
  keywords: RAKeyword[] | null;
}

export interface JobApplyResponse {
  trackerEntry: RATrackerEntryView;
}

export interface JobSaveResponse {
  trackerEntry: RATrackerEntryView;
}

export interface JobScoreResponse {
  matchScore: RAJobMatchScoreView;
  cached: boolean;
}

export interface ResumeListResponse {
  resumes: RAResumeVariantSummary[];
}

export interface ResumeCreateResponse {
  resume: RAResumeVariant;
}

export interface ResumeGetResponse {
  resume: RAResumeVariant;
}

export interface ResumePatchResponse {
  resume: RAResumeVariant;
}

/** Whether this deployment offers the optional "paste a LinkedIn URL" path.
 *  PDF-export upload is always available; the URL field is only shown when the
 *  backend has a profile-enrichment provider configured. */
export interface LinkedInImportConfigResponse {
  urlImportEnabled: boolean;
}

/** Args for `resumes.importLinkedIn`. `mode: 'pdf'` carries the member's
 *  "Save to PDF" export file; `mode: 'url'` carries a public profile URL. */
export interface LinkedInImportArgs {
  mode: 'pdf' | 'url';
  /** Required when mode === 'pdf'. */
  file?: File;
  /** Required when mode === 'url'. */
  linkedinUrl?: string;
  /** Optional résumé name override. */
  name?: string;
}

export interface InsightsWeeklyResponse {
  insight: RACareerInsight | null;
  week: { startUtc: string; endUtc: string };
  nextGenerationAt: string | null;
}

export interface InsightsRefreshResponse {
  insight: RACareerInsight;
}

// ── V3 response shapes ────────────────────────────────────────────────

export interface QueueListResponse {
  items: RAQueueItem[];
  /** total pending — drives the "{n} pending review" eyebrow + nav badge */
  pendingCount: number;
}

export interface QueueItemResponse {
  item: RAQueueItem;
}

export interface ActivityFeedResponse {
  days: RAActivityDay[];
}

export interface AgentStatsResponse {
  stats: RAAgentStats;
}

export interface MockCatalogResponse {
  catalog: RAMockCatalog;
}

export interface MockRecentSessionsResponse {
  sessions: RAMockSessionSummary[];
}

export interface MockStartResponse {
  sessionId: string;
  /** the ordered question prompts + hints + coach tips for this run */
  questions: Array<{ q: string; hint: string; coachTip: RAMockCoachTip }>;
}

export interface MockNextTurnResponse {
  /** next question index, or null when the interview is over */
  nextIndex: number | null;
  /** interviewer follow-up / next prompt turns to append to the transcript */
  turns: RAMockTurn[];
  /** a live coach nudge to surface, if any */
  coachTip: RAMockCoachTip | null;
}

/** The mock-interview report envelope. Mirrors the proto's `InterviewResults`;
 *  the existing `MockReport` (lib/mockInterview/types.ts) is the richer
 *  client-side shape this wraps for the swap-path. */
export interface MockScoreResponse {
  /** 0..100 */
  overall: number;
  /** delta vs last session, e.g. +11 */
  delta: number | null;
  breakdown: Array<{ key: string; value: number; note: string }>;
  strengths: string[];
  gaps: string[];
  durationMinutes: number;
}

export interface IntegrationsListResponse {
  integrations: RAIntegration[];
}

export interface IntegrationResponse {
  integration: RAIntegration;
}

export interface PreferencesGetResponse {
  preferences: RAPreferences;
  options: RAPreferenceOptions;
}

export interface PreferencesUpdateResponse {
  preferences: RAPreferences;
}

/** Resume inline-AI rewrite result. For 'bullet': one string. For 'summary':
 *  3 labeled options. For 'skills': a string[] of suggested skills. */
export interface ResumeRewriteResponse {
  /** mode === 'bullet' */
  rewrite?: string;
  /** mode === 'summary' — 3 options with labels (Tight / Numeric / Personality) */
  options?: Array<{ label: string; text: string }>;
  /** mode === 'skills' */
  skills?: string[];
}

export interface ResumeTailorDiffResponse {
  diff: RATailorDiff;
  /** The agent's tailored markdown the diff was computed from — pass it back to
   *  tailorApply so Apply persists exactly the preview (no LLM re-run). */
  tailoredResumeMarkdown?: string;
  /** False when the tailor agent's CitationGuard could not trace every number
   *  in the draft back to the base resume — the UI shows a review warning.
   *  Optional for back-compat with older payloads (absent = no verdict). */
  citationGuardPassed?: boolean;
}

/** V3 — persist a tailor preview as a new tailored variant. */
export interface ResumeTailorApplyBody {
  tailoredResumeMarkdown: string;
  changes?: RATailorChange[];
  /** Ids of the changes the user kept. Omit (null) to accept all; a deselected
   *  reversible change (rewrite/add) is reverted before persisting. */
  acceptedChangeIds?: string[] | null;
  targetJobId?: string;
  /** Manual-target lineage (no saved job) — persisted on the variant's meta. */
  targetCompany?: string;
  targetTitle?: string;
  name?: string;
}

export interface ResumeTailorApplyResponse {
  resume: RAResumeVariant;
}

export interface ResumeCoachTipsResponse {
  tips: RAResumeCoachTip[];
}

// ─────────────────────────────────────────────────────────────────────
// The typed API surface
// ─────────────────────────────────────────────────────────────────────
//
// Both `realApi` (Wave-4 fetch-backed) and `stubApi` (Wave-2 in-memory)
// implement this. F2-F5 import via `lib/api/v2/index.ts` only.

export interface RaV2Api {
  goal: {
    get(): Promise<GoalGetResponse>;
    upsert(patch: GoalUpsertBody): Promise<GoalUpsertResponse>;
  };
  tracker: {
    list(params?: TrackerListParams): Promise<TrackerListResponse>;
    get(id: string): Promise<TrackerGetResponse>;
    create(body: TrackerCreateBody): Promise<TrackerCreateResponse>;
    patch(id: string, body: TrackerPatchBody): Promise<TrackerPatchResponse>;
    delete(id: string): Promise<void>;
    bulk(body: TrackerBulkBody): Promise<TrackerBulkResponse>;
  };
  search: {
    run(params?: SearchRunParams): Promise<SearchRunResponse>;
    saveQuery(body: {
      name: string;
      query: SearchQuery;
    }): Promise<SearchSaveQueryResponse>;
    listSaved(): Promise<SearchListSavedResponse>;
    deleteSaved(id: string): Promise<void>;
  };
  jobs: {
    get(id: string, params?: JobGetParams): Promise<JobGetResponse>;
    apply(id: string, body: JobApplyBody): Promise<JobApplyResponse>;
    save(
      id: string,
      body?: { excitementStars?: number },
    ): Promise<JobSaveResponse>;
    score(id: string, body: JobScoreBody): Promise<JobScoreResponse>;
  };
  resumes: {
    list(params?: { kind?: RAResumeKind }): Promise<ResumeListResponse>;
    create(body: ResumeCreateBody): Promise<ResumeCreateResponse>;
    /** Upload a résumé file (PDF / DOCX / TXT …). The backend extracts text,
     *  parses it, and creates a base variant; the first résumé becomes primary. */
    upload(file: File, opts?: { name?: string }): Promise<ResumeCreateResponse>;
    /** Whether the optional LinkedIn URL-import path is enabled on this
     *  deployment (PDF-export upload is always available). */
    linkedinConfig(): Promise<LinkedInImportConfigResponse>;
    /** Import a résumé from LinkedIn — a "Save to PDF" export (mode 'pdf') or a
     *  public profile URL (mode 'url', only when linkedinConfig is enabled).
     *  Creates a base variant tagged sourceKind 'linkedin'. */
    importLinkedIn(args: LinkedInImportArgs): Promise<ResumeCreateResponse>;
    /** Mark a variant as the user's primary résumé (demotes any other). */
    setPrimary(id: string): Promise<ResumeCreateResponse>;
    get(id: string): Promise<ResumeGetResponse>;
    patch(id: string, body: ResumePatchBody): Promise<ResumePatchResponse>;
    delete(id: string): Promise<void>;
    /** V3 — inline AI rewrite (bullet / summary / skills). */
    rewrite(id: string, body: ResumeRewriteBody): Promise<ResumeRewriteResponse>;
    /** V3 — propose a tailor diff for a job (does NOT create the variant). */
    tailorDiff(
      id: string,
      body: ResumeTailorDiffBody,
    ): Promise<ResumeTailorDiffResponse>;
    /** V3 — persist a tailor preview as a new tailored variant (no LLM re-run). */
    tailorApply(
      id: string,
      body: ResumeTailorApplyBody,
    ): Promise<ResumeTailorApplyResponse>;
    /** V3 — coach tips for the editor (cycling panel). */
    coachTips(id: string): Promise<ResumeCoachTipsResponse>;
  };
  insights: {
    weekly(params?: InsightsWeeklyParams): Promise<InsightsWeeklyResponse>;
    refresh(): Promise<InsightsRefreshResponse>;
  };

  // ── V3 namespaces ──────────────────────────────────────────────────

  /** Review queue — shaping layer over the V1 auto-apply engine (RoboRun). */
  queue: {
    list(): Promise<QueueListResponse>;
    /** fire now; resolves with the item flipped to 'sent'. */
    send(id: string): Promise<QueueItemResponse>;
    /** skip; resolves with the item flipped to 'skipped'. */
    skip(id: string): Promise<QueueItemResponse>;
    /** edit the draft cover. */
    updateCover(
      id: string,
      body: QueueUpdateCoverBody,
    ): Promise<QueueItemResponse>;
  };

  /** Activity log + agent stats aggregate. */
  activity: {
    feed(params?: ActivityFeedParams): Promise<ActivityFeedResponse>;
    /** the aggregate; cheap, cacheable, reused by Today + sidebar + Plan. */
    orbStats(): Promise<AgentStatsResponse>;
  };

  /** Mock interview — setup catalog + live turn loop + scored report. */
  mock: {
    catalog(): Promise<MockCatalogResponse>;
    recentSessions(): Promise<MockRecentSessionsResponse>;
    start(body: MockStartBody): Promise<MockStartResponse>;
    nextTurn(body: MockNextTurnBody): Promise<MockNextTurnResponse>;
    score(sessionId: string): Promise<MockScoreResponse>;
  };

  /** Connected services. */
  integrations: {
    list(): Promise<IntegrationsListResponse>;
    /** begin connect (stub flips connected=true immediately; real impl returns
     *  an OAuth redirect URL — out of scope now). */
    connect(provider: RAIntegrationProvider): Promise<IntegrationResponse>;
    disconnect(provider: RAIntegrationProvider): Promise<IntegrationResponse>;
  };

  /** Extended preferences (everything goal/settings/profile don't own). */
  preferences: {
    get(): Promise<PreferencesGetResponse>;
    /** partial; returns the merged result. */
    update(body: PreferencesUpdateBody): Promise<PreferencesUpdateResponse>;
  };

  /** Onboarding Chat v4 (S0 resume select → S1–S4 chat). The NDJSON chat
   *  stream is NOT here — `hooks/useOnboardingChat.ts` raw-fetches it (the
   *  same precedent as `_real.ts`'s multipart bypass). */
  onboarding: {
    bootstrap(body: OnboardingBootstrapBody): Promise<OnboardingBootstrapResponse>;
    /** Restores the active session (≤7 days old). 404 → show S0. */
    getSession(): Promise<OnboardingSessionResponse>;
    complete(body: OnboardingCompleteBody): Promise<OnboardingCompleteResponse>;
    skip(body?: OnboardingSkipBody): Promise<OnboardingSkipResponse>;
    pass(body: OnboardingPassBody): Promise<OnboardingPassResponse>;
  };
}
