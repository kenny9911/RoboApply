// server/src/features/agent/contract.ts
//
// "Ready to apply" (code area `agent`; ARCHITECTURE.md §2.10, §3.7;
// TASK_PLAN.md R-19, WP-52/53; PRODUCT_PLAN.md §5.8). Mount:
// /api/v1/roboapply/agent, capability `agent` per route.
//
// D1: the product never submits an application. Queue states:
//   picked → preparing → ready_for_review → approved → opened → applied
//   (+ skipped | expired | failed). Never `submitted`.
// `open` behaves exactly like "Apply on company site": it returns the apply
// URL, sets `opened` and moves the tracker entry to `applied` at once, with
// "Undo · I didn't apply" (`undo-applied`). `userMarkedSubmitted` is set only
// when the user says so in the extension.
//
// WP-52 additions are all optional on existing response types (the web
// fixtures `satisfies` the FND shapes), and every new route has its own schema.

import { z } from 'zod';

const Id = z.string().min(1).max(64);

export const WEEKLY_TARGETS = [5, 10, 20, 30] as const;
export const MIN_TIERS = ['great', 'good', 'possible'] as const;
export type MinTier = (typeof MIN_TIERS)[number];
export const COVER_LETTER_MODES = ['when_required', 'always', 'never'] as const;
export const FILE_NAME_STYLES = ['name_company_role', 'name_role', 'company_role_name', 'name_date'] as const;
export type FileNameStyle = (typeof FILE_NAME_STYLES)[number];
export const SETUP_STEPS = ['profile', 'calibrate', 'answers', 'weekly', 'extension', 'done'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const QUEUE_STATES = ['picked', 'preparing', 'ready_for_review', 'approved', 'opened', 'applied', 'skipped', 'expired', 'failed'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];
export const QUEUE_ADDED_VIA = ['weekly', 'suggestions', 'feed', 'copilot', 'search', 'manual'] as const;
export type QueueAddedVia = (typeof QUEUE_ADDED_VIA)[number];
/** At most 50 active items. */
export const MAX_ACTIVE_QUEUE_ITEMS = 50;
/** Calibration verdicts the setup needs ("rate 3 jobs"). */
export const CALIBRATION_REQUIRED = 3;
/** Calibration entries kept (newest win). */
export const CALIBRATION_MAX = 30;

/**
 * Transition table (WP-52; `submitted` never appears, D1).
 *   - `opened → approved` and `applied → approved` are "Undo · I didn't apply".
 *   - `approved → applied` is the user's own "I applied" when the post has no
 *     link to open; `opened → applied` is the extension's "Did you submit?" yes.
 *   - `ready_for_review|approved → preparing` is "Revise" (a new draft).
 *   - `skipped → picked` restores a skipped job; `expired` is terminal (Remove).
 */
export const QUEUE_TRANSITIONS: Readonly<Record<QueueState, readonly QueueState[]>> = {
  picked: ['preparing', 'skipped', 'expired'],
  preparing: ['ready_for_review', 'failed', 'expired'],
  ready_for_review: ['approved', 'preparing', 'skipped', 'expired'],
  approved: ['opened', 'applied', 'ready_for_review', 'preparing', 'skipped', 'expired'],
  opened: ['applied', 'approved'],
  applied: ['approved'],
  skipped: ['picked'],
  expired: [],
  failed: ['preparing', 'skipped', 'expired'],
};

/** States that count toward MAX_ACTIVE_QUEUE_ITEMS. */
export const ACTIVE_QUEUE_STATES: readonly QueueState[] = ['picked', 'preparing', 'ready_for_review', 'approved', 'failed'];
/** States a kit can be prepared from (`Prepare kits`). */
export const PREPARABLE_STATES: readonly QueueState[] = ['picked', 'failed'];
/** Kit ready and not opened yet (the nav badge and the reminder). */
export const READY_NOT_OPENED_STATES: readonly QueueState[] = ['ready_for_review', 'approved'];

/** The three tabs of /ready (PRODUCT F-AGENT-04): To prepare · Ready · Done. */
export const QUEUE_TABS = ['to_prepare', 'ready', 'done'] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];
export const TAB_STATES: Readonly<Record<QueueTab, readonly QueueState[]>> = {
  to_prepare: ['picked', 'failed'],
  ready: ['preparing', 'ready_for_review', 'approved'],
  done: ['opened', 'applied', 'skipped', 'expired'],
};

// ── Settings ─────────────────────────────────────────────────────────────

export const AgentSettingsSchema = z
  .object({
    weeklyTarget: z.union([z.literal(5), z.literal(10), z.literal(20), z.literal(30)]),
    minTier: z.enum(MIN_TIERS),
    tailorEach: z.boolean(),
    coverLetterMode: z.enum(COVER_LETTER_MODES),
    baseVariantId: Id.nullable(),
    fileNameStyle: z.enum(FILE_NAME_STYLES),
  })
  .strict();
/**
 * PUT /agent/settings. `filterOverrides: null` forgets the filter changes made
 * inside Ready to apply (the lists then use the main search as it is). Setting
 * them happens through POST /agent/list/generate `overrides` ("No, only this list").
 */
export const PutAgentSettingsBodySchema = AgentSettingsSchema.partial()
  .extend({ filterOverrides: z.null().optional() })
  .strict();
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

/**
 * Which search Ready to apply's lists come from (SCHEMA-4, SR-52-1). Every
 * list — the weekly one the cron builds and the ones built on demand — uses
 * the same pair.
 */
export interface AgentListFilters {
  /** A saved search other than the active one, or null (the user's active search). */
  searchProfileId: string | null;
  /** Filter changes made inside Ready to apply (a FilterSet patch on top of that search; a removed filter is `null`), or null. */
  overrides: Record<string, unknown> | null;
}

/** GET / PUT /agent/settings. */
export interface AgentSettingsResponse extends AgentSettings {
  listFilters?: AgentListFilters;
}

/** Defaults (PRODUCT F-AGENT-03): 10 a week, Good fit and better, tailor each, letter only when asked. */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  weeklyTarget: 10,
  minTier: 'good',
  tailorEach: true,
  coverLetterMode: 'when_required',
  baseVariantId: null,
  fileNameStyle: 'name_company_role',
};

/** `RAAgentSettings.calibration` (documented JSON column). */
export const CalibrationEntrySchema = z
  .object({ jobId: Id, verdict: z.enum(['up', 'down']), reason: z.string().max(80).optional(), note: z.string().max(500).optional() })
  .strict();
export const CalibrationSchema = z.array(CalibrationEntrySchema);
export type CalibrationEntry = z.infer<typeof CalibrationEntrySchema>;

// ── Setup ────────────────────────────────────────────────────────────────

export interface AgentSetupResponse {
  step: (typeof SETUP_STEPS)[number];
  checks: {
    /** Required application fields still empty (profile completeness; "Missing" flags). */
    profileMissing: Array<{ key: string; label: string }>;
    /** 3 verdicts required. */
    calibrationDone: boolean;
    /**
     * @deprecated Not part of this setup (there is no market-report step); always false.
     * Kept so callers built on the FND shape still compile.
     */
    reportReady: boolean;
    extensionConnected: boolean;
    /** Verdicts given so far (of CALIBRATION_REQUIRED). */
    calibrationCount?: number;
    /** Saved application answers. */
    answersCount?: number;
    /** Weekly settings saved at least once. */
    weeklySaved?: boolean;
    /** The "Get the extension" step is offered (capability `extension`). */
    extensionAvailable?: boolean;
  };
  /** ISO time setup finished, or null. */
  completedAt?: string | null;
}
export const CalibrationBodySchema = CalibrationEntrySchema;

/**
 * POST /agent/setup/step — finish or skip one wizard step. "Get the extension"
 * can always be skipped. "Check your search" can be left for later (either
 * action) only when there is nothing to rate: the jobs list is off for the
 * account, or the search has no job left to rate; otherwise it needs
 * CALIBRATION_REQUIRED ratings (409 `calibration_incomplete`).
 */
export const SetupStepBodySchema = z
  .object({ step: z.enum(['profile', 'calibrate', 'answers', 'weekly', 'extension']), action: z.enum(['complete', 'skip']).default('complete') })
  .strict();
export interface SetupStepResponse extends AgentSetupResponse {
  /** Set when this call finished setup: the first weekly list ("Done → first list generated"). */
  firstList?: GenerateListResponse | null;
}

// ── Queue ────────────────────────────────────────────────────────────────

export const QueueListQuerySchema = z.object({
  state: z.enum(QUEUE_STATES).optional(),
  weekKey: z.string().regex(/^\d{4}-W\d{2}$/).optional(),
  tab: z.enum(QUEUE_TABS).optional(),
  // ── WP-52 additions ──
  /** `nextCursor` of the previous page. */
  cursor: z.string().min(1).max(200).optional(),
  /** Page size (default and max 200). */
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
/** Sources a client may name when adding jobs; 'weekly' is set by the server only (the weekly list). */
export const CLIENT_ADDED_VIA = ['suggestions', 'feed', 'copilot', 'search', 'manual'] as const satisfies readonly QueueAddedVia[];
export const AddToQueueBodySchema = z.object({ jobIds: z.array(Id).min(1).max(MAX_ACTIVE_QUEUE_ITEMS), addedVia: z.enum(CLIENT_ADDED_VIA).optional() }).strict();
export const QueueItemParamsSchema = z.object({ id: Id });

/** `RAAgentQueueItem.missingFields` (documented JSON column). */
export const MissingFieldsSchema = z.array(z.object({ key: z.string(), label: z.string() }).strict());

/** The job a kit is for, as stored (D3: only real fields; null renders "Not listed"). */
export interface QueueJobSummary {
  title: string;
  companyName: string;
  location: string | null;
  /** False when the post has no employer link: "Open application" is unavailable, "I applied" is offered. */
  hasApplyUrl: boolean;
  /** The post was taken down or archived (the kit shows "No longer listed" with Remove). */
  closed: boolean;
  /** The post's own text asks for a cover letter (a literal phrase match, never a guess). */
  asksForCoverLetter: boolean;
  /**
   * The fit the Jobs list and the job page show for this job, read live on
   * GET /agent/queue only (never a stored copy): the stored AI score when
   * there is one (`kind: 'ai'`), else the quick estimate (`kind: 'pre'`).
   * Absent or null when it is not known (or fit is not shown to this
   * account): the row then shows none. `kind` and `confidence` are sent with
   * every fit; a reader treats a missing `kind` as a quick estimate.
   */
  fit?: { tier: 'great' | 'good' | 'possible' | 'unlikely'; score: number; kind?: 'pre' | 'ai'; confidence?: 'high' | 'medium' | 'low' } | null;
}

export interface QueueItemView {
  id: string;
  jobId: string;
  state: QueueState;
  weekKey: string;
  trackerEntryId: string | null;
  resumeVariantId: string | null;
  coverLetterId: string | null;
  missingFields: Array<{ key: string; label: string }>;
  addedVia: (typeof QUEUE_ADDED_VIA)[number];
  openedAt: string | null;
  userMarkedSubmitted: boolean;
  updatedAt: string;
  // ── WP-52 additions (optional) ──
  job?: QueueJobSummary | null;
  tailorSessionId?: string | null;
  /** Why the last preparation failed (an error code), or null. */
  lastError?: string | null;
  tab?: QueueTab;
  createdAt?: string;
}

export interface QueueListResponse {
  items: QueueItemView[];
  /** Items per tab (all weeks). */
  counts: Record<QueueTab, number>;
  /** This week in the user's time zone, e.g. '2026-W41'. */
  weekKey: string;
  // ── WP-52 additions ──
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor?: string | null;
}

/** One row of a kit's history (F-AGENT-11). */
export interface KitEventView {
  id: string;
  /** `transition` = a state change; `decision` = the user used or revised a part; `notice` = a reminder or list notice. */
  kind: 'transition' | 'decision' | 'notice';
  fromState: QueueState | null;
  toState: QueueState;
  actor: 'user' | 'system' | 'extension';
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/** GET /agent/queue/:id — the kit review screen. */
export interface QueueItemDetail {
  item: QueueItemView;
  kit: {
    resume: {
      /** The resume version to send (the tailored one, or the base resume when tailoring is off). */
      variantId: string | null;
      tailorSessionId: string | null;
      /** "Verify details" claims still open; the kit cannot be approved while > 0. */
      pendingClaims: number;
      tailored: boolean;
      used: boolean;
    };
    letter: { coverLetterId: string | null; needed: boolean; used: boolean };
    /** The user's saved answers, for the copy buttons. */
    answers: AnswerBankItemView[];
    /** Suggested file name for the resume (style from settings), without extension; null when nothing to name. */
    fileName: string | null;
    /** AI steps are available for this account (consent and a model for the brand). */
    aiAvailable: boolean;
    // ── WP-52 additions ──
    /**
     * What one "Revise" costs, shown beside the button before the user asks
     * (F-AGENT-10): a resume revision spends 1 `tailor` credit, a letter
     * revision 1 `cover_letter` credit. Null when AI is unavailable (no revise).
     */
    revisionCost?: { resume: PrepareCreditLine; letter: PrepareCreditLine } | null;
  };
  history: KitEventView[];
}

export interface KitHistoryResponse {
  items: KitEventView[];
}

/** POST /agent/queue/:id/prepare → a credit proposal; the work runs on confirm. */
export const PrepareBodySchema = z.object({ confirm: z.boolean().optional() }).strict();
/** POST /agent/queue/prepare — the same for several jobs ("Prepare kits"). */
export const PrepareBatchBodySchema = z.object({ ids: z.array(Id).min(1).max(30), confirm: z.boolean().optional() }).strict();

export interface PrepareCreditLine {
  bucket: 'tailor' | 'cover_letter' | 'ready_kits';
  cost: number;
  // ── WP-52 additions ──
  /** Credits left in the current window (plus usable grants). */
  remaining?: number;
  window?: 'day' | 'week' | 'month';
  /** ISO time the window resets. */
  resetsAt?: string;
}

export interface PrepareProposal {
  credits: PrepareCreditLine[];
  confirmed: boolean;
  // ── WP-52 additions ──
  /** Every line fits what is left ("Uses 5 tailoring credits; you have 2 left today" otherwise). */
  enough?: boolean;
  /** False: kits are prepared without AI (your resume as it is, no letter). */
  aiAvailable?: boolean;
  /** Items the proposal covers (preparable ones only). */
  itemIds?: string[];
  /** Items left out (not in a state that can be prepared). */
  notPreparable?: string[];
  /** On confirm: items now `preparing`. */
  started?: string[];
  /**
   * On confirm: the bucket whose credit ran out part-way (another request used
   * the last one meanwhile). The items in `started` were started before it; no
   * later item was. Absent when nothing ran out.
   */
  ranOut?: PrepareCreditLine['bucket'];
}

// ── Prepare my weekly list automatically (docs/agent-driven/REDESIGN.md §9) ──
//
// The user's own opt-in, off by default, is the confirmation: with it on,
// each job a weekly list build newly picks (the cron's, one built on demand,
// setup's first list) is prepared through `prepare` (the same path and
// `ready_kits` credit gate as "Prepare application"), in pick order, while
// every credit it needs fits what is left, one reservation per job keyed
// `autoprep:<itemId>:<attempt>`. Nothing is submitted (D1). Stored without a
// schema change in the user's UI state (`RAUserUiState.state.values`, keys
// `agent.autoPrepare*`; see autoPrepare.ts).

/** PUT /agent/auto-prepare. Turning it on is the user's confirmation; the web states the cost first. */
export const PutAutoPrepareBodySchema = z.object({ on: z.boolean() }).strict();

/** Why an automatic run left new jobs in "To prepare": the bucket that ran out, or `error` (anything else). */
export const AUTO_PREPARE_STOPS = ['ready_kits', 'tailor', 'cover_letter', 'error'] as const;
export type AutoPrepareStop = (typeof AUTO_PREPARE_STOPS)[number];

/** What one automatic run did, as the list build that ran it answers (POST /agent/list/generate, setup's first list). */
export interface AutoPrepareOutcome {
  /** Items the run moved to `preparing`, in pick order; each used one application from the weekly allowance. */
  started: string[];
  /** New jobs of the list the run left in "To prepare". */
  left: number;
  /** Why jobs were left; null when every new job was started. */
  stoppedBy: AutoPrepareStop | null;
}

/** The latest automatic run, as GET /agent/auto-prepare reports it (real counts of that run). */
export interface AutoPrepareRunView {
  /** ISO time of the run. */
  at: string;
  /** The week of the list it prepared, e.g. '2026-W46'. */
  weekKey: string;
  /** Applications it started; each used one from the weekly allowance. */
  started: number;
  /** New jobs it left in "To prepare". */
  left: number;
  stoppedBy: AutoPrepareStop | null;
  /** The run prepared this week's list (the user's own week, now). */
  thisWeek: boolean;
}

/** GET / PUT /agent/auto-prepare. */
export interface AutoPrepareView {
  /** The opt-in; false until the user turns it on. */
  on: boolean;
  /** ISO time it was turned on; null while it is off. */
  since: string | null;
  /** The latest automatic run, or null when none ran. Kept when the option is turned off (nothing prepared is undone). */
  lastRun: AutoPrepareRunView | null;
  /**
   * AI for this account now (consent and the brand's model), as a tapped
   * Prepare reads it: false = applications use the resume as it is, with no
   * tailoring or cover letter credit. Null when it could not be read (the
   * statement then names the credits the settings would use).
   */
  aiAvailable: boolean | null;
}

// ── The Assistant's reads (docs/agent-driven/REDESIGN.md §1, §9) ──────────
//
// The Assistant (copilot) puts a job on the list and prepares its application
// through this area's public surface (`agentService` in index.ts), never its
// tables. These two reads are what its tools see before the user confirms
// anything; the writes are `addToQueue` and `prepare` themselves.

/** One job's place on the user's list, as the Assistant reads it (`agentService.jobPlaces`). */
export interface JobPlaceView {
  jobId: string;
  /**
   * The job as the list shows it; null when it cannot go on this user's list
   * (not found for them, another market, or no link to open on this brand).
   */
  job: QueueJobSummary | null;
  /** The job's list item; null when the job is not on the list. */
  item: QueueItemView | null;
}

export interface JobPlacesResponse {
  items: JobPlaceView[];
  /** The list holds MAX_ACTIVE_QUEUE_ITEMS active jobs: another one cannot be added now. */
  listFull: boolean;
}

/** What preparing one job's application uses, before anything is spent (`agentService.quoteJob`). */
export interface JobPrepareQuote extends JobPlaceView {
  listFull: boolean;
  /** The weekly setting "tailor each application" (with AI on and this off, the resume is used as it is). */
  tailorEach: boolean;
  /**
   * The cost: the lines POST /agent/queue/:id/prepare answers without
   * `confirm` for the job's item, or for the job as `addToQueue` would put it
   * on the list (one kit, tailoring and a letter as the settings and the post
   * ask). Null when the job cannot be prepared from here: not on this user's
   * list (`job` null), closed, or past "To prepare" (it is not prepared twice).
   */
  proposal: PrepareProposal | null;
}

export const ConfirmPartBodySchema = z
  .object({ part: z.enum(['resume', 'letter']), decision: z.enum(['use', 'revise']), instruction: z.string().max(1000).optional() })
  .strict();

/** POST /agent/queue/:id/open */
export interface OpenApplicationResponse {
  applyUrl: string | null;
  handoff: { jobId: string; variantId: string | null; coverLetterId: string | null };
  /** The tracker entry moved to `applied` (undo with POST /agent/queue/:id/undo-applied). */
  trackerEntryId: string;
  // ── WP-52 additions ──
  /** True when nothing moved (already Applied or later): offer no Undo. */
  alreadyApplied?: boolean;
  atsType?: string | null;
  extensionSupported?: boolean;
  item?: QueueItemView;
}

/** `RAAgentKitEvent.detail` (documented JSON column). */
export const KitEventDetailSchema = z
  .object({
    tailorSessionId: z.string().optional(),
    coverLetterId: z.string().optional(),
    artifactId: z.string().optional(),
    fileName: z.string().optional(),
    creditLedgerId: z.string().optional(),
    // `artifactId` / `fileName` on the move to `opened`: the resume file recorded on the application (WP-93).
    // ── WP-52 ──
    /** A decision row: the user used or revised a part. */
    part: z.enum(['resume', 'letter']).optional(),
    decision: z.enum(['use', 'revise']).optional(),
    /** A notice row: 'kit_not_opened' | 'ready_list_ready'; `sent` false = recorded without sending. */
    notice: z.string().optional(),
    sent: z.boolean().optional(),
    weekKey: z.string().optional(),
    /** Preparation attempt number (1-based). */
    attempt: z.number().optional(),
    /** The tracker move this transition made (for an exact undo). */
    via: z.string().optional(),
    applyMark: z.object({ entryId: z.string(), changed: z.boolean(), eventId: z.string().nullable() }).optional(),
    alreadyApplied: z.boolean().optional(),
    error: z.string().optional(),
    /** The move into `preparing` came from "Prepare my weekly list automatically" (the user's opt-in), not a tap. */
    auto: z.boolean().optional(),
  })
  .passthrough();
export type KitEventDetail = z.infer<typeof KitEventDetailSchema>;

// ── Weekly list, suggestions, search (F-AGENT-04, F-FILT-07) ─────────────

export const SuggestionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional(),
  /** Comma-separated job ids to leave out ("Show 3 more"). */
  exclude: z.string().max(2000).optional(),
});

/** POST /agent/list/generate — build this week's list now (or add more). */
export const GenerateListBodySchema = z
  .object({
    /**
     * Filter changes made inside Ready to apply (a FilterSet patch over the main
     * search: changed fields only, a removed filter as `null`). They are kept
     * (`RAAgentSettings.filterOverrides`) and used for
     * every later list, the weekly one included, until the user removes them
     * (PUT /agent/settings `filterOverrides: null`). Left out: the kept ones apply.
     */
    overrides: z.record(z.string(), z.unknown()).optional(),
    /** Add another `weeklyTarget` jobs even when this week's list is full. */
    more: z.boolean().optional(),
  })
  .strict();
export interface GenerateListResponse {
  weekKey: string;
  added: number;
  items: QueueItemView[];
  /** The list used filters that differ from the main search: ask "Use this for your main search too?" (F-FILT-07). */
  filtersDiffer: boolean;
  /** Why nothing (or less than the target) was added. */
  reason: 'no_feed' | 'no_matches' | 'queue_full' | 'target_reached' | null;
  /**
   * "Prepare my weekly list automatically" ran on the jobs this build added
   * (the option is on and jobs were added). Absent otherwise.
   */
  autoPrepared?: AutoPrepareOutcome;
}

/** POST /agent/search/save-to-main — "Use this for your main search too?" → yes. */
export const SaveToMainBodySchema = z.object({ filters: z.record(z.string(), z.unknown()), version: z.number().int().min(1) }).strict();

/** GET /agent/badge */
export interface ReadyBadgeResponse {
  /** Kits prepared and not opened yet. */
  readyNotOpened: number;
}

// ── Answer bank ──────────────────────────────────────────────────────────

export const AnswerBankItemSchema = z
  .object({
    /** Canonical key from questionKeys.ts, or 'custom:<hash>'. */
    questionKey: z.string().min(1).max(120),
    questionText: z.string().trim().min(1).max(500),
    /** An empty (or blank) answer deletes the saved answer for this key. */
    answer: z.string().max(5000),
    locale: z.string().max(8),
  })
  .strict();
export const PutAnswersBodySchema = z.object({ answers: z.array(AnswerBankItemSchema).max(200) }).strict();
export const AnswerKeyParamsSchema = z.object({ key: z.string().min(1).max(120) });
export interface AnswerBankItemView extends z.infer<typeof AnswerBankItemSchema> {
  id: string;
  source: 'user' | 'ai_confirmed';
  lastUsedAt: string | null;
  updatedAt: string;
}

/** GET /agent/answers/questions — the common questions for this brand. */
export interface QuestionKeyView {
  key: string;
  /** i18n key of the question label (`ready.questions.<key>`, WP-53's namespace). */
  labelKey: string;
  /** Default question text in the brand's languages (stored with the answer). */
  text: Record<string, string>;
  /** Optional on the form (e.g. 家庭成员, 政治面貌). */
  optional: boolean;
  /** Never used by AI; filled only from this answer or by the user (extension rule). */
  sensitive: boolean;
  /** Matches an extension protected question type: AI never answers it. */
  protectedType: string | null;
  /** Accepts `<key>:<ISO currency>` variants (salary expectation per currency). */
  perCurrency: boolean;
}

export const AGENT_ERROR_CODES = {
  invalidTransition: 'queue_invalid_transition',
  queueFull: 'queue_full',
  notFound: 'queue_item_not_found',
  // ── WP-52 ──
  unverifiedClaims: 'kit_unverified_claims',
  notReady: 'kit_not_ready',
  calibrationIncomplete: 'calibration_incomplete',
  jobNotFound: 'job_not_found',
  invalidQuestionKey: 'invalid_question_key',
  noResume: 'no_resume',
  stepNotSkippable: 'setup_step_not_skippable',
  /** A setup step after the current one (steps are finished in order). */
  stepOutOfOrder: 'setup_step_out_of_order',
  busy: 'kit_preparing',
  /** "Undo · I didn't apply" could not revert the tracker move (too old, or moved since): the kit stays as it is. */
  undoExpired: 'kit_undo_expired',
} as const;

/** `lastError` codes the server writes on a kit (besides failureCode() of a step). */
export const KIT_ERROR_CODES = {
  /** The preparation job could not be queued. */
  enqueueFailed: 'enqueue_failed',
  /** The preparation stopped on an unexpected error after its last attempt. */
  internal: 'internal',
  /** The preparation never finished (swept after PREPARE_STALE_AFTER_MS). */
  timeout: 'prepare_timeout',
  /** The post closed before the kit was prepared. */
  jobClosed: 'job_closed',
} as const;
