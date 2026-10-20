// server/src/features/admin/contract.ts
//
// Admin console additions (TASK_PLAN.md WP-74; ARCHITECTURE.md §3.9, §10.4).
// Mount: /api/v1/roboapply/admin (admin only, per-route auth) with sub-paths
//   GET  /system                      platform health (System panel)
//   GET  /system/queue                work items by status/kind (dead items first)
//   POST /system/queue/:id/retry      put a dead/failed item back in the queue
//   GET  /system/audit                admin actions, newest first (RAAdminAuditLog)
//   GET  /costs   · GET /costs.csv    cost by SKU × brand × day (UsageDeductionLog)
//   GET  /safety                      GoApply content-safety readiness + recent events
//   GET  /reports                     "Reports to review" (user job reports + intl scam signals)
//   POST /reports/:id/resolve         close or keep (restore) a reported job (RAJobReview row, audited)
//   GET/POST /overrides · DELETE /overrides/:id   per-user overrides (audited; credits area service)
//   GET  /copilot-feedback            Assistant feedback (copilot.listFeedback(), PII-redacted excerpt)
//   POST /referrals/:id/moderate      GoApply referral-code moderation (cn/referrals service, audited)
//   POST /view-as · POST /view-as/stop  read-only "view as" one user (platform/viewAs, audited)
// Area-specific admin routers are mounted at /admin/<area> by their owners
// (credits, compliance, prep, coaching, announcements, cn/jobs, cn/campus,
// cn/referrals, auth-cn, career-sources).
//
// Every number here comes from a live query at request time (no caching, no
// estimates). Unknown or not-yet-recorded values are `null` (the UI shows "—").
// Admin copy avoids the copy-gate bans ("Reports to review", "alert level").

import { z } from 'zod';

const Id = z.string().min(1).max(64);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ── Alert levels (the daily health email; ARCH §10.4 "Alerting") ─────────

/**
 * When a System metric passes its alert level, `/system` marks it and the
 * daily health email (jobs-maintain) lists it for `ADMIN_ALERT_EMAILS`.
 */
export const ALERT_LEVELS = {
  /**
   * New jobs in the day below this share of the 7-day daily average, prorated
   * by the share of the UTC day covered (live panel: the day so far; health
   * email: the whole previous day). The average must be at least `ingestMinAverage`.
   */
  ingestNewShare: 0.5,
  /** The live ingest rule stays quiet until this share of the UTC day has passed (too few ingest runs before then). */
  ingestMinDayShare: 0.25,
  /** Ignore the ingest rule while the 7-day average is below this (a brand with no inventory yet). */
  ingestMinAverage: 10,
  /** Dead work items (all kinds) above this. */
  deadItems: 100,
  /** A daily budget (provider calls, enrichment, AI scores, Assistant spend) used at or above this share (in the day covered). */
  budgetShare: 0.9,
  /** Failed emails in the 24 hours ending at the end of the range above this. */
  emailFailures: 50,
  /** Queries due for more than this many minutes count as overdue. */
  overdueMinutes: 60,
  /**
   * A metered provider is 'low' when the requests (or postings) its plan has
   * left for the period are under this share of the plan's limit, both as the
   * provider itself stated them (JI-1).
   */
  quotaLowShare: 0.1,
} as const;

export type AlertKey =
  | 'ingest_new_low'
  | 'dead_items'
  | 'provider_budget'
  | 'provider_quota'
  | 'enrich_budget'
  | 'score_budget'
  | 'assistant_budget'
  | 'email_failures';

/** The provider states that raise a `provider_quota` alert. */
export type ProviderAlertState = 'exhausted' | 'not_subscribed' | 'unauthorized' | 'low';

export interface AlertHit {
  key: AlertKey;
  /** Brand the metric belongs to; null for platform-wide metrics (queue, providers). */
  brand: string | null;
  /** Provider name for `provider_budget` and `provider_quota` (the row's `provider`, e.g. 'activejobs' or 'activejobs:cn'). */
  subject: string | null;
  /**
   * `provider_quota`: for state 'low' the requests (or postings) the plan has
   * left and the level they fell under; 0 and 0 for the other three states
   * (the state says it all, and no number is made up for it).
   */
  value: number;
  level: number;
  /** `provider_quota` only: which state raised it. Absent on every other alert. */
  state?: ProviderAlertState;
  /** `provider_quota` only: whole days until the provider's quota resets; null when the provider did not say. */
  daysToReset?: number | null;
}

// ── GET /system ──────────────────────────────────────────────────────────

/** A count against a daily limit. `limit` null = not metered. */
export interface UsageVsLimit {
  used: number;
  limit: number | null;
}

export interface QueueKindRow {
  kind: string;
  queued: number;
  leased: number;
  failed: number;
  dead: number;
  oldestQueuedAt: string | null;
}

/**
 * What the System panel says about a job provider right now (JI-1):
 *   ok              on, and its plan has quota left (or it is not metered);
 *   low             under ALERT_LEVELS.quotaLowShare of the period's requests or postings left;
 *   exhausted       the provider says the period's quota is used up (a 429, or 0 requests or postings left);
 *   not_subscribed  the key has no plan for this API;
 *   unauthorized    the provider refused the key;
 *   gated           a metered source that is off until a larger plan exists
 *                   (the licensed feed under 20,000 postings a month: MARKET_STRATEGY M-2);
 *   disabled        off for another reason (no key, a kill switch, a guard);
 *   unknown         a metered provider the snapshot says nothing current about.
 * The first of unauthorized / not_subscribed, gated, exhausted, disabled,
 * unknown, low, ok that applies (system.ts `providerState`).
 */
export const PROVIDER_STATES = ['ok', 'low', 'exhausted', 'not_subscribed', 'unauthorized', 'gated', 'disabled', 'unknown'] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];
export type ProviderMarket = 'intl' | 'cn';
export type ProviderCostModel = 'free' | 'per_job' | 'per_request';

/**
 * One job provider of one market: today's calls and yields
 * (`RAProviderUsage`) and the provider's own quota reading (the snapshot in
 * AppConfig `jobs.providerQuota.v1`, written by ingest).
 *
 * Listed for every source of every brand the deployment serves, with or
 * without a call today, and for a mainland counter the operator opened for a
 * provider no mainland brand lists as a source. Every quota field is what
 * the provider itself stated: null means "not stated" (the panel shows a
 * dash), never 0 and never a guess.
 */
export interface ProviderUsageRow {
  /**
   * The usage key (`RAProviderUsage.provider`): the provider id for the
   * international market, `<provider>:cn` for the mainland counter.
   */
  provider: string;
  /** From the usage key: a ':cn' suffix is the mainland counter. */
  market: ProviderMarket;
  calls: number;
  /**
   * Calls ingest may make to the provider in this market today: the configured
   * daily bound, cut to what is left of the plan's quota spread over the days
   * to its reset (0 when nothing is left). Null = not metered.
   */
  limit: number | null;
  jobsReturned: number;
  jobsNew: number;
  errors: number;
  /** The plan's name as the provider stated it (e.g. "BASIC"). */
  plan: string | null;
  /** Requests the plan allows in the period, and how many are left. */
  requestsLimit: number | null;
  requestsRemaining: number | null;
  /** Postings the plan allows in the period, and how many are left. */
  jobsLimit: number | null;
  jobsRemaining: number | null;
  /** When the period's quota resets (ISO 8601). */
  resetAt: string | null;
  /** Whole days until `resetAt`, rounded up. */
  daysToReset: number | null;
  /** When the quota reading was taken (ISO 8601); null = no reading. */
  observedAt: string | null;
  /** 'free' = not metered (banks, employer boards, open data): calls and yields only. */
  costModel: ProviderCostModel;
  state: ProviderState;
}

/** What one ingest run of a job source did (counters and reason codes only). */
export interface JobSourceRunView {
  /** When the run finished. */
  at: string;
  ok: boolean;
  /** The source's error in that run (a short code or message), else null. */
  error: string | null;
  /** Postings the source returned. */
  received: number;
  /** Rows written (new and refreshed). */
  written: number;
  inserted: number;
  /** Rows archived by the source's own closures. */
  closed: number;
  /** Postings dropped before the write. */
  skipped: number;
  /**
   * Skip tallies and counters by reason: bank_synced, bank_unpublished,
   * bank_no_company, bank_test_posting, bank_no_public_page, wrong_market,
   * no_apply_url, boards_read, board_errors, board_backlog …
   */
  notes: Record<string, number>;
}

/** One job source of a brand, from the job source registry (features/jobs/sources/registry.ts). */
export interface JobSourceView {
  /** 'bank_gohire' | 'bank_robohire' | 'ats_public' | 'activejobs' | 'jsearch' | 'user_import' */
  provider: string;
  kind: 'bank' | 'search' | 'ats' | 'import';
  enabled: boolean;
  /** 'db' | 'api' | 'syndication' | 'board_api' | 'rapidapi' | 'off' */
  transport: string;
  /** Why the source is off, as a short code; null when it is on. */
  reason: string | null;
  /** The latest ingest run of the source; null = it never ran. */
  lastRun: JobSourceRunView | null;
  /** The latest run that read something from the source (the run its skip tallies come from). */
  lastCounted: JobSourceRunView | null;
  /** Open public rows of the source in this brand's market (the rows the feed can list). */
  openJobs: number;
  /** Rows of the source archived because they have no page a candidate can open ('no_apply_target'). */
  heldJobs: number;
  /**
   * Recruiter banks only: whether the bank's candidate-facing posting page is
   * configured (`variable` names the setting). Without it the bank's rows are
   * synced and counted but not listed. Null for every other kind.
   */
  publicPage: { configured: boolean; variable: string } | null;
  /** Employer boards only: the brand's career sources. Null for every other kind. */
  boards: { total: number; enabled: number; failing: number } | null;
}

export interface BrandHealth {
  brand: string;
  market: string;
  /** The brand's job sources, in registry order (user_import last). */
  sources: JobSourceView[];
  ingest: {
    /** Enabled queries whose next run time has passed. */
    due: number;
    /** Of those, due for more than ALERT_LEVELS.overdueMinutes. */
    overdue: number;
    /** Enabled queries whose last run failed. */
    failing: number;
    /** Public, canonical jobs first seen in the day covered (`dayKey`; live: so far today, UTC). */
    newJobsToday: number;
    /** Daily average over the 7 full days before `dayKey`. */
    newJobs7dAvg: number;
    /** Open public jobs. */
    openJobs: number;
    /** Open public jobs not enriched yet. */
    enrichBacklog: number;
    /** Share of open public jobs that are enriched (0–1); null with no open jobs. */
    enrichedShare: number | null;
    /** Enrichment model calls today vs ENRICH_DAILY_JOBS (per market). */
    enrichBudget: UsageVsLimit;
  };
  /** AI scores today vs SCORE_DAILY_BUDGET / CN_SCORE_DAILY_BUDGET. */
  precompute: UsageVsLimit;
  /** Job-alert emails today. */
  alerts: { sent: number; failed: number };
  /** Every email template, last 24 hours. */
  email: { sent: number; failed: number; failedByTemplate: Array<{ template: string; count: number }> };
  /** Assistant, today (UTC): turns, sentences the guard removed, model cost vs the daily budget. */
  copilot: { turns: number; guardHits: number; costUsd: number; budgetUsd: number };
  /**
   * Signed-in people who saw the out-of-credits sheet in the day covered, per
   * credit bucket (distinct users with `upgrade_viewed`, from='out_of_credits').
   * null = never recorded on this brand (the event is not instrumented yet),
   * so "—" rather than 0.
   */
  creditExhaustion: Array<{ bucket: string; count: number }> | null;
}

export interface SystemStatusResponse {
  /** When the counts were read. */
  asOf: string;
  /** UTC day the day counts cover. */
  dayKey: string;
  /** false: today so far (the System panel); true: the whole of `dayKey` (the health email). */
  dayComplete: boolean;
  /** Share of the UTC day the day counts cover (0–1); the ingest alert level is prorated by it. */
  dayElapsedShare: number;
  brands: BrandHealth[];
  queue: { kinds: QueueKindRow[]; deadTotal: number };
  /**
   * Job providers, platform-wide: one row per source and market of every brand
   * this deployment serves (listed with or without a call in the day covered),
   * with the day's calls and the provider's current quota reading.
   */
  providers: ProviderUsageRow[];
  /** Metrics past their alert level for the day covered. */
  alerts: AlertHit[];
  /** Brands this deployment serves. */
  brandsServed: string[];
}

export const SystemQuerySchema = z.object({ brand: z.enum(['roboapply', 'goapply']).optional() });

// ── GET /system/queue · POST /system/queue/:id/retry ──────────────────────

export const QueueListQuerySchema = z.object({
  status: z.enum(['queued', 'leased', 'done', 'failed', 'dead']).optional(),
  kind: z.string().max(60).optional(),
  cursor: z.string().max(64).optional(),
});
export const WorkItemParamsSchema = z.object({ id: Id });

export interface WorkItemView {
  id: string;
  kind: string;
  status: string;
  brand: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  /** Last error, truncated to 300 characters (no payloads: they can carry ids only). */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkItemsResponse {
  items: WorkItemView[];
  cursor: string | null;
}
export interface RetryWorkItemResponse {
  id: string;
  status: 'queued';
}

// ── GET /costs (+ .csv) ────────────────────────────────────────────────────

export const CostsQuerySchema = z.object({
  from: Day.optional(),
  to: Day.optional(),
  brand: z.enum(['roboapply', 'goapply']).optional(),
  sku: z.string().max(80).optional(),
});

/** One SKU × brand × day row. `brand` is the row's metadata brand, else the user's brand. */
export interface CostRow {
  day: string;
  sku: string;
  brand: string;
  /** Sum of UsageDeductionLog.platformCostUsd (null rows count as 0; see `unpricedRows`). */
  costUsd: number;
  units: number;
  rows: number;
  /** Rows whose cost is not recorded (platformCostUsd null). */
  unpricedRows: number;
  /** A platform (shared) cost, not a user's own action (PLATFORM_SKUS). */
  platform: boolean;
}
export interface CostsResponse {
  from: string;
  to: string;
  rows: CostRow[];
  totals: { costUsd: number; units: number; rows: number };
}
/** Days a cost query may span (and CSV export). */
export const MAX_COST_DAYS = 92;

// ── GET /safety (GoApply content safety, WP-24) ───────────────────────────

export const SafetyQuerySchema = z.object({
  verdict: z.enum(['review', 'block', 'error']).optional(),
  cursor: z.string().max(64).optional(),
});
export interface SafetyEventView {
  id: string;
  brand: string;
  surface: string;
  direction: string;
  verdict: string;
  provider: string | null;
  reason: string | null;
  labels: string[];
  /** ≤200 characters around the hit (block/review only, as stored), PII-redacted again here. */
  excerpt: string | null;
  excerptAnchor: string | null;
  finalScan: boolean | null;
  createdAt: string;
}
export interface SafetyResponse {
  readiness: {
    provider: string;
    usable: boolean;
    cn1Ready: boolean;
    keywordList: string;
    timeoutMs: number;
    problems: string[];
    /**
     * True when a setting could not run and the check fell back to its safe
     * default (the built-in keyword list): AI stays on and `problems` says why.
     * False under CN_RESIDENCY_STRICT, where the same problem turns AI off
     * (`usable: false`). Always sent by the server; optional for older fixtures.
     */
    degraded?: boolean;
  };
  /** Verdict counts over the last 7 days. */
  last7d: Array<{ verdict: string; count: number }>;
  items: SafetyEventView[];
  cursor: string | null;
}

// ── Reports to review (F-TRUST-04; ARCH §4.9) ─────────────────────────────

/**
 * Report reasons the GoApply fraud list (/admin/fraud, WP-41) owns. A cn job
 * reported only for these is reviewed there; this list links to it.
 */
export const CN_FRAUD_REPORT_REASONS = ['scam', 'training_loan', 'pay_to_work', 'fee_required'] as const;

export const ReportsQuerySchema = z.object({
  status: z.enum(['open', 'resolved']).optional(),
  market: z.enum(['intl', 'cn']).optional(),
  cursor: z.string().max(64).optional(),
});
export const ReportParamsSchema = z.object({ id: Id });
export const RESOLVE_DECISIONS = ['close', 'restore'] as const;
export type ResolveDecision = (typeof RESOLVE_DECISIONS)[number];
export const ResolveReportBodySchema = z
  .object({ decision: z.enum(RESOLVE_DECISIONS), note: z.string().trim().max(500).optional() })
  .strict();

export interface ReportItem {
  /** The job id (one item per job). */
  id: string;
  title: string;
  companyName: string;
  market: string;
  sourceName: string | null;
  applyUrl: string | null;
  /** Open, or closed (with the close reason). */
  state: 'open' | 'closed';
  closeReason: string | null;
  closedAt: string | null;
  /** Report counts by reason (users who reported since the last decision, or all for resolved). */
  reasons: Array<{ reason: string; count: number }>;
  reportCount: number;
  firstReportedAt: string | null;
  lastReportedAt: string | null;
  /** Up to three report notes, PII-redacted, ≤200 characters each. */
  notes: string[];
  /** Rule-based intl scam signals with the posting sentence they rest on (WP-17). */
  scamSignals: Array<{ rule: string; evidence: string; at: string }>;
  /** cn jobs reported only for fraud reasons are decided on /admin/fraud. */
  reviewElsewhere: boolean;
  lastDecision: { decision: ResolveDecision; at: string; by: string; note: string | null } | null;
}
export interface ReportsResponse {
  items: ReportItem[];
  cursor: string | null;
  /**
   * True when a "Keep" decision holds: the feed's three-report rule counts
   * only reports made after the latest decision, and re-enrichment leaves the
   * cleared scam rules alone (KEEP_DECISION_HOLDS in reports.ts). False: one
   * new report can close a kept job again, and the console says so.
   */
  keepHolds: boolean;
}
export interface ResolveReportResponse {
  id: string;
  state: 'open' | 'closed';
  decision: ResolveDecision;
}

// ── Per-user overrides (RAEntitlementOverride; credits area service) ──────

// No `key` filter: the credits service pages without one, and filtering a page afterwards would skip matches on later pages.
export const AdminOverridesQuerySchema = z.object({ userId: Id.optional(), cursor: z.string().max(256).optional() });
export const AdminCreateOverrideBodySchema = z
  .object({
    userId: Id,
    key: z.string().regex(/^(bucket|entitlement|flag):[A-Za-z0-9_.]+$/),
    value: z.union([z.number().int().min(0).max(10_000), z.boolean(), z.enum(['off', 'deeplinks_only', 'on'])]),
    expiresAt: z.iso.datetime().optional(),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();
export const OverrideParamsSchema = z.object({ id: Id });
/** DELETE /overrides/:id?userId — the person the override belongs to (narrows the audit lookup). */
export const DeleteOverrideQuerySchema = z.object({ userId: Id.optional() });

export interface AdminOverrideView {
  id: string;
  userId: string;
  key: string;
  value: unknown;
  reason: string;
  adminId: string | null;
  expiresAt: string | null;
  createdAt: string;
}
export interface AdminOverridesResponse {
  items: AdminOverrideView[];
  cursor: string | null;
}

// ── Assistant feedback (copilot.listFeedback()) ───────────────────────────

export const CopilotFeedbackQuerySchema = z.object({ value: z.enum(['up', 'down']).optional(), cursor: z.string().max(64).optional() });

export interface AdminFeedbackItem {
  messageId: string;
  threadId: string;
  userId: string;
  value: 'up' | 'down';
  /** The reason the person gave, PII-redacted. */
  note: string | null;
  createdAt: string;
  /** The rated reply and up to two turns before it, PII-redacted, ≤400 characters each. */
  excerpt: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Sentences the guard removed from this reply; null when no cost row was found. */
  guardHits: number | null;
}
export interface AdminFeedbackResponse {
  items: AdminFeedbackItem[];
  cursor: string | null;
}

// ── Audit (RAAdminAuditLog; GET /system/audit) ───────────────────────────

export const AdminAuditQuerySchema = z.object({
  eventType: z.string().max(80).optional(),
  subjectUserId: Id.optional(),
  adminId: Id.optional(),
  cursor: z.string().max(120).optional(),
});

export interface AdminAuditView {
  id: string;
  /** The admin who acted (user id; no name is stored). */
  adminId: string;
  /** The person the action is about; null when it is about a job or the platform. */
  subjectUserId: string | null;
  /** ADMIN_AUDIT_EVENTS, or another area's event name. */
  eventType: string;
  /** The stored details on one line, contact details redacted, ≤400 characters. */
  details: string;
  createdAt: string;
}
export interface AdminAuditResponse {
  items: AdminAuditView[];
  cursor: string | null;
}

/**
 * RAAdminAuditLog.eventType values the admin console has a label and a filter
 * entry for. All but the last are written by this area. `inviteRewardReviewed`
 * is the name reserved for the held-invite-reward decision, which is written by
 * the growth admin router (features/growth/routes.ts, POST /:id/review) — that
 * write is a request to the growth owner (INT-01); until it lands the filter
 * entry simply finds no rows.
 */
export const ADMIN_AUDIT_EVENTS = {
  overrideCreated: 'admin_override_created',
  overrideDeleted: 'admin_override_deleted',
  reportResolved: 'admin_report_resolved',
  workItemRetried: 'admin_work_item_retried',
  referralModerated: 'admin_referral_moderated',
  inviteRewardReviewed: 'admin_invite_reward_reviewed',
  viewAsStarted: 'admin_view_as_started',
  viewAsEnded: 'admin_view_as_ended',
} as const;

// ── View as (the god's-eye view; platform/viewAs) ─────────────────────────
//
//   POST /view-as        { userId } → ViewAsStartResponse; sets the httpOnly
//                        `ra_view_as` cookie and writes admin_view_as_started.
//                        Refusals: 404 not_found; 409 conflict or 403
//                        forbidden with `details.reason` (VIEW_AS_BLOCKED_REASONS).
//   POST /view-as/stop   → ViewAsStopResponse; clears the cookie and writes
//                        admin_view_as_ended when a grant was in place.
// While the cookie holds, every request of that browser answers as the viewed
// person, read-only (403 view_as_read_only on any write), and
// `/auth/me.viewAs` (ViewAsSessionView) tells the app to show the banner.

export const ViewAsStartBodySchema = z.object({ userId: Id }).strict();

/**
 * Why an account cannot be viewed: the admin's own account, an admin account,
 * an account without a RoboApply/GoApply profile, a deleted account, an account
 * of the other brand (viewed from that brand's admin console), or a browser
 * without a session cookie to tie the grant to.
 */
export const VIEW_AS_BLOCKED_REASONS = ['self', 'admin_account', 'not_seeker', 'deleted', 'other_brand', 'needs_session'] as const;
export type ViewAsBlockedReason = (typeof VIEW_AS_BLOCKED_REASONS)[number];

export interface ViewAsPerson {
  id: string;
  email: string;
  name: string | null;
}

/** `/auth/me.viewAs`: present only while the signed-in admin views as the user `/auth/me` describes. */
export interface ViewAsSessionView {
  /** The admin at the keyboard. */
  admin: ViewAsPerson;
  startedAt: string;
  expiresAt: string;
}

export interface ViewAsStartResponse extends ViewAsSessionView {
  subject: ViewAsPerson;
  /** Where the person lands after signing in: their onboarding screen while it is unfinished, else the first-value page. */
  landing: string;
}

export interface ViewAsStopResponse {
  /** True when a grant was in place and is now ended. */
  ended: boolean;
}
