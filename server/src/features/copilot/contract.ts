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

import { z } from 'zod';

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

/** `RACopilotProposal.payload` (documented JSON column). */
export const FilterChangePayloadSchema = z
  .object({
    searchProfileId: z.string(),
    baseVersion: z.number().int(),
    ops: z.array(z.object({ op: z.enum(['add', 'remove', 'set']), path: z.string(), value: z.unknown() }).strict()),
  })
  .strict();
export const CreditActionPayloadSchema = z
  .object({ action: z.enum(['tailor', 'cover_letter', 'outreach', 'job_import']), args: z.record(z.string(), z.unknown()), bucket: z.string(), cost: z.number().int().min(0) })
  .strict();
export const PROPOSAL_KINDS = ['filter_change', 'credit_action', 'memory_add'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
/** Proposals expire after 24 h. */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

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
}

/** Per-job chips (UI). */
export const COPILOT_CHIPS = ['why_fit', 'whats_missing', 'resume_tips', 'tailor', 'cover_letter', 'practice', 'similar_jobs', 'connections'] as const;

/** POST /copilot/threads/:id/messages → SSE. Credit `assistant` per user turn. */
export const SendMessageBodySchema = z
  .object({ text: z.string().trim().min(1).max(4000), chip: z.enum(COPILOT_CHIPS).optional(), contextJobId: Id.optional() })
  .strict();

export type CopilotSseEvent =
  | { event: 'meta'; data: { threadId: string; messageId: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'tool'; data: { id: string; name: string; phase: 'start' | 'end'; ok?: boolean } }
  | { event: 'card'; data: CopilotCard }
  | { event: 'error'; data: { code: string; message: string; retryable: boolean } }
  | { event: 'done'; data: { messageId: string; usage: { inputTokens: number; outputTokens: number }; creditsRemaining: number | null } };

// ── Proposals ────────────────────────────────────────────────────────────

export const ProposalParamsSchema = z.object({ id: Id });
/** `baseVersion` is checked for filter changes; a mismatch answers `version_conflict` with a fresh diff. */
export const ApplyProposalBodySchema = z.object({ baseVersion: z.number().int().min(1).optional() }).strict();
export interface ApplyProposalResponse {
  applied: boolean;
  result: unknown;
}

// ── Feedback and memory ──────────────────────────────────────────────────

export const MessageParamsSchema = z.object({ id: Id });
export const MessageFeedbackBodySchema = z.object({ value: z.enum(['up', 'down']), note: z.string().max(1000).optional() }).strict();

/** Max 50 confirmed facts; GoApply long-term memory needs the `copilot_memory` consent. */
export const COPILOT_MEMORY_MAX = 50;
export interface MemoryFactView {
  id: string;
  fact: string;
  createdAt: string;
}
export const MemoryParamsSchema = z.object({ id: Id });

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
  dailyBudget: 'copilot_budget_exhausted',
  threadNotFound: 'thread_not_found',
} as const;
