'use client';

// /settings#notifications — alert frequency, channels, "Tips and reminders"
// and the always-sent notices (TASK_PLAN.md WP-39b). Receives the section id
// (`SettingsSectionProps`), since one area may own more than one section.
// Today the settings page reaches this content through
// components/v3/preferences/sections/NotifSection.tsx; INT wires this
// component into SECTION_COMPONENTS and drops the page's legacy renderer.

import type { SettingsSectionProps } from '../settings/sectionComponents';
import { NotificationsSettings } from './NotificationsSettings';

export function SettingsSection(_props: SettingsSectionProps) {
  return <NotificationsSettings />;
}

export default SettingsSection;
