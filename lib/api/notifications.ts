// lib/api/notifications.ts — Message center, notification preferences, email unsubscribe.
//
// Thin typed wrappers over the area contract (FND-7; filled by WP-39b).
// The unsubscribe calls are public (no session): the /unsubscribe/<token> page uses them signed out.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/notifications
//   GET    /api/v1/roboapply/notifications/unread-count
//   POST   /api/v1/roboapply/notifications/read-all
//   GET    /api/v1/roboapply/notifications/preferences
//   PATCH  /api/v1/roboapply/notifications/preferences
//   POST   /api/v1/roboapply/notifications/:id/read
//   POST   /api/v1/roboapply/notifications/:id/respond
//   GET    /api/v1/public/email/unsubscribe
//   POST   /api/v1/public/email/unsubscribe
//   POST   /api/v1/public/email/unsubscribe/survey

import { call, type CallOptions, type In, seg, withQuery } from './contracts/wire';
import type * as N from './contracts/notifications';

/** `notifications.list` — GET /api/v1/roboapply/notifications */
export function listNotifications(query?: In<typeof N.ListNotificationsQuerySchema>, opts?: CallOptions): Promise<N.NotificationsResponse> {
  return call<N.NotificationsResponse>('GET', withQuery(`/api/v1/roboapply/notifications`, query), opts);
}

/** `notifications.unreadCount` — GET /api/v1/roboapply/notifications/unread-count */
export function getUnreadCount(opts?: CallOptions): Promise<N.UnreadCountResponse> {
  return call<N.UnreadCountResponse>('GET', `/api/v1/roboapply/notifications/unread-count`, opts);
}

/** `notifications.readAll` — POST /api/v1/roboapply/notifications/read-all */
export function markAllRead(opts?: CallOptions): Promise<{ updated: number }> {
  return call<{ updated: number }>('POST', `/api/v1/roboapply/notifications/read-all`, opts);
}

/** `notifications.getPreferences` — GET /api/v1/roboapply/notifications/preferences */
export function getNotificationPreferences(opts?: CallOptions): Promise<N.NotificationPreferencesView> {
  return call<N.NotificationPreferencesView>('GET', `/api/v1/roboapply/notifications/preferences`, opts);
}

/** `notifications.patchPreferences` — PATCH /api/v1/roboapply/notifications/preferences */
export function patchNotificationPreferences(body: In<typeof N.PatchNotificationPreferencesBodySchema> = {}, opts?: CallOptions): Promise<N.NotificationPreferencesView> {
  return call<N.NotificationPreferencesView>('PATCH', `/api/v1/roboapply/notifications/preferences`, { ...opts, body });
}

/** `notifications.read` — POST /api/v1/roboapply/notifications/:id/read */
export function markRead(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/notifications/${seg(id)}/read`, opts);
}

/** `notifications.respond` — POST /api/v1/roboapply/notifications/:id/respond */
export function respondToInvitation(id: string, body: In<typeof N.RespondInvitationBodySchema>, opts?: CallOptions): Promise<N.NotificationView> {
  return call<N.NotificationView>('POST', `/api/v1/roboapply/notifications/${seg(id)}/respond`, { ...opts, body });
}

/** `email.unsubscribePreview` — GET /api/v1/public/email/unsubscribe */
export function getUnsubscribePreview(query: In<typeof N.UnsubscribeQuerySchema>, opts?: CallOptions): Promise<N.UnsubscribePreview> {
  return call<N.UnsubscribePreview>('GET', withQuery(`/api/v1/public/email/unsubscribe`, query), opts);
}

/** `email.unsubscribe` — POST /api/v1/public/email/unsubscribe */
export function unsubscribeEmail(body: In<typeof N.UnsubscribeBodySchema> = {}, query: In<typeof N.UnsubscribeQuerySchema>, opts?: CallOptions): Promise<N.UnsubscribeResponse> {
  return call<N.UnsubscribeResponse>('POST', withQuery(`/api/v1/public/email/unsubscribe`, query), { ...opts, body });
}

/** `email.unsubscribeSurvey` — POST /api/v1/public/email/unsubscribe/survey */
export function submitUnsubscribeSurvey(body: In<typeof N.UnsubscribeSurveyBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/public/email/unsubscribe/survey`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const notificationsApi = {
  listNotifications,
  getUnreadCount,
  markAllRead,
  getNotificationPreferences,
  patchNotificationPreferences,
  markRead,
  respondToInvitation,
  getUnsubscribePreview,
  unsubscribeEmail,
  submitUnsubscribeSurvey,
};
