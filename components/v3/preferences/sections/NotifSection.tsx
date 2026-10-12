'use client';

// Settings § Notifications — the pre-INT wrapper.
//
// @deprecated /settings#notifications renders `NotificationsSettingsSection`
// (components/features/notifications), registered in
// components/features/settings/sectionComponents.ts (INT-12). The settings
// route no longer imports this file; it stays only because
// components/features/notifications/notifications.test.tsx still renders it.
// Delete it together with that test's import.

import { NotificationsSettings } from '../../../features/notifications';
import type { RAPreferences } from '../../../../lib/api/v2';

export function NotifSection(_props: { p?: RAPreferences; set?: (path: string, value: unknown) => void } = {}) {
  return <NotificationsSettings />;
}
