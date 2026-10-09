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

// ── Notification settings ────────────────────────────────────────────────

export const NOTIFICATION_CHANNELS = ['email', 'in_app', 'push', 'wechat'] as const;
/**
 * "Tips and reminders" (PRODUCT §7.3 rows 5, 6, 10 + the former Friday
 * practice nudge): default OFF for EEA/UK/CH/CA visitors and GoApply, ON elsewhere.
 * Stored as the `tips_reminders` consent record.
 */
export const NotificationPreferencesSchema = z
  .object({
    tipsReminders: z.boolean(),
    channels: z.record(z.enum(NOTIFICATION_CATEGORIES), z.array(z.enum(NOTIFICATION_CHANNELS))).optional(),
    quietHours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).strict().optional(),
  })
  .strict();
export const PatchNotificationPreferencesBodySchema = NotificationPreferencesSchema.partial().strict();
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

// ── Public unsubscribe (RFC 8058) ────────────────────────────────────────

export const UnsubscribeQuerySchema = z.object({ token: z.string().min(16).max(1024) });
/** RFC 8058 one-click POST carries `List-Unsubscribe=One-Click` as form data; the token is in the query. */
export const UnsubscribeBodySchema = z.object({ 'List-Unsubscribe': z.string().optional() }).passthrough();
export const UNSUBSCRIBE_REASONS = ['too_many', 'not_relevant', 'never_signed_up', 'found_job', 'other'] as const;
export const UnsubscribeSurveyBodySchema = z
  .object({ token: z.string().min(16).max(1024), reason: z.enum(UNSUBSCRIBE_REASONS), note: z.string().max(1000).optional() })
  .strict();
export interface UnsubscribeResponse {
  category: string;
  unsubscribed: true;
}

export const NOTIFICATIONS_ERROR_CODES = {
  tokenInvalid: 'unsubscribe_token_invalid',
  notFound: 'notification_not_found',
} as const;
