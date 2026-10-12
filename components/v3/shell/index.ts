// The nav shell — the frame every authenticated screen renders inside.
// Consumed by the (auth) layout and HybridShell.
//
// The IA is the per-brand registry in `destinations.ts` (PRODUCT_PLAN.md
// §3.3): one list the Sidebar, the bottom bar, the More sheet and the ⌘K
// palette all render, so they cannot drift apart. The avatar menu holds
// Settings, Billing and Sign out. `DESTINATIONS` is the legacy static shape of
// RoboApply's bottom-bar entries, kept for older importers.
// See docs/roboapply/OVERHAUL_RULINGS.md R1/C11/C14.

export { Sidebar, DESTINATIONS, countAwaitingReply } from './Sidebar';
export type { Destination } from './Sidebar';
export { Topbar } from './Topbar';
export { BrandLogo } from './BrandLogo';
export { MobileNav } from './MobileNav';
export { AvatarMenu } from './AvatarMenu';
export { LanguageSwitcher } from './LanguageSwitcher';
export {
  CommandPaletteProvider,
  useCommandPalette,
} from './CommandPalette';
export {
  cleanUpDeviceOnSignOut,
  clearDraftsOnSignOut,
  forgetPushOnSignOut,
  leaveSignedOut,
  useSessionCleanupRegistration,
} from './signOutCleanup';
