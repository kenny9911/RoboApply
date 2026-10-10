// components/features/extension — public surface of the extension web UI (WP-55a).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).

export { InstallPrompt, type InstallPromptProps } from './InstallPrompt';
export { FillWithExtensionButton, type FillWithExtensionButtonProps } from './FillWithExtensionButton';
export { SettingsSection as ExtensionSettingsSection } from './SettingsSection';
export { ExtensionPage } from './ExtensionPage';
export { ExtensionStatusCard, setupStage, type SetupStage } from './ExtensionStatusCard';
export { SensitiveFillConsent } from './SensitiveFillConsent';
export { UninstallSurvey, UninstalledPage } from './UninstallSurvey';
