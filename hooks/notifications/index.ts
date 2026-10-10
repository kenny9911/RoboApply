// hooks/notifications — message center, notification settings and unsubscribe hooks (WP-39b).
// Other areas (the shell's bell, WP-61's push opt-in, WP-73's WeChat settings) import from here.

export { UNREAD_POLL_MS, notificationKeys } from './keys';
export {
  NOTIFICATION_PAGE_SIZE,
  flattenNotifications,
  useMarkAllRead,
  useMarkRead,
  useNotificationList,
  usePageVisible,
  useRespondToInvitation,
  useUnreadCount,
} from './useNotifications';
export type { NotificationView } from './useNotifications';
export {
  useNotificationPreferences,
  usePatchNotificationPreferences,
  useUnsubscribe,
  useUnsubscribePreview,
  useUnsubscribeSurvey,
} from './useNotificationPreferences';
export type { NotificationPreferencesPatch, NotificationPreferencesView } from './useNotificationPreferences';
