// V3 nav shell — the frame every authenticated screen renders inside. Built in
// Wave 0; consumed by the (auth) layout. See docs/roboapply/v3/00-design-system
// .md §6 + 03-build-waves.md "0c. Nav shell".

export { Sidebar } from './Sidebar';
export { Topbar } from './Topbar';
export { BrandLogo } from './BrandLogo';
export { OrbCard } from './OrbCard';
export { MobileNav } from './MobileNav';
export { LanguageSwitcher } from './LanguageSwitcher';
export {
  CommandPaletteProvider,
  useCommandPalette,
} from './CommandPalette';
