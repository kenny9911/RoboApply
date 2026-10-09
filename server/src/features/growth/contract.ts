// server/src/features/growth/contract.ts
//
// First-party events, attribution, getting-started checklist, invite
// friends (ARCHITECTURE.md §2.12, §3.9; TASK_PLAN.md WP-23, WP-60). Mounts:
//   /api/v1/roboapply/invites   (seeker; capability `invites` per route)
//   /api/v1/public/events       (public/session; ≤50 events per batch, 120/min/anonId)
//   /api/v1/roboapply/growth    (seeker; checklist read + dismiss — mount requested from INT)
//
// Events stay in our DB (no third-party pixels). For EEA/UK/CH visitors on
// RoboApply nothing links to an `anonId` before the analytics consent. The
// checklist reward is deterministic (1 practice credit once), fired only by
// `markChecklistStep`.

import { z } from 'zod';

// ── Events ───────────────────────────────────────────────────────────────

/**
 * The registry lives in events.ts (names, allowed prop keys, consent rules);
 * re-exported here so the web's type-only mirror sees it.
 */
export {
  ANALYTICS_CONSENT_COOKIE,
  ANON_ID_COOKIE,
  CONSENT_REQUIRED_COUNTRIES,
  EVENT_RETENTION_DAYS,
  MAX_EVENTS_PER_BATCH,
  PRODUCT_EVENTS,
  PRODUCT_EVENT_NAMES,
} from './events.js';
export type { AnalyticsConsentChoice, EventPropValue, ProductEventName, ProductEventPropKey, ProductEventProps } from './events.js';

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
  /** Events stored. */
  accepted: number;
  /** Events dropped (name not in the registry). */
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
export function isChecklistStep(value: unknown): value is ChecklistStep {
  return typeof value === 'string' && (CHECKLIST_STEPS as readonly string[]).includes(value);
}

/** The reward for finishing every step: deterministic, granted once (no raffle). */
export const CHECKLIST_REWARD = { bucket: 'practice', credits: 1 } as const;

export interface ChecklistState {
  steps: Record<ChecklistStep, boolean>;
  /** Reward (1 practice credit) granted once all three are done. */
  rewarded: boolean;
  /** The user closed the card (it stays hidden). */
  dismissed: boolean;
}

/** GET /api/v1/roboapply/growth/checklist and POST …/checklist/dismiss → data. */
export interface ChecklistView extends ChecklistState {
  reward: { bucket: typeof CHECKLIST_REWARD.bucket; credits: number };
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
  /** The checklist store is not available on this deployment (schema request SR-23-1 not applied). */
  checklistUnavailable: 'feature_disabled',
  inviteCap: 'invite_reward_cap',
} as const;
