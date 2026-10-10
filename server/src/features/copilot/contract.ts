// server/src/features/copilot/contract.ts
//
// The Assistant (code area `copilot`; UI name "Assistant" / 求职助手, R-10).
// ARCHITECTURE.md §3.5, §5; TASK_PLAN.md WP-50 (API), WP-51 (UI), WP-78
// (visitor turn). Mount: /api/v1/roboapply/copilot, capability `copilot` per route.
//
// Turns stream over SSE (events `meta`, `delta`, `tool`, `card`, `error`,
// `done`). Mutations are proposals the user confirms; credit actions are
// charged only when the proposal is applied. Guardrails: no submission
// claims, no number that is in neither a tool result nor the user's text
// ("No source found for that number."), card job ids only from tool results.
//
// Streaming note (WP-50): text is released sentence by sentence, each
// sentence after the guard has checked it, so nothing unchecked reaches the
// client. `done.content` repeats the final, guarded reply.

import { z } from 'zod';
import type { Sourced } from '../../platform/http.js';

const Id = z.string().min(1).max(64);

// ── Cards (ARCH §5.4). Unknown types render as nothing on the client. ────

export const CARD_TYPES = [
  'job_list',
  'filters',
  'filter_diff',
  'fit_analysis',
  'company',
  'contacts',
  'credit_action',
  'tailor_ready',
  'cover_letter',
  'interview_plan',
  'salary',
  'applications',
  'job_imported',
  'memory_add',
  'profile_gaps',
  'action',
  'notice',
  'campus_deadlines',
  'competitiveness',
  // WP-50 additions (F-RES-11 resume scope; PRODUCT §5.7 RESUME_TIPS):
  'resume_tips',
  'rewrite_ready',
] as const;
export type CardType = (typeof CARD_TYPES)[number];

export interface CardSource {
  value: unknown;
  source: string;
  sampleSize?: number;
  asOf: string;
  method?: 'stated' | 'computed' | 'ai_estimate';
  url?: string;
}

export interface CopilotCard<T = unknown> {
  type: CardType;
  id: string;
  data: T;
  sources?: CardSource[];
}

/** Stored in `RACopilotMessage.cards` (documented JSON column). */
export const CopilotCardSchema = z
  .object({
    type: z.enum(CARD_TYPES),
    id: z.string(),
    data: z.unknown(),
    sources: z.array(z.object({ value: z.unknown(), source: z.string(), sampleSize: z.number().optional(), asOf: z.string(), method: z.string().optional(), url: z.string().optional() })).optional(),
  })
  .strict();
export const CopilotCardsSchema = z.array(CopilotCardSchema);

/** `RACopilotMessage.toolCalls`: `[{ id, name, args, resultDigest, ms, ok }]` */
export const CopilotToolCallsSchema = z.array(
  z.object({ id: z.string(), name: z.string(), args: z.unknown(), resultDigest: z.string(), ms: z.number(), ok: z.boolean() }).strict(),
);

/** `RACopilotProposal.payload` (documented JSON column). `messageId` = the assistant message that carries the card. */
export const FilterChangePayloadSchema = z
  .object({
    searchProfileId: z.string(),
    baseVersion: z.number().int(),
    ops: z.array(z.object({ op: z.enum(['add', 'remove', 'set']), path: z.string(), value: z.unknown() }).strict()),
    reason: z.string().max(300).optional(),
    messageId: z.string().optional(),
  })
  .strict();
export const CREDIT_ACTIONS = ['tailor', 'cover_letter', 'outreach', 'job_import', 'rewrite'] as const;
export type CreditAction = (typeof CREDIT_ACTIONS)[number];
export const CreditActionPayloadSchema = z
  .object({
    action: z.enum(CREDIT_ACTIONS),
    args: z.record(z.string(), z.unknown()),
    bucket: z.string(),
    cost: z.number().int().min(0),
    messageId: z.string().optional(),
  })
  .strict();
export const MemoryAddPayloadSchema = z.object({ fact: z.string().min(1).max(200), messageId: z.string().optional() }).strict();
export const PROPOSAL_KINDS = ['filter_change', 'credit_action', 'memory_add'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export type ProposalStatus = 'pending' | 'applied' | 'dismissed' | 'expired' | 'conflict';
/** Proposals expire after 24 h. */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

// ── Card payloads (`card.data`) for the proposal and action cards ────────

/** One filter edit as the model proposed it (validated against the FilterSet schema before it is stored). */
export interface FilterOpWire {
  op: 'add' | 'remove' | 'set';
  path: string;
  value?: unknown;
}

/** `filter_diff`: what changes, the job counts before and after, and the proposal to apply. */
export interface FilterDiffCardData {
  proposalId: string;
  status: ProposalStatus;
  expiresAt: string;
  searchProfileId: string;
  baseVersion: number;
  reason: string | null;
  /** The proposal's ops: the client previews them against the saved search as it is now (FilterDiff). */
  ops: FilterOpWire[];
  /** One row per changed field (search.diffFilterSets). */
  changes: Array<{ field: string; kind: 'added' | 'removed' | 'changed'; addedItems?: unknown[]; removedItems?: unknown[]; from?: unknown; to?: unknown }>;
  /** Feed counts (null = not known; never 0 for unknown). `capped` = "N+". */
  countBefore: CountView | null;
  countAfter: CountView | null;
}

/** A job count on the wire (D3): `Sourced<number>` from the index; null = not known ("—"). `capped` = "N+". */
export interface CountView {
  count: Sourced<number> | null;
  capped: boolean;
}

/** `credit_action`: a paid action waiting for the user's click; shows the cost line. */
export interface CreditActionCardData {
  proposalId: string;
  status: ProposalStatus;
  expiresAt: string;
  action: CreditAction;
  jobId: string | null;
  bucket: string;
  /** Credits the action uses when applied. */
  cost: number;
  /** Credits left in the bucket's current window (window + grants); null when unknown. */
  remaining: number | null;
  resetsAt: string | null;
}

/** `memory_add`: a fact the user may confirm; GoApply needs the `copilot_memory` consent first. */
export interface MemoryAddCardData {
  proposalId: string;
  status: ProposalStatus;
  expiresAt: string;
  fact: string;
  /** True on GoApply without a live `copilot_memory` consent: ask it before applying. */
  consentRequired: boolean;
}

/** `action`: a client-side action (sort change, open a link). Nothing is applied on the server. */
export type ActionCardData =
  | { kind: 'set_sort'; sort: string }
  | { kind: 'open_link'; href: string; label: 'people' | 'resume' | 'resume_check' | 'added_jobs' | 'report' | 'practice' | 'job' };

/** `campus_deadlines` (GoApply): official 网申 windows the user follows. Dates only as the official page states them. */
export interface CampusDeadlinesCardData {
  items: Array<{
    company: string;
    programme: string | null;
    /** null = not stated on the official page. */
    closesAt: string | null;
    /** The official page (always present). */
    officialUrl: string;
    /** Where the details were read when not the official page itself; null = the official page. */
    sourceUrl: string | null;
    sourceName: string | null;
    verifiedAt: string;
    needsReverify: boolean;
  }>;
}

/** `job_imported`: the result of an applied `job_import` credit action. */
export interface JobImportedCardData {
  status: string;
  /** Set when the job is in the user's list (`status: 'done'`). */
  jobId: string | null;
  importId: string;
  /** From the import draft the user's link produced; null when the import did not read it. */
  title: string | null;
  company: string | null;
  matched: 'public' | 'yours' | null;
  reason: string | null;
  missingFields: string[];
  warnings: unknown[];
  /** The job page, or Added jobs when the user still has to finish the import. */
  href: string;
}

/**
 * `resume_tips`: issues from the latest resume check. `why`/`how` are the
 * English fallback; the client renders `resumeCheck.issue.<type>.*` with
 * `params` (components/features/resume `issueText`).
 */
export interface ResumeTipsCardData {
  resumeId: string;
  stale: boolean;
  href: string;
  issues: Array<{
    id: string;
    type: string;
    params?: Record<string, string | number>;
    source?: 'rules' | 'ai';
    severity: string;
    section: string;
    why: string;
    how: string;
    evidence: string | null;
    fixable: boolean;
  }>;
}

/** `competitiveness`: links to the report page (flag `competitiveness`). */
export interface CompetitivenessCardData {
  href: string;
  jobId: string | null;
}

// ── Threads and messages ─────────────────────────────────────────────────

export const CreateThreadBodySchema = z.object({ contextJobId: Id.optional() }).strict();
export interface ThreadView {
  id: string;
  title: string | null;
  contextJobId: string | null;
  updatedAt: string;
  createdAt: string;
}
export const ThreadParamsSchema = z.object({ id: Id });
export const MessagesQuerySchema = z.object({ before: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
export interface MessageView {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cards: CopilotCard[];
  createdAt: string;
  feedback: 'up' | 'down' | null;
  /** True for assistant replies (GoApply renders AiGeneratedBadge). */
  aiGenerated?: boolean;
}

/** Per-job chips (UI). */
export const COPILOT_CHIPS = ['why_fit', 'whats_missing', 'resume_tips', 'tailor', 'cover_letter', 'practice', 'similar_jobs', 'connections'] as const;
export type CopilotChip = (typeof COPILOT_CHIPS)[number];

/**
 * POST /copilot/threads/:id/messages → SSE. Credit `assistant` per user turn;
 * the `Idempotency-Key` header is required (one per user intent).
 * `resumeId` scopes the turn to one resume (F-RES-11, the resume page).
 */
export const SendMessageBodySchema = z
  .object({ text: z.string().trim().min(1).max(4000), chip: z.enum(COPILOT_CHIPS).optional(), contextJobId: Id.optional(), resumeId: Id.optional() })
  .strict();

export type CopilotSseEvent =
  | { event: 'meta'; data: { threadId: string; messageId: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'tool'; data: { id: string; name: string; phase: 'start' | 'end'; ok?: boolean } }
  | { event: 'card'; data: CopilotCard }
  | { event: 'error'; data: { code: string; message: string; retryable: boolean } }
  | {
      event: 'done';
      data: {
        messageId: string;
        usage: { inputTokens: number; outputTokens: number };
        creditsRemaining: number | null;
        /** The final reply after the guard (what was stored). */
        content?: string;
        /** True when the guard replaced or removed a sentence. */
        guarded?: boolean;
      };
    };

// ── Proposals ────────────────────────────────────────────────────────────

export const ProposalParamsSchema = z.object({ id: Id });
/** `baseVersion` is checked for filter changes; a mismatch answers `version_conflict` with a fresh diff. */
export const ApplyProposalBodySchema = z.object({ baseVersion: z.number().int().min(1).optional() }).strict();
export interface ApplyProposalResponse {
  applied: boolean;
  result: unknown;
}
/**
 * `result` per kind:
 *   filter_change  { searchProfileId, version, countAfter: CountView | null }
 *   credit_action  { card }  (tailor_ready | cover_letter | job_imported | rewrite_ready);
 *                  outreach: { card, draft } — `card` is an `action` link to the job's
 *                  People tab (where the draft is kept), `draft` the text to copy
 *   memory_add     { memory: MemoryFactView }
 * A filter conflict answers 409 `version_conflict` with
 * `details: { currentVersion, card }` (a fresh `filter_diff` card).
 */
export interface ApplyProposalResult {
  card?: CopilotCard;
  /** Applied `outreach` action only. */
  draft?: OutreachDraftResult;
  [key: string]: unknown;
}
/**
 * The draft an applied `outreach` action wrote (NET `OutreachDraftView`, as the
 * card shows it). The user copies it and sends it themselves: there is no send path (D1).
 */
export interface OutreachDraftResult {
  id: string;
  channel: string;
  subject: string | null;
  text: string;
  jobId: string;
  aiWritten: true;
}

// ── Feedback and memory ──────────────────────────────────────────────────

export const MessageParamsSchema = z.object({ id: Id });
export const MessageFeedbackBodySchema = z.object({ value: z.enum(['up', 'down']), note: z.string().max(1000).optional() }).strict();

/** Max 50 confirmed facts; GoApply long-term memory needs the `copilot_memory` consent. */
export const COPILOT_MEMORY_MAX = 50;
export const COPILOT_MEMORY_FACT_MAX = 200;
export interface MemoryFactView {
  id: string;
  fact: string;
  createdAt: string;
}
export const MemoryParamsSchema = z.object({ id: Id });

// ── Proactive nudge (F-ORION-08; at most one per session, client-side) ───

/**
 * GET /copilot/nudge — at most one nudge, from real signals only. The kinds
 * are the client's vocabulary (hooks/copilot/nudges.ts `NUDGE_KINDS`):
 *   low_rating       the latest feed rating (last 7 days) was below 6
 *   agency_report    the user reported a job in the last 14 days and agency posts are shown
 *   pay_filter       no minimum pay set and ≥ MIN_SAMPLE jobs in the search list pay
 *   campus_deadline  (GoApply) an official 网申 window the user follows closes within 7 days
 */
export const NUDGE_KINDS = ['low_rating', 'agency_report', 'pay_filter', 'campus_deadline'] as const;
export type NudgeKind = (typeof NUDGE_KINDS)[number];
export interface NudgeView {
  kind: NudgeKind;
  /**
   * Debug-only English text (logs, tests). The client never sends or shows it:
   * the chip label is `assistant.nudge.<kind>` and the message it puts in the
   * composer is `assistant.nudge.prompts.<kind>`, so zh and GoApply users see
   * and send text in their own language.
   */
  prompt: string;
  /** Facts behind the nudge (counts carry their source). */
  facts: Record<string, unknown>;
}
export interface NudgeResponse {
  nudge: NudgeView | null;
}

// ── Visitor turn (WP-78 calls handleVisitorTurn) ─────────────────────────

/** POST /api/v1/public/copilot body (visitor area). Page-scoped public tools only; no persistence. */
export const VisitorTurnBodySchema = z
  .object({
    text: z.string().trim().min(1).max(1000),
    pageContext: z
      .object({ path: z.string().max(512), role: z.string().max(80).optional(), city: z.string().max(80).optional(), country: z.string().max(2).optional() })
      .strict(),
  })
  .strict();
export type VisitorTurnInput = z.infer<typeof VisitorTurnBodySchema>;
export const VISITOR_TOOLS = ['search_jobs', 'salary_context', 'explain_feature'] as const;

/** Feedback rows for the admin queue (WP-74). */
export interface CopilotFeedbackRow {
  messageId: string;
  threadId: string;
  userId: string;
  value: 'up' | 'down';
  note: string | null;
  createdAt: string;
}

export const COPILOT_ERROR_CODES = {
  proposalExpired: 'proposal_expired',
  proposalClosed: 'proposal_closed',
  dailyBudget: 'copilot_budget_exhausted',
  threadNotFound: 'thread_not_found',
  messageNotFound: 'message_not_found',
  idempotencyKeyRequired: 'idempotency_key_required',
  memoryFull: 'memory_full',
  memoryConsentRequired: 'copilot_memory_consent_required',
  aiOff: 'ai_off',
} as const;

/** Tools the signed-in Assistant may offer (ARCH §5.2 + WP-50 additions). */
export const COPILOT_TOOL_NAMES = [
  'search_jobs',
  'top_fit_jobs',
  'get_current_filters',
  'propose_filter_change',
  'set_sort',
  'get_job',
  'analyze_fit',
  'company_insights',
  'find_connections',
  'draft_outreach',
  'tailor_resume',
  'write_cover_letter',
  'interview_prep',
  'salary_context',
  'application_summary',
  'add_external_job',
  'remember',
  'get_profile_gaps',
  'resume_issues',
  'rewrite_resume_section',
  'campus_deadlines',
  'competitiveness',
  'explain_feature',
] as const;
export type CopilotToolName = (typeof COPILOT_TOOL_NAMES)[number];
