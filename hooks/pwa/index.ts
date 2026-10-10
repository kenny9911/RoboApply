// hooks/pwa — PWA install prompt, web push on this device, announcements (WP-61).

export * from './installPrompt';
export { useInstallPrompt, type BeforeInstallPromptEvent, type InstallPromptState } from './useInstallPrompt';
export {
  PUSH_SUBSCRIPTION_ID_KEY,
  PUSH_SW_URL,
  SIGN_OUT_PUSH_TIMEOUT_MS,
  VAPID_QUERY_KEY,
  deviceLabel,
  forgetPushDeviceOnSignOut,
  pushSupported,
  urlBase64ToUint8Array,
  usePushSubscription,
  type PushDevice,
  type PushDeviceStatus,
} from './usePushSubscription';
export {
  announcementKeys,
  useAdminAnnouncements,
  useCreateAnnouncement,
  useDeleteAnnouncement,
  useMarkAnnouncementSeen,
  useNextAnnouncement,
  useUpdateAnnouncement,
  type AdminAnnouncementView,
  type AdminAnnouncementsFilter,
  type AnnouncementView,
  type PatchAnnouncementInput,
  type UpsertAnnouncementInput,
} from './useAnnouncements';
