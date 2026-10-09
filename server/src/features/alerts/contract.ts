// server/src/features/alerts/contract.ts
//
// Job alerts and the reminders runner (ARCHITECTURE.md §8.2; TASK_PLAN.md
// WP-39a). Alerts have no HTTP surface of their own: settings live on
// PATCH /search-profiles/:id (`alertInstantMax`, `alertDigest`, WP-20) and
// in the notification preferences (WP-39b); logged-out alerts are WP-78's
// /api/v1/public/alerts. This contract holds the delivery-channel seam and
// the documented JSON columns.
//
// Honesty: every email number is a real count; never a zero-job email; no
// "you're missing out" sends; promotional rows only under "Tips and reminders".

import { z } from 'zod';

export const DELIVERY_CHANNEL_IDS = ['email', 'in_app', 'web_push', 'wechat_mp'] as const;
export type DeliveryChannelId = (typeof DELIVERY_CHANNEL_IDS)[number] | (string & {});

export const ALERT_KINDS = ['instant', 'digest_daily', 'digest_weekly', 'reminder', 'lifecycle'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** One message handed to a delivery channel (WP-61 web push, WP-73 WeChat). */
export interface DeliveryMessage {
  userId: string;
  brand: 'roboapply' | 'goapply';
  locale: string;
  kind: AlertKind;
  category: string;
  templateKey: string;
  params: Record<string, unknown>;
  /** Deep link into the app. */
  href: string | null;
  /** The SeekerNotification row mirrored in-app, when one exists. */
  notificationId: string | null;
}

export interface DeliveryResult {
  delivered: boolean;
  /** Provider message id, when the channel returns one. */
  providerRef?: string;
  /** Why it was skipped (e.g. 'no_subscription', 'template_unset', 'quiet_hours'). */
  skippedReason?: string;
}

export interface DeliveryChannel {
  id: DeliveryChannelId;
  /** Which brands the channel serves (e.g. web push RoboApply only; WeChat GoApply only). */
  brands: ReadonlyArray<'roboapply' | 'goapply'>;
  /** False when credentials/config are missing; the runner skips the channel. */
  isConfigured(): boolean;
  deliver(message: DeliveryMessage): Promise<DeliveryResult>;
}

/** `RAAnonAlertSubscription.filters` (documented JSON column): FilterSet v1 subset. */
export const AnonAlertFiltersSchema = z
  .object({
    q: z.string().max(200).optional(),
    taxonomyIds: z.array(z.string()).max(3).optional(),
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    locations: z.array(z.object({ label: z.string(), city: z.string().optional(), country: z.string().optional() }).passthrough()).max(5).optional(),
    workModels: z.array(z.enum(['remote', 'hybrid', 'onsite'])).max(3).optional(),
  })
  .strict();

/** Free plan: at most 1 instant alert a day; alerts spaced ≥3 h (WP-39a). */
export const ALERT_POLICY = { minSpacingHours: 3, quietHoursStart: '21:00', quietHoursEnd: '08:00', digestHourLocal: 8 } as const;
