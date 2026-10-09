// server/src/features/growth/contract.ts
//
// First-party events, attribution, getting-started checklist, invite
// friends (ARCHITECTURE.md §2.12, §3.9; TASK_PLAN.md WP-23, WP-60). Mounts:
//   /api/v1/roboapply/invites   (seeker; capability `invites` per route)
//   /api/v1/public/events       (public/session; ≤50 events per batch, 120/min/anonId)
//
// Events stay in our DB (no third-party pixels). For EEA/UK/CH visitors on
// RoboApply nothing links to an `anonId` before the analytics consent. The
// checklist reward is deterministic (1 practice credit once), fired only by
// `markChecklistStep`.

import { z } from 'zod';

// ── Events ───────────────────────────────────────────────────────────────

/** Initial registry; WP-23 owns `events.ts` and extends it (names are validated against it). */
export const PRODUCT_EVENT_NAMES = [
  'page_viewed',
  'onboarding_step_viewed',
  'onboarding_step_completed',
  'onboarding_abandoned',
  'feed_card_impression',
  'feed_rating_submitted',
  'job_saved',
  'apply_clicked',
  'tailor_started',
  'tailor_finalized',
  'practice_started',
  'practice_completed',
  'assistant_opened',
  'extension_installed',
  'upgrade_viewed',
  'checkout_started',
] as const;

export const ProductEventSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
    props: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional(),
    path: z.string().max(512).optional(),
    at: z.iso.datetime(),
  })
  .strict();
export const EventsBatchBodySchema = z
  .object({
    /** Absent before analytics consent (EEA/UK/CH): session-only events, not linked. */
    anonId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
    sessionId: z.string().max(64).optional(),
    events: z.array(ProductEventSchema).min(1).max(50),
  })
  .strict();
export interface EventsBatchResponse {
  accepted: number;
  rejected: number;
}

// ── Attribution (RAAttribution.firstTouch / lastTouch, documented JSON) ──

export const TouchSchema = z
  .object({
    from: z.string().max(80).optional(),
    utmSource: z.string().max(120).optional(),
    utmMedium: z.string().max(120).optional(),
    utmCampaign: z.string().max(120).optional(),
    ref: z.string().max(64).optional(),
    inviteCode: z.string().max(64).optional(),
    landingPath: z.string().max(512).optional(),
    jobId: z.string().max(64).optional(),
    action: z.string().max(40).optional(),
    alert: z.string().max(200).optional(),
    at: z.string(),
  })
  .strict();
export type Touch = z.infer<typeof TouchSchema>;

// ── Getting-started checklist ────────────────────────────────────────────

export const CHECKLIST_STEPS = ['tailor', 'practice', 'save_job'] as const;
export type ChecklistStep = (typeof CHECKLIST_STEPS)[number];
export interface ChecklistState {
  steps: Record<ChecklistStep, boolean>;
  /** Reward (1 practice credit) granted once all three are done. */
  rewarded: boolean;
}

// ── Invite friends (/invites, flag `invites`; WP-60) ─────────────────────

export interface InvitesResponse {
  code: string;
  link: string;
  invites: Array<{ status: 'signed_up' | 'qualified' | 'rewarded' | 'held'; at: string }>;
  rewards: { granted: number; capPerYear: number };
}
export const INVITE_REWARD_CAP_PER_YEAR = 10;
export const InviteEmailBodySchema = z.object({ emails: z.array(z.string().trim().toLowerCase().email()).min(1).max(10) }).strict();

export const GROWTH_ERROR_CODES = {
  unknownEvent: 'unknown_event',
  inviteCap: 'invite_reward_cap',
} as const;
