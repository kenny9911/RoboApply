// server/src/features/tracker/contract.ts
//
// Applications tracker (ARCHITECTURE.md §2.9, §3.7; TASK_PLAN.md WP-38).
//
// Two routers share the base /api/v1/roboapply/v2/tracker:
//   - the legacy roboapply/v2/routes/tracker.ts keeps GET/POST '/', POST
//     '/bulk', GET/PATCH/DELETE '/:id' and is extended additively here
//     (list: view=stage|date, q, source; PATCH: outcome, stageDetail,
//     interviewAt, offer; every change writes an RATrackerEvent);
//   - features/tracker/routes.ts adds follow-ups, export.csv, events and
//     files sent.
// The weekly card on /applications?view=date reads /v2/insights/weekly
// (ruling C40); its wire types live here too.
//
// Honesty: follow-ups are facts ("No reply for 10 days"), never predictions.
// Every count here is the user's own tracker data.

import { z } from 'zod';

const Id = z.string().min(1).max(64);
export const TrackerEntryParamsSchema = z.object({ id: Id });

// ── Statuses ─────────────────────────────────────────────────────────────

/**
 * Canonical statuses written by the clone. The RoboApply ladder follows ruling
 * C1 (Saved · Applied · First call · Interviewing · Final round · Offer ·
 * Rejected); the GoApply ladder (收藏 → 网申 → 测评 → 笔试 → AI面试 → 面试 →
 * Offer → 三方 / 未通过) lives in features/cn/tracker. `withdrawn` and `closed`
 * are the terminal states the outcome control writes ("I withdrew", "Job was
 * pulled").
 */
export const TRACKER_STATUSES = [
  'bookmarked',
  'applied',
  'first_call',
  'assessment',
  'written_test',
  'ai_interview',
  'interviewing',
  'final_round',
  'offer',
  'signed',
  'rejected',
  'withdrawn',
  'closed',
] as const;
/** Pre-clone statuses still stored on old rows; readable and writable for backward compatibility. */
export const LEGACY_TRACKER_STATUSES = ['applying', 'negotiating', 'accepted'] as const;
export const ALL_TRACKER_STATUSES = [...TRACKER_STATUSES, ...LEGACY_TRACKER_STATUSES] as const;
export type TrackerStatus = (typeof ALL_TRACKER_STATUSES)[number];

/** Statuses that end an application (the board's last column). */
export const TERMINAL_STATUSES = ['rejected', 'withdrawn', 'closed'] as const satisfies readonly TrackerStatus[];
/** Still waiting on the employer after applying (the follow-up fact applies). */
export const AWAITING_REPLY_STATUSES = ['applied', 'applying'] as const satisfies readonly TrackerStatus[];
/** A conversation with the employer is happening. */
export const INTERVIEW_STATUSES = [
  'first_call',
  'assessment',
  'written_test',
  'ai_interview',
  'interviewing',
  'final_round',
] as const satisfies readonly TrackerStatus[];
export const OFFER_STATUSES = ['offer', 'signed', 'negotiating', 'accepted'] as const satisfies readonly TrackerStatus[];

/** Who ended it (ruling C1). */
export const TRACKER_OUTCOMES = ['they_said_no', 'i_withdrew', 'job_pulled'] as const;
export type TrackerOutcome = (typeof TRACKER_OUTCOMES)[number];
/** The terminal status each outcome moves the entry to. */
export const OUTCOME_STATUS: Record<TrackerOutcome, TrackerStatus> = {
  they_said_no: 'rejected',
  i_withdrew: 'withdrawn',
  job_pulled: 'closed',
};

/** Where the entry came from (`RATrackerEntry.source`). */
export const TRACKER_SOURCES = ['feed', 'external', 'extension', 'copilot', 'agent', 'manual'] as const;
export type TrackerSource = (typeof TRACKER_SOURCES)[number];

/** How the user applied (`RATrackerEntry.appliedVia`); `ra_autoapply` only on old V1 rows. */
export const APPLIED_VIA = ['apply_click', 'agent_open', 'manual', 'extension', 'ra_autoapply'] as const;
export type AppliedVia = (typeof APPLIED_VIA)[number];

// ── Wire views ───────────────────────────────────────────────────────────

export interface TrackerJobView {
  title: string;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  workType: string;
  applyUrl: string;
  /** The posting is closed, archived or past its expiry (saved jobs group these apart). */
  closed: boolean;
}

/** `RATrackerEntry.externalSnapshot`: `{ title, companyName, location?, applyUrl }` captured at add time. */
export const TrackerExternalSnapshotSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    companyName: z.string().trim().min(1).max(200),
    location: z.string().trim().max(200).nullable().optional(),
    applyUrl: z.string().trim().max(2000).nullable().optional(),
  })
  .passthrough();
export type TrackerExternalSnapshot = z.infer<typeof TrackerExternalSnapshotSchema>;

/** `RATrackerEntry.offer` (documented JSON column; user-entered): `{ base, currency, period, bonus?, equity?, deadline?, notes? }` */
export const TrackerOfferSchema = z
  .object({
    base: z.number().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    period: z.enum(['year', 'month', 'hour']),
    bonus: z.string().max(200).optional(),
    equity: z.string().max(200).optional(),
    deadline: z.string().max(10).optional(),
    notes: z.string().max(2000).optional(),
  })
  .passthrough();
export type TrackerOffer = z.infer<typeof TrackerOfferSchema>;

/**
 * The entry as the tracker routes return it. A superset of the legacy
 * `RATrackerEntryView` (lib/api/v2/types.ts): every legacy field keeps its
 * name and shape; the clone fields are additive.
 */
export interface TrackerEntryView {
  id: string;
  userId: string;
  jobId: string | null;
  status: TrackerStatus;
  excitementStars: number;
  maxSalary: number | null;
  maxSalaryCurrency: string | null;
  notesMarkdown: string | null;
  dateSaved: string;
  dateApplied: string | null;
  /** YYYY-MM-DD */
  deadline: string | null;
  followUpAt: string | null;
  appliedVia: string | null;
  linkedRunId: string | null;
  job: TrackerJobView | null;
  externalSnapshot: TrackerExternalSnapshot | null;
  createdAt: string;
  updatedAt: string;
  // ── clone additions ──
  source: string | null;
  stageDetail: string | null;
  outcome: TrackerOutcome | null;
  interviewAt: string | null;
  offer: TrackerOffer | null;
  tailoredVariantId: string | null;
  coverLetterId: string | null;
}

export interface TrackerListResponse {
  entries: TrackerEntryView[];
  /** Every status (legacy ones included) with its count; zero only for loaded data. */
  statusCounts: Record<string, number>;
  total: number;
}

// ── Inputs ───────────────────────────────────────────────────────────────

const DateLike = z
  .string()
  .trim()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Not a date');
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Status = z.enum(ALL_TRACKER_STATUSES);

export const TrackerListQuerySchema = z.object({
  status: z.union([Status, z.array(Status)]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sortBy: z.enum(['updated', 'dateApplied', 'deadline', 'excitement']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  /** `stage` (default): most recent activity first. `date`: newest applied/saved date first. */
  view: z.enum(['stage', 'date']).optional(),
  /** Matches job title, company and notes (case-insensitive). */
  q: z.string().trim().max(120).optional(),
  source: z.enum(TRACKER_SOURCES).optional(),
});
export type TrackerListQuery = z.infer<typeof TrackerListQuerySchema>;

export const TrackerCreateBodySchema = z
  .object({
    jobId: Id.optional(),
    externalSnapshot: TrackerExternalSnapshotSchema.optional(),
    status: Status.optional(),
    excitementStars: z.number().int().min(0).max(5).optional(),
    maxSalary: z.number().int().min(0).max(100_000_000).nullable().optional(),
    maxSalaryCurrency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
    notesMarkdown: z.string().max(20_000).nullable().optional(),
    deadline: DateOnly.nullable().optional(),
    followUpAt: DateLike.nullable().optional(),
    dateApplied: DateLike.nullable().optional(),
    interviewAt: DateLike.nullable().optional(),
    stageDetail: z.string().trim().max(60).nullable().optional(),
    source: z.enum(TRACKER_SOURCES).optional(),
  })
  .refine((b) => Boolean(b.jobId) || Boolean(b.externalSnapshot), { message: 'Missing jobId or externalSnapshot', path: ['jobId'] });
export type TrackerCreateBody = z.infer<typeof TrackerCreateBodySchema>;

/** PATCH /v2/tracker/:id — legacy fields plus the clone additions. Unknown keys are dropped. */
export const TrackerPatchBodySchema = z.object({
  status: Status.optional(),
  excitementStars: z.number().int().min(0).max(5).optional(),
  maxSalary: z.number().int().min(0).max(100_000_000).nullable().optional(),
  maxSalaryCurrency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  notesMarkdown: z.string().max(20_000).nullable().optional(),
  deadline: DateOnly.nullable().optional(),
  followUpAt: DateLike.nullable().optional(),
  dateApplied: DateLike.nullable().optional(),
  outcome: z.enum(TRACKER_OUTCOMES).nullable().optional(),
  stageDetail: z.string().trim().max(60).nullable().optional(),
  interviewAt: DateLike.nullable().optional(),
  offer: TrackerOfferSchema.nullable().optional(),
});
export type TrackerPatchBody = z.infer<typeof TrackerPatchBodySchema>;

export const TrackerBulkBodySchema = z.object({
  ids: z.array(Id).min(1).max(200),
  patch: z.object({
    status: Status.optional(),
    excitementStars: z.number().int().min(0).max(5).optional(),
    deadline: DateOnly.nullable().optional(),
  }),
});
export type TrackerBulkBody = z.infer<typeof TrackerBulkBodySchema>;

// ── Events (timeline) ────────────────────────────────────────────────────

/**
 * `RATrackerEvent.kind`. `field` covers edits with no kind of their own
 * (salary, deadline, notes, dates); its payload names the field, never the
 * note text. `reminder` rows are the reminder producer's ledger (toValue = the
 * reminder key) and are hidden from the timeline.
 */
export const TRACKER_EVENT_KINDS = [
  'created',
  'status',
  'stage',
  'note',
  'interview',
  'offer',
  'outcome',
  'artifact',
  'follow_up',
  'field',
  'reminder',
] as const;
export type TrackerEventKind = (typeof TRACKER_EVENT_KINDS)[number];
export const AddTrackerNoteBodySchema = z.object({ note: z.string().trim().min(1).max(4000) }).strict();
/** `RATrackerEvent.payload` (documented JSON column). */
export const TrackerEventPayloadSchema = z.record(z.string(), z.unknown());
export interface TrackerEventView {
  id: string;
  kind: TrackerEventKind;
  fromValue: string | null;
  toValue: string | null;
  payload: Record<string, unknown> | null;
  at: string;
}

// ── Files used (artifacts) ───────────────────────────────────────────────

export interface ApplicationArtifactView {
  id: string;
  kind: 'resume' | 'cover_letter' | 'other';
  fileName: string;
  /** 'pdf' | 'docx' */
  format: string;
  sha256: string;
  /** How it left: 'download' | 'extension' | 'agent'. */
  via: string;
  variantId: string | null;
  coverLetterId: string | null;
  createdAt: string;
}

// ── Follow-ups (facts, ruling C11) ───────────────────────────────────────

/**
 * - `no_reply_10d`: applied 10+ days ago and still at Applied (no follow-up date set);
 * - `follow_up_due`: the follow-up date the user set has come;
 * - `interview_tomorrow`: an interview within the next 24 hours;
 * - `deadline_soon`: a saved job's application deadline is within 2 days
 *   (GoApply 网申截止: within 3 days).
 */
export const FOLLOW_UP_REASONS = ['no_reply_10d', 'follow_up_due', 'interview_tomorrow', 'deadline_soon'] as const;
export type FollowUpReason = (typeof FOLLOW_UP_REASONS)[number];
export interface FollowUpView {
  entryId: string;
  reason: FollowUpReason;
  /** The date the fact is about (applied date, follow-up date, interview time, deadline). */
  at: string;
  /** Whole days since applying (`no_reply_10d`) or days left (`deadline_soon`); null otherwise. */
  days: number | null;
  companyName: string | null;
  title: string | null;
}
export interface FollowUpsResponse {
  items: FollowUpView[];
}

/** Ruling C11: the one number worth interrupting someone for. */
export const NO_REPLY_DAYS = 10;

// ── Weekly card (/v2/insights, ruling C40) ───────────────────────────────

/** `RACareerInsight.metrics` (documented JSON column). */
export const CareerInsightMetricsSchema = z
  .object({
    applicationsCount: z.number().int().optional(),
    interviewsCount: z.number().int().optional(),
    offerCount: z.number().int().optional(),
    weeksToOfferEstimate: z.number().nullable().optional(),
  })
  .passthrough();

/** Counts for one week, computed from the user's own tracker rows and events. */
export interface WeeklyFacts {
  /** YYYY-MM-DD (Sunday, UTC). */
  weekStart: string;
  weekEnd: string;
  /** Applications marked applied this week. */
  applied: number;
  /** Applications that moved to an interview stage, or had an interview, this week. */
  interviews: number;
  /** Applications that reached an offer this week. */
  offers: number;
  /** Applications that ended this week (any outcome). */
  ended: number;
  /** Applications at Applied with no reply for 10+ days (right now). */
  noReply10d: number;
}

export interface WeeklyInsightView {
  id: string;
  weekStartUtc: string;
  /** Markdown; empty when no AI summary was written. */
  summaryMarkdown: string;
  citedTrackerIds: string[];
  /** True when an AI model wrote `summaryMarkdown` (label it; GoApply shows AiGeneratedBadge). */
  aiGenerated: boolean;
  modelUsed: string;
  generatedAt: string;
}

export interface WeeklyInsightResponse {
  insight: WeeklyInsightView | null;
  facts: WeeklyFacts;
  week: { startUtc: string; endUtc: string };
  /** An AI summary may be written for this user (consent and model available). */
  aiAvailable: boolean;
}

export const WeeklyInsightQuerySchema = z.object({ weekStartUtc: DateOnly.optional() });

/** CSV export: 5/day. */
export const TRACKER_EXPORT_DAILY_LIMIT = 5;
/** Reminders: in-app message `templateKey`s (full i18n key paths in the `applications` namespace). */
export const TRACKER_REMINDER_TEMPLATE_KEYS: Record<FollowUpReason, string> = {
  no_reply_10d: 'applications.reminders.no_reply',
  follow_up_due: 'applications.reminders.follow_up_due',
  interview_tomorrow: 'applications.reminders.interview_tomorrow',
  deadline_soon: 'applications.reminders.deadline_soon',
};
/** Email template the reminder producer enqueues when WP-39a has registered it. */
export const TRACKER_REMINDER_EMAIL_TEMPLATE = 'notify.tracker_reminder';

export const TRACKER_ERROR_CODES = {
  notFound: 'tracker_entry_not_found',
  duplicate: 'duplicate_tracker_entry',
  invalidStatus: 'invalid_status',
  invalidStageDetail: 'invalid_stage_detail',
} as const;
