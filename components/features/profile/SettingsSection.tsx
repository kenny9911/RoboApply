'use client';

// /settings#sensitive — sensitive answers (work authorization, EEO), encrypted (TASK_PLAN.md WP-19).
//
// STUB (FND-6b). Owner: WP-19. Renders nothing. Receives the section id
// (`SettingsSectionProps`), since one area may own more than one section.
// Registered in components/features/settings/sectionComponents.ts.

import type { SettingsSectionProps } from '../settings/sectionComponents';

export function SettingsSection(_props: SettingsSectionProps): null {
  return null;
}

export default SettingsSection;
