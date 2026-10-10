// server/src/features/notifications/index.ts — public surface of the message center (FND-5; owner WP-39b).
//
// Other areas import from here only:
//   notificationCenterService.unreadCount(userId)  — `/auth/me.unreadCount` (WP-10)
//   notificationCenterService.rememberRegion(userId, country) — auth (WP-10) stores the edge country for the tips default
//   notificationCenterService.create(input)         — producers (tracker reminders WP-38, alerts WP-39a,
//                                                     kits WP-52, campus WP-58, billing WP-21a); rows may also
//                                                     be written directly (category in either vocabulary)
//   notificationEmailPreferenceGate                 — WP-39a registers it with `setEmailPreferenceGate`
//                                                     (or composes it with its own quiet-hours/frequency checks)
//   tipsRemindersDefault / categoryOf               — pure helpers
//   registerInvitationResponder                     — the recruiter-invitation integration (Later)

import type { EmailPreferenceGate } from '../../platform/email/index.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { NotificationCenterService, type CreateNotificationInput } from './service.js';
import type { NotificationPreferencesView } from './contract.js';

export * from './contract.js';
export { createEmailPublicRouter, createNotificationsRouter } from './routes.js';
export type { NotificationsRouterDeps } from './routes.js';
export { NOTIFICATIONS_WORK_KINDS } from './workers.js';
export {
  NotificationCenterService,
  availableChannels,
  categoryForList,
  configurableCategoriesFor,
  effectiveChannels,
  emailUnavailableReason,
  registerInvitationResponder,
  safeHref,
  tipsConsentProse,
} from './service.js';
export type {
  CapabilityResolver,
  ChannelCapabilities,
  CreateNotificationInput,
  InvitationResponder,
  NotificationServiceDeps,
  NotificationsDb,
} from './service.js';
export { UnsubscribeService } from './unsubscribe.js';

export interface NotificationCenterFacade {
  /** Unread inbox messages for the user on the brand (0 without a seeker profile). */
  unreadCount(userId: string, brand?: ProductBrand): Promise<number>;
  /** Write one inbox row. */
  create(input: CreateNotificationInput): Promise<{ id: string }>;
  /** Is a non-transactional email of this list allowed (preferences + consents)? */
  allowsEmail: NotificationCenterService['allowsEmail'];
  /**
   * Effective settings outside a request (null without a seeker profile): WP-39a checks
   * `tipsReminders` before writing a "Tips and reminders" inbox row, and WP-61/WP-73
   * check `channels[category]` includes 'push' / 'wechat' before delivering.
   */
  preferencesFor(userId: string, brand?: ProductBrand): Promise<NotificationPreferencesView | null>;
  /**
   * Store the request's edge country (`x-vercel-ip-country`) for the regional
   * "Tips and reminders" default the first time it is seen (WP-10 calls it at
   * signup / login / `/auth/me`). A no-op once a country is known. Never throws.
   */
  rememberRegion(userId: string, country: string | null | undefined): Promise<void>;
}

let instance: NotificationCenterService | null = null;
function svc(): NotificationCenterService {
  instance ??= new NotificationCenterService();
  return instance;
}

export const notificationCenterService: NotificationCenterFacade = {
  unreadCount: (userId, brand) => svc().unreadCount(userId, brand ?? getCurrentBrandOrDefault()),
  create: (input) => svc().create(input),
  allowsEmail: (input) => svc().allowsEmail(input),
  preferencesFor: (userId, brand) => svc().preferencesFor(userId, brand ?? getCurrentBrandOrDefault()),
  rememberRegion: async (userId, country) => {
    try {
      await svc().rememberRegion(userId, country);
    } catch {
      // Best effort: the settings page stores it too.
    }
  },
};

/** The email preference gate (alerts, digest, reminders, tips, marketing). Fails closed. */
export const notificationEmailPreferenceGate: EmailPreferenceGate = (input) => svc().emailPreferenceGate()(input);
