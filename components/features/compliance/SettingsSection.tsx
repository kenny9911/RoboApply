'use client';

// /settings#privacy and #consents (GoApply) — data export, personal-information requests, consent records (TASK_PLAN.md WP-13).
//
// STUB (FND-6b). Owner: WP-13. Renders nothing. Receives the section id
// (`SettingsSectionProps`), since one area may own more than one section.
// #privacy: Until the owner takes the section over, /settings renders its existing
// content for it (the page's renderers win over this component).
// #consents: Registered in components/features/settings/sectionComponents.ts.

import type { SettingsSectionProps } from '../settings/sectionComponents';

export function SettingsSection(_props: SettingsSectionProps): null {
  return null;
}

export default SettingsSection;
