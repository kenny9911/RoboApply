// server/src/features/visitor/contract.ts
//
// Visitor surfaces (TASK_PLAN.md WP-78; F-FEED-16, F-ORION-13, F-NOTIF-03,
// F-TOOL-04). Mounts (public):
//   /api/v1/public/feed     — visitor job list (feed/publicRoutes.ts, also
//                             WP-78's): 20 items, no fit, `publicDisplay`
//                             jobs only, 60/min/IP, cached 15 min;
//                             capability `jobs.feed`.
//   /api/v1/public/copilot  — visitor assistant (capability `visitorAssistant`,
//                             default off on both brands); 10/h + 30/day per
//                             IP; page-scoped public tools only; nothing
//                             stored; SSE. GoApply: the body carries the
//                             visitor consent version (VISITOR_CONSENT_VERSION).
//   /api/v1/public/alerts   — logged-out job alerts with double opt-in
//                             (capability `jobs.alerts`); one-click unsubscribe.
//
// Honesty: a visitor never sees a fit score (no profile); every alert email
// is sent only after the address confirmed; nothing the visitor asks the
// assistant is stored; counts in alert emails are real counts.

import { z } from 'zod';
import { AnonAlertFiltersSchema } from '../alerts/contract.js';
import { VisitorTurnBodySchema as CopilotVisitorTurnSchema } from '../copilot/contract.js';
import type { PublicFeedItem } from '../feed/contract.js';

export type { VisitorTurnInput } from '../copilot/contract.js';
export { AnonAlertFiltersSchema };

// ── POST /api/v1/public/copilot ──────────────────────────────────────────

/**
 * GoApply answers a visitor's question with AI only after the visitor ticks
 * the assistant's consent line (there is no account to hold an AI-processing
 * grant, so the tick of this browser session is the consent). The widget
 * sends this version back with every turn; anything else answers 422
 * `consent_required` before a model is called. The text behind the version is
 * `visitor.assistant.consent.*` in the web bundle: change the text, change
 * the version.
 */
export const VISITOR_CONSENT_VERSION = 'visitor-assistant.2026-10-11.v1';

/**
 * POST /api/v1/public/copilot body: the Assistant's visitor turn (text + page
 * context) plus `consent`, the consent version a GoApply visitor ticked.
 * RoboApply sends none and none is needed there.
 */
export const VisitorTurnBodySchema = CopilotVisitorTurnSchema.extend({
  consent: z.string().max(64).optional(),
}).strict();
export type VisitorTurnBody = z.infer<typeof VisitorTurnBodySchema>;
export type AnonAlertFilters = z.infer<typeof AnonAlertFiltersSchema>;

// ── GET /api/v1/public/feed ──────────────────────────────────────────────

/** The visitor list never shows more than this before the signup gate (F-FEED-16). */
export const VISITOR_FEED_LIMIT = 20;
/** In-process cache of one list (per brand × query); the CDN keeps it as long on RoboApply, 60 s on market `cn`. */
export const VISITOR_FEED_CACHE_SEC = 15 * 60;

/** A public feed item plus its public job page (`/job/<id>-<slug>`; a null from an older server is read as `/job/<id>`). */
export type VisitorFeedItem = PublicFeedItem & { path: string | null };
export interface VisitorFeedResponse {
  items: VisitorFeedItem[];
  /** When this list was read (the cache may serve it for up to 15 minutes). */
  asOf: string;
}

// ── POST /api/v1/public/alerts ───────────────────────────────────────────

export const ANON_ALERT_CADENCES = ['daily', 'weekly'] as const;
export type AnonAlertCadence = (typeof ANON_ALERT_CADENCES)[number];

/** No control characters (they would reach the email subject and body). */
const NO_CONTROL = /^[^\p{Cc}]*$/u;
const plainText = (max: number) => z.string().trim().max(max).regex(NO_CONTROL);

/**
 * The filters a visitor may save. Narrower than the stored `AnonAlertFiltersSchema`
 * (which the digest still reads): the endpoint is public and the search text goes
 * into an email sent to whatever address was typed, so every string is short,
 * free of control characters, and no unknown key is accepted or stored.
 * Its output always parses with `AnonAlertFiltersSchema`.
 */
export const VisitorAlertFiltersSchema = z
  .object({
    q: plainText(120).optional(),
    taxonomyIds: z.array(z.string().trim().min(1).max(64).regex(/^[\w.:-]+$/)).max(3).optional(),
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    locations: z
      .array(
        z
          .object({
            label: plainText(80).min(1),
            city: plainText(80).optional(),
            country: z.string().regex(/^[A-Z]{2}$/).optional(),
          })
          .strict(),
      )
      .max(1)
      .optional(),
    workModels: z.array(z.enum(['remote', 'hybrid', 'onsite'])).max(3).optional(),
  })
  .strict();

/** POST /api/v1/public/alerts — creates an unconfirmed subscription and emails a confirm link (double opt-in). */
export const CreateAnonAlertBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    filters: VisitorAlertFiltersSchema,
    frequency: z.enum(ANON_ALERT_CADENCES).default('weekly'),
    locale: z.string().max(8),
    /** The visitor ticked the (unchecked by default) consent line. */
    consent: z.literal(true),
  })
  .strict();
/** Always 202 — no enumeration of existing subscriptions. */
export interface CreateAnonAlertResponse {
  status: 'pending_confirmation';
}

// ── Confirm (double opt-in) ──────────────────────────────────────────────

/**
 * GET /api/v1/public/alerts/confirm?token= — reads the subscription behind a
 * confirm link WITHOUT changing it (mail scanners open links). The page then
 * asks the visitor to press Confirm, which POSTs the same token.
 */
export const AnonAlertTokenQuerySchema = z.object({ token: z.string().min(16).max(512) });
/** POST /api/v1/public/alerts/confirm { token } — confirms; idempotent. */
export const ConfirmAnonAlertBodySchema = z.object({ token: z.string().min(16).max(512) }).strict();

export type AnonAlertState = 'pending' | 'confirmed' | 'unsubscribed';
export interface AnonAlertView {
  state: AnonAlertState;
  cadence: AnonAlertCadence;
  filters: AnonAlertFilters;
  /** The address with most of the local part hidden (`j•••@example.com`). */
  emailMasked: string;
}

// ── Unsubscribe ──────────────────────────────────────────────────────────

/**
 * POST /api/v1/public/alerts/unsubscribe { token } — one click. The token is
 * the signed unsubscribe token every alert email carries
 * (platform/email/unsubscribe.ts, list `alerts`, no account).
 */
export const AnonAlertUnsubscribeBodySchema = z.object({ token: z.string().min(16).max(1024) }).strict();
export interface AnonAlertUnsubscribeResponse {
  unsubscribed: true;
}

// ── Limits and codes ─────────────────────────────────────────────────────

export const VISITOR_LIMITS = {
  copilotPerIpPerHour: 10,
  copilotPerIpPerDay: 30,
  alertSignupsPerIpPerDay: 5,
  /** Confirm emails one address can receive a day (protects someone else's inbox). */
  alertConfirmsPerEmailPerDay: 3,
  /** Live (pending or confirmed) subscriptions per address. */
  alertsPerEmail: 5,
  publicFeedPerIpPerMinute: 60,
} as const;

/** Confirm links stay valid this long; unconfirmed rows are purged after it. */
export const ANON_ALERT_CONFIRM_TTL_HOURS = 72;
/** Unsubscribed rows (and their address) are deleted this long after leaving. */
export const ANON_ALERT_PURGE_UNSUBSCRIBED_DAYS = 30;
/** Jobs listed in one alert email. */
export const ANON_ALERT_JOBS_PER_EMAIL = 10;

export const VISITOR_ERROR_CODES = {
  /** 404 not_found: the confirm link is unknown, expired or for the other brand. */
  alertTokenInvalid: 'alert_token_invalid',
  /** 422 invalid_request: a GoApply visitor turn without the ticked consent version (VISITOR_CONSENT_VERSION). */
  consentRequired: 'consent_required',
} as const;

/** `RAAuthToken.kind` of confirm links. */
export const ANON_ALERT_TOKEN_KIND = 'anon_alert_confirm';
