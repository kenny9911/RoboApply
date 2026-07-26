// The nav shell — the frame every authenticated screen renders inside.
// Consumed by the (auth) layout.
//
// The IA it carries is four destinations (Jobs / Resume / Applications /
// Interview prep) plus an avatar menu holding Settings, Billing and Sign out.
// `DESTINATIONS` is the single list the Sidebar, the MobileNav and the ⌘K
// palette all render, so the mobile bar cannot drift from the rail.
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
