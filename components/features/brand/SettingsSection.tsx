'use client';

// /settings#appearance — theme and language (TASK_PLAN.md WP-12).
//
// STUB (FND-6b). Owner: WP-12. Renders nothing. Receives the section id
// (`SettingsSectionProps`), since one area may own more than one section.
// Until the owner takes the section over, /settings renders its existing
// content for it (the page's renderers win over this component).

import type { SettingsSectionProps } from '../settings/sectionComponents';

export function SettingsSection(_props: SettingsSectionProps): null {
  return null;
}

export default SettingsSection;
