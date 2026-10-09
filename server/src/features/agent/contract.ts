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

import { z } from 'zod';

const Id = z.string().min(1).max(64);

export const WEEKLY_TARGETS = [5, 10, 20, 30] as const;
export const MIN_TIERS = ['great', 'good', 'possible'] as const;
export const COVER_LETTER_MODES = ['when_required', 'always', 'never'] as const;
export const FILE_NAME_STYLES = ['name_company_role', 'name_role', 'company_role_name', 'name_date'] as const;
export const SETUP_STEPS = ['profile', 'calibrate', 'answers', 'weekly', 'extension', 'done'] as const;
export const QUEUE_STATES = ['picked', 'preparing', 'ready_for_review', 'approved', 'opened', 'applied', 'skipped', 'expired', 'failed'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];
export const QUEUE_ADDED_VIA = ['weekly', 'suggestions', 'feed', 'copilot', 'search', 'manual'] as const;
/** At most 50 active items. */
export const MAX_ACTIVE_QUEUE_ITEMS = 50;

/** Initial transition table (WP-52 owns it and may refine it; `submitted` never appears, D1). */
export const QUEUE_TRANSITIONS: Readonly<Record<QueueState, readonly QueueState[]>> = {
  picked: ['preparing', 'skipped', 'expired'],
  preparing: ['ready_for_review', 'failed', 'skipped'],
  ready_for_review: ['approved', 'preparing', 'skipped', 'expired'],
  approved: ['opened', 'skipped', 'expired'],
  opened: ['applied', 'approved'],
  applied: ['opened'],
  skipped: ['picked'],
  expired: [],
  failed: ['preparing', 'skipped'],
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
export const PutAgentSettingsBodySchema = AgentSettingsSchema.partial().strict();
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

/** `RAAgentSettings.calibration` (documented JSON column). */
export const CalibrationEntrySchema = z
  .object({ jobId: Id, verdict: z.enum(['up', 'down']), reason: z.string().max(80).optional(), note: z.string().max(500).optional() })
  .strict();
export const CalibrationSchema = z.array(CalibrationEntrySchema);

// ── Setup ────────────────────────────────────────────────────────────────

export interface AgentSetupResponse {
  step: (typeof SETUP_STEPS)[number];
  checks: {
    profileMissing: Array<{ key: string; label: string }>;
    /** 3 verdicts required. */
    calibrationDone: boolean;
    reportReady: boolean;
    extensionConnected: boolean;
  };
}
export const CalibrationBodySchema = CalibrationEntrySchema;

// ── Queue ────────────────────────────────────────────────────────────────

export const QueueListQuerySchema = z.object({ state: z.enum(QUEUE_STATES).optional(), weekKey: z.string().regex(/^\d{4}-W\d{2}$/).optional() });
export const AddToQueueBodySchema = z.object({ jobIds: z.array(Id).min(1).max(MAX_ACTIVE_QUEUE_ITEMS), addedVia: z.enum(QUEUE_ADDED_VIA).optional() }).strict();
export const QueueItemParamsSchema = z.object({ id: Id });

/** `RAAgentQueueItem.missingFields` (documented JSON column). */
export const MissingFieldsSchema = z.array(z.object({ key: z.string(), label: z.string() }).strict());

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
}

/** POST /agent/queue/:id/prepare → a credit proposal; the work runs on confirm. */
export const PrepareBodySchema = z.object({ confirm: z.boolean().optional() }).strict();
export interface PrepareProposal {
  credits: Array<{ bucket: 'tailor' | 'cover_letter'; cost: number }>;
  confirmed: boolean;
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
}

/** `RAAgentKitEvent.detail` (documented JSON column). */
export const KitEventDetailSchema = z
  .object({
    tailorSessionId: z.string().optional(),
    coverLetterId: z.string().optional(),
    artifactId: z.string().optional(),
    fileName: z.string().optional(),
    creditLedgerId: z.string().optional(),
  })
  .passthrough();

// ── Answer bank ──────────────────────────────────────────────────────────

export const AnswerBankItemSchema = z
  .object({
    /** Canonical key from questionKeys.ts, or 'custom:<hash>'. */
    questionKey: z.string().min(1).max(120),
    questionText: z.string().trim().min(1).max(500),
    answer: z.string().max(5000),
    locale: z.string().max(8),
  })
  .strict();
export const PutAnswersBodySchema = z.object({ answers: z.array(AnswerBankItemSchema).max(200) }).strict();
export interface AnswerBankItemView extends z.infer<typeof AnswerBankItemSchema> {
  id: string;
  source: 'user' | 'ai_confirmed';
  lastUsedAt: string | null;
  updatedAt: string;
}

export const AGENT_ERROR_CODES = {
  invalidTransition: 'queue_invalid_transition',
  queueFull: 'queue_full',
  notFound: 'queue_item_not_found',
} as const;
