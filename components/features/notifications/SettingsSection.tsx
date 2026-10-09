'use client';

// /settings#notifications — alert frequency, "Tips and reminders" and transactional mail (TASK_PLAN.md WP-39b).
//
// STUB (FND-6b). Owner: WP-39b. Renders nothing. Receives the section id
// (`SettingsSectionProps`), since one area may own more than one section.
// Until the owner takes the section over, /settings renders its existing
// content for it (the page's renderers win over this component).

import type { SettingsSectionProps } from '../settings/sectionComponents';

export function SettingsSection(_props: SettingsSectionProps): null {
  return null;
}

export default SettingsSection;
