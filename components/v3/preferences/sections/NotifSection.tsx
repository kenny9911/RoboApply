'use client';

// Settings § Notifications (WP-39b). The settings page still passes the
// legacy preferences draft (`p`, `set`); this section no longer edits it.
// Notification settings save on their own through the notifications API
// (job alerts per saved search, channels, "Tips and reminders"), so they never
// make the page's Save bar appear. The old email/push/SMS matrix and digest
// control wrote preferences no sender read; they are gone.

import { NotificationsSettings } from '../../../features/notifications';
import type { RAPreferences } from '../../../../lib/api/v2';

export function NotifSection(_props: { p?: RAPreferences; set?: (path: string, value: unknown) => void } = {}) {
  return <NotificationsSettings />;
}
