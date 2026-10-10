// components/features/pwa — public surface of the PWA area (WP-61).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).
//
//   PwaInstallPrompt   "Add <brand> to your home screen", once, after the second session
//   PushOptIn          "Get alerts on this device" (RoboApply; the only permission request)
//   WhatsNew           "What's new": one announcement at most (rendered by the shell's
//                      AnnouncementModal slot, components/features/notifications/AnnouncementModal.tsx)

export { PwaInstallPrompt, PWA_INSTALL_POPUP_KEY } from './InstallPrompt';
export { PushOptIn, PUSH_OPT_IN_CATEGORIES, pushChannelPatch } from './PushOptIn';
export { WhatsNew, announcementPopupKey } from './WhatsNew';
