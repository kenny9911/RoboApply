'use client';

// /settings#connections — imported LinkedIn connections and "Delete all
// imported connections" (TASK_PLAN.md WP-54). Registered in
// components/features/settings/sectionComponents.ts; the registry shows the
// section when `hiringContacts` is `on`. Importing needs mode `on`; deleting
// always works, so a user can remove what they gave us whatever the mode.

import { useHiringContactsMode } from '../../../lib/flags';
import type { SettingsSectionProps } from '../settings/sectionComponents';
import { ConnectionsImport } from './ConnectionsImport';

export function SettingsSection(_props: SettingsSectionProps) {
  const mode = useHiringContactsMode();
  return <ConnectionsImport canImport={mode === 'on'} />;
}

export default SettingsSection;
