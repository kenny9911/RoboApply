// server/src/features/growth/contract.ts
//
// First-party events, attribution, getting-started checklist, invite
// friends (ARCHITECTURE.md §2.12, §3.9; TASK_PLAN.md WP-23, WP-60). Mounts:
//   /api/v1/roboapply/invites   (seeker; capability `invites` per route; WP-60)
//   /api/v1/public/events       (public/session; ≤50 events per batch, 120/min/anonId)
//   /api/v1/roboapply/growth    (seeker; checklist read + dismiss)
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
//
// F-GROW-01 (ADAPT): a personal link `/r/<code>`; when the friend creates a
// new account, verifies it (email, Google/LINE/WeChat sign-in or a phone
// number) and finishes setup, both people get 1 practice interview credit.
// The inviter's rewards are capped at 10 per calendar year (UTC); the friend
// still gets theirs when the inviter is over the cap. Rewards are credits,
// never cash, and nothing is asked in return (no posts, no reviews: F-GROW-02
// is SKIP). Rewards whose risk score reaches REFERRAL_HOLD_SCORE are held for
// a person to review. Separate from GoApply's 内推码 hub (`cn.referralCodes`).

/** The reward each side gets: deterministic, the same on both brands. */
export const REFERRAL_REWARD = { bucket: 'practice', credits: 1 } as const;
/** Inviter rewards per calendar year (UTC). */
export const INVITE_REWARD_CAP_PER_YEAR = 10;
/** Risk score at which a qualified referral is held for review (referralRisk.ts). */
export const REFERRAL_HOLD_SCORE = 50;

/**
 * Brands where every sign-up path hands the invite code to
 * growth.recordAttribution, so a friend who signs up can actually be
 * rewarded. GoApply's phone and WeChat sign-ups (features/auth-cn) do not
 * pass `ref` yet (request R-60-3), so on GoApply the invite programme stays
 * hidden (`eligibility: 'not_available'`, plain /r/<code> landing) and no
 * invite is attached, even with the `invites` capability on. INT adds
 * 'goapply' here, and in the web twin `INVITE_REWARD_BRANDS`
 * (hooks/growth/useInvites.ts; a test keeps the two equal), once that wiring lands.
 */
export const INVITE_SIGNUP_WIRED_BRANDS: readonly string[] = ['roboapply'];
export function inviteSignupWired(brand: string): boolean {
  return INVITE_SIGNUP_WIRED_BRANDS.includes(brand);
}

/** 8 characters of Crockford base32 (no I, L, O, U). */
export const REFERRAL_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * RAReferral.status (stored):
 *   pending   the friend signed up; not verified or not set up yet
 *   held      qualified, but the risk check holds the rewards for review
 *   rewarded  both credits granted
 *   qualified the friend's credit granted; the inviter was over the yearly cap
 *   rejected  not counted (self-invite, same person, or rejected on review)
 */
export const REFERRAL_STATUSES = ['pending', 'held', 'rewarded', 'qualified', 'rejected'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/** What the inviter sees per friend (no names, no contact details). */
export const INVITE_VIEW_STATUSES = ['signed_up', 'checking', 'rewarded', 'over_limit', 'not_counted'] as const;
export type InviteViewStatus = (typeof INVITE_VIEW_STATUSES)[number];

export const INVITE_VIEW_STATUS: Record<ReferralStatus, InviteViewStatus> = {
  pending: 'signed_up',
  held: 'checking',
  rewarded: 'rewarded',
  qualified: 'over_limit',
  rejected: 'not_counted',
};

/** GET /api/v1/roboapply/invites → data. */
export interface InvitesResponse {
  /**
   * 'verify_account': the link appears once the inviter's own account is verified.
   * 'not_available': this brand cannot attach invites at every sign-up yet
   * (INVITE_SIGNUP_WIRED_BRANDS): show no link and promise no reward.
   */
  eligibility: 'ok' | 'verify_account' | 'not_available';
  /** Null until eligible. */
  code: string | null;
  /** `/r/<code>` (the web builds the absolute link from its own origin). */
  path: string | null;
  /** Absolute link on the brand's canonical origin. */
  link: string | null;
  reward: { bucket: typeof REFERRAL_REWARD.bucket; credits: number };
  /** Friends who signed up with the link, newest first. `at` = when they signed up. */
  invites: Array<{ status: InviteViewStatus; at: string }>;
  rewards: {
    /** Inviter rewards granted this calendar year (UTC). */
    granted: number;
    capPerYear: number;
    year: number;
  };
}

export const INVITE_SHARE_CHANNELS = ['copy', 'share', 'email', 'wechat'] as const;
export type InviteShareChannel = (typeof INVITE_SHARE_CHANNELS)[number];

/** POST /api/v1/roboapply/invites/shared — the inviter copied or shared the link. */
export const InviteSharedBodySchema = z.object({ channel: z.enum(INVITE_SHARE_CHANNELS) }).strict();
export interface InviteSharedResponse {
  ok: true;
}

// Admin review (createInvitesAdminRouter; mounted at
// /api/v1/roboapply/admin/growth/referrals, id growth.referrals.admin).

export interface HeldReferralView {
  id: string;
  brand: string;
  inviterUserId: string;
  inviteeUserId: string;
  riskScore: number;
  riskReasons: string[];
  signedUpAt: string;
  qualifiedAt: string | null;
}
export interface HeldReferralsResponse {
  items: HeldReferralView[];
}
export const ReferralReviewParamsSchema = z.object({ id: z.string().min(1).max(64) }).strict();
export const ReferralReviewBodySchema = z.object({ decision: z.enum(['approve', 'reject']) }).strict();
export interface ReferralReviewResponse {
  id: string;
  status: ReferralStatus;
}

export const GROWTH_ERROR_CODES = {
  unknownEvent: 'unknown_event',
  /** The checklist store is not available on this deployment (schema request SR-23-1 not applied). */
  checklistUnavailable: 'feature_disabled',
} as const;
