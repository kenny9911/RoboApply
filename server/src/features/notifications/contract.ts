// server/src/features/notifications/contract.ts
//
// Message center, unsubscribe and notification settings (ARCHITECTURE.md
// §3.9, §8; TASK_PLAN.md WP-39b; delivery is WP-39a). Mounts:
//   /api/v1/roboapply/notifications  (seeker)
//   /api/v1/public/email             (one-click unsubscribe, RFC 8058; no login)
//
// Unsubscribe tokens are FND-3's stateless HMAC tokens
// (`platform/email` verifyUnsubscribeToken, `{ expectedBrand }`); links
// already point at `/api/v1/public/email/unsubscribe?token=` (header) and
// `/unsubscribe/<token>` (footer page).
//
// Storage (no schema change):
//   - messages: `SeekerNotification` rows of the user's seeker profile. The
//     stored `category` may use either vocabulary (`job_alert` from the schema
//     comment or the contract's `alert`); `categoryOf()` maps both, and legacy
//     rows without a category by their `type`.
//   - settings: `SeekerProfile.notificationPreferences.center` (JSON, below);
//     "Tips and reminders" is the `tips_reminders` consent record; product
//     news by email is the `marketing_email` consent record.

import { z } from 'zod';

const Id = z.string().min(1).max(64);

export const NOTIFICATION_CATEGORIES = ['alert', 'reminder', 'billing', 'system', 'invitation', 'tips', 'announcement'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const ListNotificationsQuerySchema = z.object({ cursor: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(50).optional() });
export interface NotificationView {
  id: string;
  category: NotificationCategory;
  templateKey: string | null;
  /** ICU params for the client-rendered template. */
  params: Record<string, unknown> | null;
  title: string | null;
  body: string | null;
  href: string | null;
  readAt: string | null;
  createdAt: string;
  /** Invitation rows only: the user's answer, once given. */
  response?: { interested: boolean; at: string } | null;
}
export interface NotificationsResponse {
  items: NotificationView[];
  cursor: string | null;
}
export interface UnreadCountResponse {
  count: number;
}

export const NotificationParamsSchema = z.object({ id: Id });

/** POST /notifications/:id/respond — recruiter invitation reply (flag `invitations`). */
export const RespondInvitationBodySchema = z
  .object({ interested: z.boolean(), form: z.record(z.string(), z.string().max(2000)).optional() })
  .strict();

/** Stored category (either vocabulary) → contract category. */
export const STORED_CATEGORY_MAP: Readonly<Record<string, NotificationCategory>> = {
  alert: 'alert',
  job_alert: 'alert',
  reminder: 'reminder',
  application: 'reminder',
  billing: 'billing',
  system: 'system',
  referral: 'system',
  invitation: 'invitation',
  tips: 'tips',
  announcement: 'announcement',
};

/** Legacy `SeekerNotification.type` (rows written before the clone) → category. */
export const LEGACY_TYPE_CATEGORY: Readonly<Record<string, NotificationCategory>> = {
  interview_scheduled: 'reminder',
  training_due: 'reminder',
  weekly_summary: 'alert',
  cap_warning: 'billing',
  consent_revoked: 'system',
};

/**
 * Legacy types the message center never shows: they described automatic
 * submissions and recruiter activity the product no longer claims (D1, D3).
 */
export const HIDDEN_LEGACY_TYPES = ['auto_apply_failed', 'recruiter_viewed'] as const;

/** The contract category of a stored row (null category → by legacy type → 'system'). */
export function categoryOf(row: { category?: string | null; type?: string | null }): NotificationCategory {
  if (row.category && STORED_CATEGORY_MAP[row.category]) return STORED_CATEGORY_MAP[row.category]!;
  if (row.type && LEGACY_TYPE_CATEGORY[row.type]) return LEGACY_TYPE_CATEGORY[row.type]!;
  if (row.type && STORED_CATEGORY_MAP[row.type]) return STORED_CATEGORY_MAP[row.type]!;
  return 'system';
}

// ── Notification settings ────────────────────────────────────────────────

export const NOTIFICATION_CHANNELS = ['email', 'in_app', 'push', 'wechat'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Categories whose channels the user picks. In-app is always on (the inbox is the source of truth). */
export const CONFIGURABLE_CATEGORIES = ['alert', 'reminder', 'tips', 'invitation'] as const satisfies readonly NotificationCategory[];
/** Account, security and billing messages are transactional: always sent on every available channel. */
export const LOCKED_CATEGORIES = ['billing', 'system'] as const satisfies readonly NotificationCategory[];
/** Announcements are in-app only (WP-61); product news by email is the `marketing_email` consent. */
export const IN_APP_ONLY_CATEGORIES = ['announcement'] as const satisfies readonly NotificationCategory[];

/** Quiet hours for anything non-transactional (PRODUCT_PLAN.md §7.1). */
export const DEFAULT_QUIET_HOURS = { start: '21:00', end: '08:00' } as const;

const HhMm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

/**
 * "Tips and reminders" (PRODUCT §7.3 rows 5, 6, 10 + the former Friday
 * practice nudge): default OFF for EEA/UK/CH/CA visitors and GoApply, ON elsewhere.
 * Stored as the `tips_reminders` consent record.
 */
export const NotificationPreferencesSchema = z
  .object({
    tipsReminders: z.boolean(),
    channels: z.partialRecord(z.enum(NOTIFICATION_CATEGORIES), z.array(z.enum(NOTIFICATION_CHANNELS)).max(4)).optional(),
    quietHours: z.object({ start: HhMm, end: HhMm }).strict().optional(),
  })
  .strict();
/**
 * PATCH body. `tipsRemindersProseVersion` is the consent text version the
 * person saw (`NotificationPreferencesView.tipsRemindersConsent.version`); a
 * stale one is refused with 409 so the record never hashes text that was not shown.
 */
export const PatchNotificationPreferencesBodySchema = NotificationPreferencesSchema.partial()
  .extend({ tipsRemindersProseVersion: z.string().min(1).max(40).optional() })
  .strict();
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;
export type NotificationPreferencesPatch = z.infer<typeof PatchNotificationPreferencesBodySchema>;

/** GET/PATCH /notifications/preferences response: the effective settings plus what the UI needs to explain them. */
export interface NotificationPreferencesView {
  tipsReminders: boolean;
  /** Every category, effective (defaults filled; `in_app` always first). */
  channels: Record<NotificationCategory, NotificationChannel[]>;
  quietHours: { start: string; end: string };
  /** The regional default for "Tips and reminders" (shown next to the toggle). */
  tipsRemindersDefault: boolean;
  /** 'user' once the person chose; 'default' while the regional default applies. */
  tipsRemindersSource: 'user' | 'default';
  /**
   * The exact consent text the "Tips and reminders" switch shows: the record
   * written when it changes hashes this text (brand, version and locale included).
   */
  tipsRemindersConsent: { text: string; locale: 'en' | 'zh'; version: string };
  /** Channels this account can receive on this brand (email needs a real address and the `notify.email` capability). */
  availableChannels: NotificationChannel[];
  /**
   * Why email is missing from `availableChannels` (null when it is there):
   * 'no_address' — the account has no real address; 'not_offered' — the brand does not send email now.
   */
  emailUnavailableReason: 'no_address' | 'not_offered' | null;
  /** Categories shown with channel choices ('alert' only while the `jobs.alerts` capability is on). */
  configurableCategories: NotificationCategory[];
  /** Categories that are always sent. */
  lockedCategories: NotificationCategory[];
  /** Product news by email (`marketing_email` consent); null when never answered. */
  productNewsEmail: boolean | null;
}

/** Countries where "Tips and reminders" starts OFF: EU 27, IS/LI/NO (EEA), UK, Switzerland, Canada. */
export const TIPS_OPT_IN_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'GB', 'CH', 'CA',
]);

/**
 * The regional default for "Tips and reminders" (TASK_PLAN.md §2.2):
 * GoApply → off; EEA/UK/CH/CA → off; unknown country → off (privacy first);
 * elsewhere → on.
 */
export function tipsRemindersDefault(input: { market: 'intl' | 'cn'; country: string | null | undefined }): boolean {
  if (input.market !== 'intl') return false;
  const c = (input.country ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return false;
  return !TIPS_OPT_IN_COUNTRIES.has(c === 'UK' ? 'GB' : c);
}

/** `SeekerProfile.notificationPreferences.center` (documented JSON; legacy keys beside it are kept). */
export interface StoredNotificationCenter {
  v: 1;
  /** Channel choices per configurable category (normalized; `in_app` always present). */
  channels?: Partial<Record<NotificationCategory, NotificationChannel[]>>;
  /**
   * Opt-in channels (push, WeChat) the person turned OFF in Settings, per
   * category: recorded when a saved choice drops a channel that was on. Only
   * this blocks `enableChannelIfDefault` (an accepted WeChat prompt, WP-73);
   * a list that merely never had the channel does not. Cleared when the
   * person turns the channel on again.
   */
  channelsOff?: Partial<Record<NotificationCategory, NotificationChannel[]>>;
  quietHours?: { start: string; end: string };
  /** The country the regional default was resolved for (first seen; keeps the email gate and the settings page in agreement). */
  regionCountry?: string;
  /** Lists left through an unsubscribe link: list → ISO time. */
  unsubscribed?: Partial<Record<string, string>>;
  /** The last few unsubscribe survey answers (the person's own data; deleted with the account). */
  feedback?: Array<{ list: string; reason: string; note?: string; at: string }>;
}

// ── Public unsubscribe (RFC 8058) ────────────────────────────────────────

export const UnsubscribeQuerySchema = z.object({ token: z.string().min(16).max(1024) });
/** RFC 8058 one-click POST carries `List-Unsubscribe=One-Click` as form data; the token is in the query. */
export const UnsubscribeBodySchema = z.object({ 'List-Unsubscribe': z.string().optional() }).passthrough();
export const UNSUBSCRIBE_REASONS = ['too_many', 'not_relevant', 'never_signed_up', 'found_job', 'other'] as const;
export type UnsubscribeReason = (typeof UNSUBSCRIBE_REASONS)[number];
export const UnsubscribeSurveyBodySchema = z
  .object({ token: z.string().min(16).max(1024), reason: z.enum(UNSUBSCRIBE_REASONS), note: z.string().max(1000).optional() })
  .strict();
export interface UnsubscribeResponse {
  /** The list left (`alerts` | `digest` | `reminders` | `tips` | `marketing`). */
  category: string;
  unsubscribed: true;
}
/** GET /api/v1/public/email/unsubscribe?token= (JSON; a browser asking for HTML is sent to /unsubscribe/<token>). */
export interface UnsubscribePreview {
  category: string;
  /** True when email of this list is off right now (worked out from the live settings and consents). */
  alreadyUnsubscribed: boolean;
  /** False for a logged-out alert subscription (no account, no inbox, no Settings). */
  hasAccount: boolean;
}

export const NOTIFICATIONS_ERROR_CODES = {
  tokenInvalid: 'unsubscribe_token_invalid',
  notFound: 'notification_not_found',
  notInvitation: 'notification_not_invitation',
  categoryLocked: 'notification_category_locked',
  categoryUnavailable: 'notification_category_unavailable',
  channelUnavailable: 'notification_channel_unavailable',
} as const;
