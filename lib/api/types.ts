// Shared RoboApply types. Mirrors the architecture doc (02-architecture.md).
// Backend may not have shipped every route yet — types are stable; callers
// catch `not_found` from the client and fall back gracefully.

export type RoboLocale =
  | 'en'
  | 'zh'
  | 'zh-TW'
  | 'ja'
  | 'es'
  | 'fr'
  | 'pt'
  | 'de';

export type RoboTier = 'free' | 'premium' | 'premium_plus';

export type RoboReviewMode = 'auto' | 'review_first';

export type RoboBoardAdapter = 'greenhouse' | 'lever' | 'manual_link';

export type RoboRunStatus =
  | 'queued'
  | 'previewing'
  | 'submitted'
  | 'skipped_by_user'
  | 'failed'
  | 'undone';

// ---------------------------------------------------------------------------
// Parsed intent — the structured form of the user's free-text intent
// ---------------------------------------------------------------------------

export interface RoboParsedIntent {
  roles: string[];
  seniority:
    | 'ic'
    | 'senior'
    | 'staff'
    | 'principal'
    | 'manager'
    | 'director'
    | 'vp'
    | 'cxo'
    | null;
  industries: string[];
  companyStages: Array<
    | 'pre_seed'
    | 'seed'
    | 'series_a'
    | 'series_b_to_d'
    | 'series_e_plus'
    | 'public'
  >;
  excludeCompanies: string[];
  locations: {
    countries: string[];
    cities: string[];
    remoteOk: boolean | null;
    hybridOk: boolean | null;
  };
  compensation: {
    baseFloor: number | null;
    currency: string | null;
    equityImportant: boolean;
  };
  hardExclusions: string[];
  softPreferences: string[];
  confidence: 'high' | 'medium' | 'low';
  bestEffortFields: string[];
}

// ---------------------------------------------------------------------------
// Mission
// ---------------------------------------------------------------------------

export interface RoboMission {
  id: string;
  userId: string;
  intentText: string;
  parsedIntent: RoboParsedIntent | null;
  intentVersion: number;
  tier: RoboTier;
  reviewMode: RoboReviewMode;
  dailyCap: number;
  coverLetterToneOverride?: string | null;
  enabled: boolean;
  pausedUntil: string | null;
  timezone: string;
  locale: RoboLocale;
  resumeId: string | null;
  lastDigestSentAt: string | null;
  lastSubmissionAt: string | null;
  totalSubmitted: number;
  totalSkipped: number;
  totalUndone: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Run (single application)
// ---------------------------------------------------------------------------

export interface RoboMatchExplanation {
  score: number;
  whyMatched?: string;
  strengths?: string[];
  gaps?: string[];
  techStack?: Array<{ name: string; required: boolean; userHas: boolean }>;
  claimChecker?: Array<{
    claim: string;
    evidenceLine?: string;
    passed: boolean;
  }>;
}

export interface RoboRun {
  id: string;
  missionId: string;
  jobId: string;
  jobTitle: string;
  companyName: string;
  jobLocation?: string;
  salaryRange?: string | null;
  jobPostedAt?: string | null;
  jobUrl?: string | null;

  resumeId: string;
  tailoredResumeText: string;
  originalResumeText?: string | null;

  coverLetter: string;
  coverLetterModel: string;
  coverLetterPrompt?: string | null;

  matchScore: number;
  matchExplanation: RoboMatchExplanation;
  rationaleForPick: string;

  plannedSubmitAt: string;
  actualSubmitAt: string | null;
  undoneAt: string | null;
  failedAt: string | null;
  failureReason: string | null;

  boardAdapter: RoboBoardAdapter;
  boardSubmissionId: string | null;

  status: RoboRunStatus;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Mission page-init envelope
// ---------------------------------------------------------------------------

export interface RoboMissionPageInit {
  mission: RoboMission;
  todayQueued: RoboRun[];
  yesterdaySubmitted: RoboRun[];
  weekSoFar: {
    applied: number;
    recruiterViews: number;
    interviewInvites: number;
  } | null;
  lastDigest: {
    appNarration: string;
    citedRunIds: string[];
    sentAt: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Digest stream events (SSE)
// ---------------------------------------------------------------------------

export type DigestStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'done'; citedRunIds?: string[] }
  | { type: 'error'; code: string; message: string };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface RoboSettings {
  mission: RoboMission;
  tier: RoboTier;
  dailyCap: number;
  dailyCapMax: number;
  reviewMode: RoboReviewMode;
  coverLetterToneOverride: string | null;
  boardConnections: Array<{
    adapter: RoboBoardAdapter;
    connected: boolean;
    lastVerifiedAt: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Billing tier snapshot (for the public landing page pricing strip)
// ---------------------------------------------------------------------------

export interface RoboBillingTier {
  id: RoboTier;
  displayName: string;
  priceMonthly: number;
  currency: string;
  dailyCap: number;
  highlights: string[];
  /** Indicates the user's current tier. */
  current?: boolean;
}

export interface RoboBillingPortalLink {
  url: string;
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export interface RoboCreateMissionResult {
  mission: RoboMission;
  firstSweepAt: string;
}
