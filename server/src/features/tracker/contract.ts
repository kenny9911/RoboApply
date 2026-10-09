// server/src/features/tracker/contract.ts
//
// NEW tracker paths under /v2/tracker (ARCHITECTURE.md §2.9, §3.7;
// TASK_PLAN.md WP-38). The legacy roboapply/v2/routes/tracker.ts keeps
// GET/POST '/', POST '/bulk', GET/PATCH/DELETE '/:id' (WP-38 extends them
// additively: view=stage|date, q, source; PATCH outcome/stageDetail/
// interviewAt/offer writing an RATrackerEvent per change).
//
// Follow-ups are facts ("No reply for 10 days"), never predictions.

import { z } from 'zod';

const Id = z.string().min(1).max(64);
export const TrackerEntryParamsSchema = z.object({ id: Id });

/** Canonical statuses incl. GoApply stage codes (cn ladder 收藏 → 网申 → 测评 → 笔试 → AI面试 → 面试 → Offer → 三方 / 未通过). */
export const TRACKER_STATUSES = [
  'bookmarked',
  'applied',
  'assessment',
  'written_test',
  'ai_interview',
  'interviewing',
  'offer',
  'signed',
  'rejected',
  'withdrawn',
  'closed',
] as const;
export const TRACKER_OUTCOMES = ['they_said_no', 'i_withdrew', 'job_pulled'] as const;

// ── Additive fields WP-38 accepts on the legacy GET/PATCH ────────────────

export const TrackerListQueryAdditionsSchema = z.object({
  view: z.enum(['stage', 'date']).optional(),
  q: z.string().trim().max(120).optional(),
  source: z.string().max(40).optional(),
});

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

export const TrackerPatchAdditionsSchema = z.object({
  outcome: z.enum(TRACKER_OUTCOMES).nullable().optional(),
  stageDetail: z.string().max(120).nullable().optional(),
  interviewAt: z.iso.datetime().nullable().optional(),
  followUpAt: z.iso.datetime().nullable().optional(),
  offer: TrackerOfferSchema.nullable().optional(),
});

/** `RATrackerEntry.externalSnapshot`: `{ title, companyName, location?, applyUrl }` captured at add time. */
export const TrackerExternalSnapshotSchema = z
  .object({ title: z.string(), companyName: z.string(), location: z.string().nullable().optional(), applyUrl: z.string().nullable() })
  .passthrough();

// ── Events (timeline) ────────────────────────────────────────────────────

export const TRACKER_EVENT_KINDS = ['status', 'note', 'interview', 'offer', 'outcome', 'artifact', 'follow_up', 'created'] as const;
export const AddTrackerNoteBodySchema = z.object({ note: z.string().trim().min(1).max(4000) }).strict();
/** `RATrackerEvent.payload` (documented JSON column). */
export const TrackerEventPayloadSchema = z.record(z.string(), z.unknown());
export interface TrackerEventView {
  id: string;
  kind: (typeof TRACKER_EVENT_KINDS)[number];
  fromValue: string | null;
  toValue: string | null;
  payload: Record<string, unknown> | null;
  at: string;
}

// ── Files sent (artifacts) ───────────────────────────────────────────────

export interface ApplicationArtifactView {
  id: string;
  kind: 'resume' | 'cover_letter' | 'other';
  fileName: string;
  sha256: string;
  /** How it left: download, extension upload, email … */
  via: string;
  createdAt: string;
}

// ── Follow-ups (facts, ruling C11) ───────────────────────────────────────

export const FOLLOW_UP_REASONS = ['no_reply_10d', 'interview_tomorrow', 'deadline_soon'] as const;
export interface FollowUpView {
  entryId: string;
  reason: (typeof FOLLOW_UP_REASONS)[number];
  at: string;
}

// ── RACareerInsight.metrics (documented JSON column) ─────────────────────

export const CareerInsightMetricsSchema = z
  .object({
    applicationsCount: z.number().int().optional(),
    interviewsCount: z.number().int().optional(),
    offerCount: z.number().int().optional(),
    weeksToOfferEstimate: z.number().optional(),
  })
  .passthrough();

/** CSV export: 5/day. */
export const TRACKER_EXPORT_DAILY_LIMIT = 5;

export const TRACKER_ERROR_CODES = {
  notFound: 'tracker_entry_not_found',
} as const;
