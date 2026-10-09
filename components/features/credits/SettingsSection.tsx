'use client';

// /settings#billing and /settings#credits — plan, invoices, today's credits
// per bucket with reset times (TASK_PLAN.md WP-21b).
//
// STUB (FND-6b). Owner: WP-21b. Renders nothing. One component, two
// sections: switch on `section`. Until WP-21b takes the sections over, the
// /settings page renders its existing billing content (its renderers win
// over this component).

import type { SettingsSectionProps } from '../settings/sectionComponents';

export function SettingsSection(_props: SettingsSectionProps): null {
  return null;
}

export default SettingsSection;
