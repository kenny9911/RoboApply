// components/features/settings — the /settings section registry and frame
// (FND-6a). Cross-area imports go through this file.

export {
  SETTINGS_REGISTRY,
  sectionIdFromHash,
  settingsHref,
  visibleSettingsSections,
  type SettingsSectionEntry,
} from './registry';
export {
  SECTION_COMPONENTS,
  SECTION_EXTRAS,
  sectionExtrasFor,
} from './sectionComponents';
export {
  activeSectionFor,
} from './useSettingsSection';
export { SettingsPage, type SettingsRenderers, type SettingsRouteExtras } from './SettingsPage';
export { SettingsRail } from './SettingsRail';
