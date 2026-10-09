// components/features/settings — the /settings section registry and frame
// (FND-6a). Cross-area imports go through this file.

export {
  SETTINGS_REGISTRY,
  SETTINGS_SECTION_IDS,
  isSettingsSectionVisible,
  sectionIdFromHash,
  settingsHref,
  visibleSettingsSections,
  type SettingsOwnerArea,
  type SettingsSectionEntry,
  type SettingsSectionId,
  type SettingsVisibilityContext,
} from './registry';
export { SECTION_COMPONENTS, type SettingsSectionProps } from './sectionComponents';
export {
  activeSectionFor,
  syncSettingsSectionHash,
  useActiveSettingsSection,
  useVisibleSettingsSections,
} from './useSettingsSection';
export { SettingsPage, type SettingsPageProps, type SettingsRenderers } from './SettingsPage';
export { SettingsRail } from './SettingsRail';
